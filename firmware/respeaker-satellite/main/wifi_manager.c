#include "wifi_manager.h"

#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "satellite_config.h"

static const char *TAG = "satellite_wifi";

static EventGroupHandle_t s_wifi_events;
static bool s_wifi_connected = false;
static bool s_wifi_ever_connected = false;
static int s_retry_count = 0;
static esp_event_handler_instance_t s_wifi_any_id_handler;
static esp_event_handler_instance_t s_ip_got_ip_handler;

enum {
  WIFI_CONNECTED_BIT = BIT0,
  WIFI_FAILED_BIT = BIT1,
};

static void wifi_event_handler(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data) {
  (void)arg;
  (void)event_data;

  if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
    esp_wifi_connect();
    return;
  }

  if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
    s_wifi_connected = false;
    s_retry_count++;
    if (s_wifi_ever_connected) {
      ESP_LOGW(TAG, "wifi disconnected after startup, retry=%d", s_retry_count);
      esp_wifi_connect();
      return;
    }
    if (s_retry_count < 5) {
      ESP_LOGW(TAG, "wifi disconnected, retry=%d", s_retry_count);
      esp_wifi_connect();
      return;
    }
    xEventGroupSetBits(s_wifi_events, WIFI_FAILED_BIT);
    return;
  }

  if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
    ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
    s_wifi_connected = true;
    s_wifi_ever_connected = true;
    s_retry_count = 0;
    ESP_LOGI(TAG, "wifi connected, ip=" IPSTR, IP2STR(&event->ip_info.ip));
    xEventGroupSetBits(s_wifi_events, WIFI_CONNECTED_BIT);
  }
}

esp_err_t satellite_wifi_connect(void) {
  if (strlen(SATELLITE_WIFI_SSID) == 0) {
    ESP_LOGW(TAG, "SATELLITE_WIFI_SSID is empty; configure it with idf.py menuconfig");
    return ESP_ERR_INVALID_STATE;
  }

  if (!s_wifi_events) {
    s_wifi_events = xEventGroupCreate();
  }

  esp_netif_t *sta_netif = esp_netif_create_default_wifi_sta();
  if (!sta_netif) {
    ESP_LOGE(TAG, "failed to create default wifi sta netif");
    return ESP_FAIL;
  }

  wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(esp_wifi_init(&cfg));
  ESP_ERROR_CHECK(esp_event_handler_instance_register(
      WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL, &s_wifi_any_id_handler));
  ESP_ERROR_CHECK(esp_event_handler_instance_register(
      IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL, &s_ip_got_ip_handler));

  wifi_config_t wifi_config = {0};
  strlcpy((char *)wifi_config.sta.ssid, SATELLITE_WIFI_SSID, sizeof(wifi_config.sta.ssid));
  strlcpy((char *)wifi_config.sta.password, SATELLITE_WIFI_PASSWORD, sizeof(wifi_config.sta.password));
  wifi_config.sta.threshold.authmode = WIFI_AUTH_OPEN;
  wifi_config.sta.pmf_cfg.capable = true;
  wifi_config.sta.pmf_cfg.required = false;

  ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
  ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
  ESP_ERROR_CHECK(esp_wifi_start());

  EventBits_t bits = xEventGroupWaitBits(
      s_wifi_events,
      WIFI_CONNECTED_BIT | WIFI_FAILED_BIT,
      pdFALSE,
      pdFALSE,
      pdMS_TO_TICKS(15000));

  if (bits & WIFI_CONNECTED_BIT) {
    return ESP_OK;
  }

  ESP_LOGE(TAG, "failed to connect to Wi-Fi");
  return ESP_FAIL;
}

bool satellite_wifi_is_connected(void) { return s_wifi_connected; }
