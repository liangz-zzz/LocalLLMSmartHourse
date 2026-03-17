#pragma once

#include "esp_err.h"

esp_err_t satellite_wake_word_init(void);
const char *satellite_wake_word_phrase(void);
