#include "voice_turn.h"

#include "audio_pipeline.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "protocol.h"
#include "satellite_config.h"
#include "ws_client.h"

static const char *TAG = "satellite_turn";
static bool s_voice_turn_busy = false;

static esp_err_t satellite_voice_turn_uplink_sink(const uint8_t *pcm_bytes, size_t len, uint32_t seq, void *user_ctx) {
  (void)user_ctx;
  return satellite_ws_send_audio_chunk(pcm_bytes, len, seq);
}

bool satellite_voice_turn_is_busy(void) {
  return s_voice_turn_busy;
}

static void satellite_voice_turn_task(void *arg) {
  const char *source = (const char *)arg;
  esp_err_t err = ESP_OK;

  if (!satellite_ws_is_connected() || !satellite_protocol_is_ready()) {
    ESP_LOGW(TAG, "voice server is not ready yet; source=%s", source);
    goto done;
  }

  err = satellite_ws_send_wake();
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "wake send failed: %s", esp_err_to_name(err));
    goto done;
  }

  for (int attempt = 0; attempt < 30; ++attempt) {
    if (satellite_protocol_is_listening()) {
      break;
    }
    vTaskDelay(pdMS_TO_TICKS(100));
  }
  if (!satellite_protocol_is_listening()) {
    ESP_LOGW(TAG, "listening state was not confirmed after wake; source=%s", source);
    goto done;
  }

  err = satellite_ws_send_audio_start();
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "audio_start send failed: %s", esp_err_to_name(err));
    goto done;
  }

  err = satellite_audio_discard_uplink_ms(SATELLITE_UPLINK_LEAD_IN_DISCARD_MS);
  if (err != ESP_OK) {
    ESP_LOGW(TAG, "uplink lead-in discard failed: %s", esp_err_to_name(err));
  }

  err = satellite_audio_capture_stream_ms(SATELLITE_MANUAL_TEST_CAPTURE_MS, satellite_voice_turn_uplink_sink, NULL);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "capture stream failed: %s", esp_err_to_name(err));
  }

  err = satellite_ws_send_audio_end();
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "audio_end send failed: %s", esp_err_to_name(err));
  } else {
    ESP_LOGI(TAG, "voice turn completed from %s, waiting for transcript and TTS", source);
  }

done:
  s_voice_turn_busy = false;
  vTaskDelete(NULL);
}

esp_err_t satellite_voice_turn_start(const char *source) {
  if (s_voice_turn_busy) {
    return ESP_ERR_INVALID_STATE;
  }

  s_voice_turn_busy = true;
  BaseType_t rc = xTaskCreate(satellite_voice_turn_task,
                              "satellite_turn",
                              10240,
                              (void *)(source ? source : "unknown"),
                              4,
                              NULL);
  if (rc != pdPASS) {
    s_voice_turn_busy = false;
    return ESP_FAIL;
  }

  return ESP_OK;
}
