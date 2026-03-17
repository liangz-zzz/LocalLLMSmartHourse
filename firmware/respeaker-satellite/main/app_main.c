#include "audio_pipeline.h"
#include "manual_test.h"
#include "protocol.h"
#include "wake_word.h"
#include "wifi_manager.h"
#include "ws_client.h"

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"
#include "satellite_config.h"

static const char *TAG = "satellite_app";

static void ping_task(void *arg) {
  (void)arg;
  while (true) {
    vTaskDelay(pdMS_TO_TICKS(SATELLITE_PING_INTERVAL_SEC * 1000));
    if (satellite_ws_is_connected()) {
      esp_err_t err = satellite_ws_send_ping();
      if (err == ESP_OK) {
        ESP_LOGI(TAG, "ping sent");
      } else {
        ESP_LOGW(TAG, "ping failed: %s", esp_err_to_name(err));
      }
    }
  }
}

void app_main(void) {
  esp_err_t ret = nvs_flash_init();
  if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    ret = nvs_flash_init();
  }
  ESP_ERROR_CHECK(ret);
  ESP_ERROR_CHECK(esp_netif_init());
  ESP_ERROR_CHECK(esp_event_loop_create_default());

  ESP_LOGI(TAG, "booting respeaker satellite");
  ESP_LOGI(TAG, "offline wake word: %s", satellite_wake_word_phrase());
  ESP_LOGI(TAG, "audio uplink format: %s/%dHz/%dch/%d samples",
           SATELLITE_AUDIO_ENCODING,
           SATELLITE_AUDIO_SAMPLE_RATE_HZ,
           SATELLITE_AUDIO_CHANNELS,
           SATELLITE_AUDIO_FRAME_SAMPLES);

  ESP_ERROR_CHECK(satellite_audio_init());
  ESP_ERROR_CHECK(satellite_protocol_init());
  ESP_ERROR_CHECK(satellite_wake_word_init());
  ESP_ERROR_CHECK(satellite_ws_register_handlers(
      satellite_protocol_handle_ws_message, satellite_protocol_handle_ws_connection, NULL));
  ESP_ERROR_CHECK(satellite_manual_test_start());

  if (satellite_wifi_connect() != ESP_OK) {
    ESP_LOGE(TAG, "wifi connection failed; fill SATELLITE_WIFI_SSID/PASSWORD in menuconfig");
    return;
  }

  if (satellite_ws_start() != ESP_OK) {
    ESP_LOGE(TAG, "ws start failed; fill SATELLITE_WS_URL in menuconfig");
    return;
  }

  xTaskCreate(ping_task, "satellite_ping", 4096, NULL, 4, NULL);
}
