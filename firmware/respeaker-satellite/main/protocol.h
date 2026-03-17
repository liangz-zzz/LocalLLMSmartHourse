#pragma once

#include <stdbool.h>
#include <stddef.h>

#include "esp_err.h"

esp_err_t satellite_protocol_init(void);
bool satellite_protocol_is_ready(void);
bool satellite_protocol_is_listening(void);
void satellite_protocol_handle_ws_message(const char *payload, size_t len, void *user_ctx);
void satellite_protocol_handle_ws_connection(bool connected, void *user_ctx);
