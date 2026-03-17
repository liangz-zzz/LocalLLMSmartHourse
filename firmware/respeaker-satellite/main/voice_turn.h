#pragma once

#include <stdbool.h>

#include "esp_err.h"

bool satellite_voice_turn_is_busy(void);
esp_err_t satellite_voice_turn_start(const char *source);
