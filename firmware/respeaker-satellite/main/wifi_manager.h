#pragma once

#include <stdbool.h>

#include "esp_err.h"

esp_err_t satellite_wifi_connect(void);
bool satellite_wifi_is_connected(void);
