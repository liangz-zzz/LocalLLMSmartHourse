#include "ws_client.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "mbedtls/base64.h"
#include "satellite_config.h"

static const char *TAG = "satellite_ws";
static const int SATELLITE_WS_OPCODE_TEXT = 0x1;
static const size_t SATELLITE_WS_MESSAGE_QUEUE_LEN = 16;
static const uint32_t SATELLITE_WS_WORKER_STACK = 12288;
static const TickType_t SATELLITE_WS_SEND_LOCK_TIMEOUT = pdMS_TO_TICKS(5000);
static const TickType_t SATELLITE_WS_SEND_TIMEOUT = pdMS_TO_TICKS(5000);

static esp_websocket_client_handle_t s_client = NULL;
static bool s_connected = false;
static satellite_ws_message_handler_t s_message_handler = NULL;
static satellite_ws_connection_handler_t s_connection_handler = NULL;
static void *s_handler_ctx = NULL;
static char *s_rx_buffer = NULL;
static size_t s_rx_capacity = 0;
static size_t s_rx_expected_len = 0;
static QueueHandle_t s_message_queue = NULL;
static SemaphoreHandle_t s_send_mutex = NULL;
static SemaphoreHandle_t s_reconnect_mutex = NULL;

typedef struct {
  char *payload;
  size_t len;
} satellite_ws_message_job_t;

static void satellite_ws_reset_rx_buffer(void);
static esp_err_t satellite_ws_send_json(cJSON *root);
static void satellite_ws_clear_message_queue(void);
static void satellite_ws_message_worker(void *arg);
static void satellite_ws_mark_disconnected(const char *reason);

static void satellite_ws_mark_disconnected(const char *reason) {
  bool was_connected = s_connected;
  s_connected = false;
  satellite_ws_reset_rx_buffer();
  satellite_ws_clear_message_queue();
  if (was_connected && s_connection_handler) {
    s_connection_handler(false, s_handler_ctx);
  }
  if (reason && reason[0]) {
    ESP_LOGW(TAG, "transport marked disconnected: %s", reason);
  }
}

static void satellite_ws_reset_rx_buffer(void) {
  free(s_rx_buffer);
  s_rx_buffer = NULL;
  s_rx_capacity = 0;
  s_rx_expected_len = 0;
}

static void satellite_ws_clear_message_queue(void) {
  if (!s_message_queue) {
    return;
  }

  satellite_ws_message_job_t job = {0};
  while (xQueueReceive(s_message_queue, &job, 0) == pdPASS) {
    free(job.payload);
  }
}

static void satellite_ws_dispatch_message(char *payload, size_t len) {
  if (!payload) {
    return;
  }

  if (!s_message_handler) {
    int max_len = (int)(len < 200 ? len : 200);
    ESP_LOGI(TAG, "server message: %.*s", max_len, payload);
    free(payload);
    return;
  }

  if (!s_message_queue) {
    s_message_handler(payload, len, s_handler_ctx);
    free(payload);
    return;
  }

  satellite_ws_message_job_t job = {.payload = payload, .len = len};
  if (xQueueSend(s_message_queue, &job, 0) != pdPASS) {
    ESP_LOGW(TAG, "dropping inbound ws message because the worker queue is full");
    free(payload);
  }
}

static void satellite_ws_message_worker(void *arg) {
  (void)arg;

  satellite_ws_message_job_t job = {0};
  while (true) {
    if (xQueueReceive(s_message_queue, &job, portMAX_DELAY) != pdPASS) {
      continue;
    }
    if (job.payload && s_message_handler) {
      s_message_handler(job.payload, job.len, s_handler_ctx);
    }
    free(job.payload);
  }
}

static esp_err_t satellite_ws_send_simple_message(const char *type) {
  cJSON *root = cJSON_CreateObject();
  if (!root) {
    return ESP_ERR_NO_MEM;
  }
  cJSON_AddStringToObject(root, "type", type);
  esp_err_t err = satellite_ws_send_json(root);
  cJSON_Delete(root);
  return err;
}

static esp_err_t satellite_ws_send_json(cJSON *root) {
  if (!s_client) {
    return ESP_ERR_INVALID_STATE;
  }

  char *payload = cJSON_PrintUnformatted(root);
  if (!payload) {
    return ESP_ERR_NO_MEM;
  }
  if (s_send_mutex && xSemaphoreTake(s_send_mutex, SATELLITE_WS_SEND_LOCK_TIMEOUT) != pdTRUE) {
    cJSON_free(payload);
    return ESP_ERR_TIMEOUT;
  }

  if (!s_connected || !esp_websocket_client_is_connected(s_client)) {
    if (s_send_mutex) {
      xSemaphoreGive(s_send_mutex);
    }
    cJSON_free(payload);
    satellite_ws_mark_disconnected("pre-send connection check failed");
    satellite_ws_reconnect();
    return ESP_ERR_INVALID_STATE;
  }

  int rc = esp_websocket_client_send_text(s_client, payload, strlen(payload), SATELLITE_WS_SEND_TIMEOUT);
  if (s_send_mutex) {
    xSemaphoreGive(s_send_mutex);
  }
  cJSON_free(payload);
  if (rc <= 0) {
    ESP_LOGW(TAG, "websocket send failed: rc=%d", rc);
    satellite_ws_mark_disconnected("send_text returned failure");
    satellite_ws_reconnect();
    return ESP_FAIL;
  }
  return ESP_OK;
}

static esp_err_t satellite_ws_send_hello(void) {
  cJSON *root = cJSON_CreateObject();
  if (!root) {
    return ESP_ERR_NO_MEM;
  }

  cJSON_AddStringToObject(root, "type", "hello");
  cJSON_AddStringToObject(root, "deviceId", SATELLITE_DEVICE_ID);
  cJSON_AddStringToObject(root, "authToken", SATELLITE_AUTH_TOKEN);
  cJSON_AddStringToObject(root, "encoding", SATELLITE_AUDIO_ENCODING);
  cJSON_AddNumberToObject(root, "sampleRate", SATELLITE_AUDIO_SAMPLE_RATE_HZ);
  cJSON_AddNumberToObject(root, "channels", SATELLITE_AUDIO_CHANNELS);

  esp_err_t err = satellite_ws_send_json(root);
  cJSON_Delete(root);
  return err;
}

esp_err_t satellite_ws_register_handlers(satellite_ws_message_handler_t message_handler,
                                         satellite_ws_connection_handler_t connection_handler,
                                         void *user_ctx) {
  s_message_handler = message_handler;
  s_connection_handler = connection_handler;
  s_handler_ctx = user_ctx;

  if (!s_send_mutex) {
    s_send_mutex = xSemaphoreCreateMutex();
    if (!s_send_mutex) {
      return ESP_ERR_NO_MEM;
    }
  }
  if (!s_reconnect_mutex) {
    s_reconnect_mutex = xSemaphoreCreateMutex();
    if (!s_reconnect_mutex) {
      return ESP_ERR_NO_MEM;
    }
  }

  if (message_handler && !s_message_queue) {
    s_message_queue = xQueueCreate(SATELLITE_WS_MESSAGE_QUEUE_LEN, sizeof(satellite_ws_message_job_t));
    if (!s_message_queue) {
      return ESP_ERR_NO_MEM;
    }
    if (xTaskCreate(satellite_ws_message_worker, "satellite_ws_rx", SATELLITE_WS_WORKER_STACK, NULL, 5, NULL) != pdPASS) {
      vQueueDelete(s_message_queue);
      s_message_queue = NULL;
      return ESP_FAIL;
    }
  }
  return ESP_OK;
}

static void websocket_event_handler(void *handler_args,
                                    esp_event_base_t base,
                                    int32_t event_id,
                                    void *event_data) {
  (void)handler_args;
  (void)base;
  esp_websocket_event_data_t *data = (esp_websocket_event_data_t *)event_data;

  switch (event_id) {
    case WEBSOCKET_EVENT_CONNECTED:
      s_connected = true;
      ESP_LOGI(TAG, "connected to ws server");
      if (s_connection_handler) {
        s_connection_handler(true, s_handler_ctx);
      }
      if (satellite_ws_send_hello() != ESP_OK) {
        ESP_LOGE(TAG, "failed to send hello");
      }
      break;
    case WEBSOCKET_EVENT_DISCONNECTED:
      satellite_ws_mark_disconnected("event disconnected");
      ESP_LOGW(TAG, "disconnected from ws server");
      break;
    case WEBSOCKET_EVENT_DATA:
      if (data && data->data_ptr && data->data_len > 0) {
        if (data->op_code != SATELLITE_WS_OPCODE_TEXT) {
          ESP_LOGD(TAG, "ignoring non-text websocket frame: opcode=0x%x len=%d", data->op_code, data->data_len);
          break;
        }
        size_t total_len = data->payload_len > 0 ? (size_t)data->payload_len : (size_t)data->data_len;
        size_t offset = data->payload_offset > 0 ? (size_t)data->payload_offset : 0;
        size_t chunk_len = (size_t)data->data_len;

        if (offset == 0) {
          satellite_ws_reset_rx_buffer();
          s_rx_buffer = (char *)malloc(total_len + 1);
          if (!s_rx_buffer) {
            ESP_LOGE(TAG, "failed to allocate rx buffer: %u bytes", (unsigned int)(total_len + 1));
            break;
          }
          s_rx_capacity = total_len + 1;
          s_rx_expected_len = total_len;
        }

        if (!s_rx_buffer || (offset + chunk_len + 1) > s_rx_capacity) {
          ESP_LOGE(TAG, "invalid websocket frame assembly offset=%u chunk=%u capacity=%u",
                   (unsigned int)offset,
                   (unsigned int)chunk_len,
                   (unsigned int)s_rx_capacity);
          satellite_ws_reset_rx_buffer();
          break;
        }

        memcpy(s_rx_buffer + offset, data->data_ptr, chunk_len);
        if ((offset + chunk_len) >= s_rx_expected_len) {
          s_rx_buffer[s_rx_expected_len] = '\0';
          char *complete_payload = s_rx_buffer;
          size_t complete_len = s_rx_expected_len;
          s_rx_buffer = NULL;
          s_rx_capacity = 0;
          s_rx_expected_len = 0;
          satellite_ws_dispatch_message(complete_payload, complete_len);
        }
      }
      break;
    case WEBSOCKET_EVENT_ERROR:
      ESP_LOGE(TAG, "websocket error");
      break;
    default:
      break;
  }
}

esp_err_t satellite_ws_start(void) {
  if (strlen(SATELLITE_WS_URL) == 0) {
    ESP_LOGW(TAG, "SATELLITE_WS_URL is empty; configure it with idf.py menuconfig");
    return ESP_ERR_INVALID_STATE;
  }

  esp_websocket_client_config_t ws_cfg = {
      .uri = SATELLITE_WS_URL,
      .reconnect_timeout_ms = 5000,
      .network_timeout_ms = 10000,
      .task_stack = 8192,
  };

  s_client = esp_websocket_client_init(&ws_cfg);
  if (!s_client) {
    return ESP_FAIL;
  }

  ESP_ERROR_CHECK(esp_websocket_register_events(s_client, WEBSOCKET_EVENT_ANY, websocket_event_handler, NULL));
  if (esp_websocket_client_start(s_client) != ESP_OK) {
    ESP_LOGE(TAG, "failed to start websocket client");
    return ESP_FAIL;
  }
  return ESP_OK;
}

esp_err_t satellite_ws_reconnect(void) {
  if (!s_client) {
    return ESP_ERR_INVALID_STATE;
  }
  if (s_reconnect_mutex && xSemaphoreTake(s_reconnect_mutex, SATELLITE_WS_SEND_LOCK_TIMEOUT) != pdTRUE) {
    return ESP_ERR_TIMEOUT;
  }

  if (esp_websocket_client_is_connected(s_client)) {
    s_connected = true;
    if (s_reconnect_mutex) {
      xSemaphoreGive(s_reconnect_mutex);
    }
    return ESP_OK;
  }

  satellite_ws_mark_disconnected("reconnect requested");
  ESP_LOGW(TAG, "attempting websocket reconnect");
  esp_err_t stop_err = esp_websocket_client_stop(s_client);
  if (stop_err != ESP_OK) {
    ESP_LOGW(TAG, "websocket stop before reconnect returned: %s", esp_err_to_name(stop_err));
  }
  esp_err_t start_err = esp_websocket_client_start(s_client);
  if (start_err != ESP_OK) {
    ESP_LOGE(TAG, "websocket restart failed: %s", esp_err_to_name(start_err));
  }

  if (s_reconnect_mutex) {
    xSemaphoreGive(s_reconnect_mutex);
  }
  return start_err;
}

esp_err_t satellite_ws_send_ping(void) {
  if (!s_connected || !s_client) {
    return ESP_ERR_INVALID_STATE;
  }

  cJSON *root = cJSON_CreateObject();
  if (!root) {
    return ESP_ERR_NO_MEM;
  }
  cJSON_AddStringToObject(root, "type", "ping");
  esp_err_t err = satellite_ws_send_json(root);
  cJSON_Delete(root);
  return err;
}

esp_err_t satellite_ws_send_wake(void) {
  if (!s_connected || !s_client) {
    return ESP_ERR_INVALID_STATE;
  }
  return satellite_ws_send_simple_message("wake");
}

esp_err_t satellite_ws_send_debug_tts(const char *text) {
  if (!s_connected || !s_client) {
    return ESP_ERR_INVALID_STATE;
  }
  if (!text || !text[0]) {
    return ESP_ERR_INVALID_ARG;
  }

  cJSON *root = cJSON_CreateObject();
  if (!root) {
    return ESP_ERR_NO_MEM;
  }
  cJSON_AddStringToObject(root, "type", "debug_tts");
  cJSON_AddStringToObject(root, "text", text);
  esp_err_t err = satellite_ws_send_json(root);
  cJSON_Delete(root);
  return err;
}

esp_err_t satellite_ws_send_audio_start(void) {
  if (!s_connected || !s_client) {
    return ESP_ERR_INVALID_STATE;
  }
  return satellite_ws_send_simple_message("audio_start");
}

esp_err_t satellite_ws_send_audio_chunk(const uint8_t *pcm_bytes, size_t len, uint32_t seq) {
  if (!s_connected || !s_client) {
    return ESP_ERR_INVALID_STATE;
  }
  if (!pcm_bytes || len == 0) {
    return ESP_ERR_INVALID_ARG;
  }

  size_t encoded_capacity = ((len + 2) / 3) * 4 + 1;
  unsigned char *encoded = (unsigned char *)malloc(encoded_capacity);
  if (!encoded) {
    return ESP_ERR_NO_MEM;
  }

  size_t encoded_len = 0;
  int rc = mbedtls_base64_encode(encoded, encoded_capacity, &encoded_len, pcm_bytes, len);
  if (rc != 0) {
    free(encoded);
    ESP_LOGE(TAG, "failed to encode audio chunk: rc=%d", rc);
    return ESP_FAIL;
  }
  encoded[encoded_len] = '\0';

  cJSON *root = cJSON_CreateObject();
  if (!root) {
    free(encoded);
    return ESP_ERR_NO_MEM;
  }
  cJSON_AddStringToObject(root, "type", "audio_chunk");
  cJSON_AddNumberToObject(root, "seq", (double)seq);
  cJSON_AddStringToObject(root, "data", (const char *)encoded);
  esp_err_t err = satellite_ws_send_json(root);
  cJSON_Delete(root);
  free(encoded);
  return err;
}

esp_err_t satellite_ws_send_audio_end(void) {
  if (!s_connected || !s_client) {
    return ESP_ERR_INVALID_STATE;
  }
  return satellite_ws_send_simple_message("audio_end");
}

bool satellite_ws_is_connected(void) {
  if (!s_client || !s_connected) {
    return false;
  }
  if (!esp_websocket_client_is_connected(s_client)) {
    satellite_ws_mark_disconnected("state check mismatch");
    return false;
  }
  return true;
}
