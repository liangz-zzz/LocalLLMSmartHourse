#include "manual_test.h"

#include <stdbool.h>
#include <stdio.h>

#include "audio_pipeline.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "protocol.h"
#include "satellite_config.h"
#include "voice_turn.h"
#include "ws_client.h"

static const char *TAG = "satellite_test";
static bool s_test_busy = false;
static const char *SATELLITE_MANUAL_TEST_TTS_TEXT = "这是网络语音播报测试。";

static void satellite_manual_test_log_audio_input(void) {
  ESP_LOGI(TAG,
           "audio input: channel=%d gain=%dx",
           satellite_audio_get_uplink_channel_index(),
           satellite_audio_get_uplink_gain());
}

static void satellite_manual_test_log_help(void) {
  ESP_LOGI(TAG,
           "serial test commands: 'p' = local tone, 't' = remote TTS, 'w' = wake + capture %dms, "
           "'0'/'1' = uplink channel, '+'/'-' = gain, 's' = input status, 'h' = help",
           SATELLITE_MANUAL_TEST_CAPTURE_MS);
  satellite_manual_test_log_audio_input();
}

static void satellite_manual_test_tone_task(void *arg) {
  (void)arg;
  esp_err_t err = satellite_audio_play_test_tone(440, 1000);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "tone test failed: %s", esp_err_to_name(err));
  }
  s_test_busy = false;
  vTaskDelete(NULL);
}

static void satellite_manual_test_tts_task(void *arg) {
  (void)arg;
  esp_err_t err = ESP_OK;

  if (!satellite_ws_is_connected() || !satellite_protocol_is_ready()) {
    ESP_LOGW(TAG, "voice server is not ready yet; wait for hello_ack before running 't'");
    goto done;
  }

  err = satellite_ws_send_debug_tts(SATELLITE_MANUAL_TEST_TTS_TEXT);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "debug_tts send failed: %s", esp_err_to_name(err));
  } else {
    ESP_LOGI(TAG, "remote TTS requested: %s", SATELLITE_MANUAL_TEST_TTS_TEXT);
  }

done:
  s_test_busy = false;
  vTaskDelete(NULL);
}

static void satellite_manual_console_task(void *arg) {
  (void)arg;
  satellite_manual_test_log_help();

  while (true) {
    int ch = fgetc(stdin);
    if (ch == EOF) {
      clearerr(stdin);
      vTaskDelay(pdMS_TO_TICKS(100));
      continue;
    }

    if (ch == '\r' || ch == '\n') {
      continue;
    }

    if (ch == 'h' || ch == 'H') {
      satellite_manual_test_log_help();
      continue;
    }

    if (ch == 's' || ch == 'S') {
      satellite_manual_test_log_audio_input();
      continue;
    }

    if (ch == '0' || ch == '1') {
      int channel_index = ch - '0';
      esp_err_t err = satellite_audio_set_uplink_channel_index(channel_index);
      if (err != ESP_OK) {
        ESP_LOGE(TAG, "failed to set uplink channel: %s", esp_err_to_name(err));
      } else {
        satellite_manual_test_log_audio_input();
      }
      continue;
    }

    if (ch == '+' || ch == '=') {
      int next_gain = satellite_audio_get_uplink_gain() + 1;
      esp_err_t err = satellite_audio_set_uplink_gain(next_gain);
      if (err != ESP_OK) {
        ESP_LOGW(TAG, "uplink gain already at max");
      } else {
        satellite_manual_test_log_audio_input();
      }
      continue;
    }

    if (ch == '-') {
      int next_gain = satellite_audio_get_uplink_gain() - 1;
      esp_err_t err = satellite_audio_set_uplink_gain(next_gain);
      if (err != ESP_OK) {
        ESP_LOGW(TAG, "uplink gain already at min");
      } else {
        satellite_manual_test_log_audio_input();
      }
      continue;
    }

    if (ch == 'p' || ch == 'P') {
      if (s_test_busy || satellite_voice_turn_is_busy()) {
        ESP_LOGW(TAG, "manual test already running");
        continue;
      }
      s_test_busy = true;
      if (xTaskCreate(satellite_manual_test_tone_task, "satellite_test_tone", 8192, NULL, 4, NULL) != pdPASS) {
        s_test_busy = false;
        ESP_LOGE(TAG, "failed to start tone task");
      }
      continue;
    }

    if (ch == 't' || ch == 'T') {
      if (s_test_busy || satellite_voice_turn_is_busy()) {
        ESP_LOGW(TAG, "manual test already running");
        continue;
      }
      s_test_busy = true;
      if (xTaskCreate(satellite_manual_test_tts_task, "satellite_test_tts", 8192, NULL, 4, NULL) != pdPASS) {
        s_test_busy = false;
        ESP_LOGE(TAG, "failed to start remote TTS task");
      }
      continue;
    }

    if (ch == 'w' || ch == 'W') {
      if (s_test_busy || satellite_voice_turn_is_busy()) {
        ESP_LOGW(TAG, "manual wake test already running");
        continue;
      }
      esp_err_t err = satellite_voice_turn_start_manual("manual");
      if (err != ESP_OK) {
        ESP_LOGE(TAG, "failed to start manual wake capture task: %s", esp_err_to_name(err));
      }
      continue;
    }

    ESP_LOGI(TAG, "unknown command '%c'", ch);
    satellite_manual_test_log_help();
  }
}

esp_err_t satellite_manual_test_start(void) {
  BaseType_t rc = xTaskCreate(satellite_manual_console_task, "satellite_test", 8192, NULL, 2, NULL);
  return rc == pdPASS ? ESP_OK : ESP_FAIL;
}
