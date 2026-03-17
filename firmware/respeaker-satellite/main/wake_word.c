#include "wake_word.h"

#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

#include "audio_pipeline.h"
#include "esp_log.h"
#include "esp_wn_iface.h"
#include "esp_wn_models.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "model_path.h"
#include "satellite_config.h"
#include "voice_turn.h"
#include "ws_client.h"
#include "protocol.h"

static const char *TAG = "satellite_wake";
static const char *SATELLITE_WAKENET_MODEL_NAME = "wn9_xiaoyaxiaoya_tts2";
static const char *SATELLITE_WAKENET_ACTIVE_PHRASE = "小鸭小鸭";

typedef struct {
  srmodel_list_t *models;
  const esp_wn_iface_t *wakenet;
  model_iface_data_t *model_data;
  int16_t *samples;
  size_t chunk_size;
  int sample_rate_hz;
} satellite_wake_word_ctx_t;

static satellite_wake_word_ctx_t s_ctx = {0};

static esp_err_t satellite_wake_word_reset_model(void) {
  if (!s_ctx.wakenet) {
    return ESP_ERR_INVALID_STATE;
  }

  if (s_ctx.model_data) {
    s_ctx.wakenet->destroy(s_ctx.model_data);
    s_ctx.model_data = NULL;
  }

  s_ctx.model_data = s_ctx.wakenet->create(SATELLITE_WAKENET_MODEL_NAME, DET_MODE_95);
  if (!s_ctx.model_data) {
    return ESP_FAIL;
  }

  return ESP_OK;
}

static void satellite_wake_word_task(void *arg) {
  (void)arg;
  bool suspended = false;

  while (true) {
    if (!satellite_ws_is_connected() ||
        !satellite_protocol_is_ready() ||
        satellite_audio_is_playback_active() ||
        satellite_voice_turn_is_busy()) {
      if (!suspended) {
        ESP_LOGI(TAG, "wake engine idle while audio session or playback is active");
        suspended = true;
      }
      vTaskDelay(pdMS_TO_TICKS(100));
      continue;
    }

    if (suspended) {
      ESP_LOGI(TAG, "wake engine listening for %s", SATELLITE_WAKENET_ACTIVE_PHRASE);
      suspended = false;
    }

    esp_err_t err = satellite_audio_read_uplink_frame(s_ctx.samples, s_ctx.chunk_size, pdMS_TO_TICKS(200));
    if (err == ESP_ERR_TIMEOUT) {
      continue;
    }
    if (err != ESP_OK) {
      ESP_LOGW(TAG, "wake audio read failed: %s", esp_err_to_name(err));
      vTaskDelay(pdMS_TO_TICKS(100));
      continue;
    }

    wakenet_state_t result = s_ctx.wakenet->detect(s_ctx.model_data, s_ctx.samples);
    if (result == WAKENET_DETECTED) {
      ESP_LOGI(TAG, "wake word detected: %s", SATELLITE_WAKENET_ACTIVE_PHRASE);
      err = satellite_wake_word_reset_model();
      if (err != ESP_OK) {
        ESP_LOGE(TAG, "wake model reset failed: %s", esp_err_to_name(err));
        vTaskDelay(pdMS_TO_TICKS(500));
        continue;
      }
      err = satellite_audio_play_wake_prompt();
      if (err != ESP_OK) {
        ESP_LOGW(TAG, "wake prompt playback failed: %s", esp_err_to_name(err));
      }
      err = satellite_voice_turn_start("wake_word");
      if (err != ESP_OK) {
        ESP_LOGW(TAG, "failed to start wake voice turn: %s", esp_err_to_name(err));
      }
      vTaskDelay(pdMS_TO_TICKS(300));
    }
  }
}

esp_err_t satellite_wake_word_init(void) {
  if (SATELLITE_WAKE_WORD[0] && strcmp(SATELLITE_WAKE_WORD, SATELLITE_WAKENET_ACTIVE_PHRASE) != 0) {
    ESP_LOGW(TAG,
             "configured wake phrase '%s' is ignored in this firmware build; active model phrase is '%s'",
             SATELLITE_WAKE_WORD,
             SATELLITE_WAKENET_ACTIVE_PHRASE);
  }

  s_ctx.models = esp_srmodel_init("model");
  if (!s_ctx.models) {
    ESP_LOGE(TAG, "failed to load speech models from model partition");
    return ESP_FAIL;
  }
  if (esp_srmodel_exists(s_ctx.models, (char *)SATELLITE_WAKENET_MODEL_NAME) < 0) {
    ESP_LOGE(TAG, "wake model not found in model partition: %s", SATELLITE_WAKENET_MODEL_NAME);
    return ESP_ERR_NOT_FOUND;
  }

  s_ctx.wakenet = esp_wn_handle_from_name(SATELLITE_WAKENET_MODEL_NAME);
  if (!s_ctx.wakenet) {
    ESP_LOGE(TAG, "failed to get wake model handle: %s", SATELLITE_WAKENET_MODEL_NAME);
    return ESP_FAIL;
  }

  s_ctx.model_data = s_ctx.wakenet->create(SATELLITE_WAKENET_MODEL_NAME, DET_MODE_95);
  if (!s_ctx.model_data) {
    ESP_LOGE(TAG, "failed to create wake model");
    return ESP_FAIL;
  }

  s_ctx.chunk_size = (size_t)s_ctx.wakenet->get_samp_chunksize(s_ctx.model_data);
  s_ctx.sample_rate_hz = s_ctx.wakenet->get_samp_rate(s_ctx.model_data);
  s_ctx.samples = calloc(s_ctx.chunk_size, sizeof(int16_t));
  if (!s_ctx.samples) {
    ESP_LOGE(TAG, "failed to allocate wake buffer");
    return ESP_ERR_NO_MEM;
  }

  ESP_LOGI(TAG,
           "wake engine ready: phrase=%s model=%s chunk=%u sample_rate=%dHz",
           SATELLITE_WAKENET_ACTIVE_PHRASE,
           SATELLITE_WAKENET_MODEL_NAME,
           (unsigned int)s_ctx.chunk_size,
           s_ctx.sample_rate_hz);

  BaseType_t rc = xTaskCreate(satellite_wake_word_task, "satellite_wake", 12288, NULL, 4, NULL);
  if (rc != pdPASS) {
    ESP_LOGE(TAG, "failed to start wake task");
    return ESP_FAIL;
  }

  return ESP_OK;
}

const char *satellite_wake_word_phrase(void) { return SATELLITE_WAKENET_ACTIVE_PHRASE; }
