#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

typedef void (*satellite_ws_message_handler_t)(const char *payload, size_t len, void *user_ctx);
typedef void (*satellite_ws_connection_handler_t)(bool connected, void *user_ctx);

esp_err_t satellite_ws_register_handlers(satellite_ws_message_handler_t message_handler,
                                         satellite_ws_connection_handler_t connection_handler,
                                         void *user_ctx);
esp_err_t satellite_ws_start(void);
esp_err_t satellite_ws_send_ping(void);
esp_err_t satellite_ws_send_wake(void);
esp_err_t satellite_ws_send_debug_tts(const char *text);
esp_err_t satellite_ws_send_audio_start(void);
esp_err_t satellite_ws_send_audio_chunk(const uint8_t *pcm_bytes, size_t len, uint32_t seq);
esp_err_t satellite_ws_send_audio_end(void);
bool satellite_ws_is_connected(void);
