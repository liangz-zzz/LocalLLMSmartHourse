#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "freertos/FreeRTOS.h"

typedef esp_err_t (*satellite_audio_uplink_sink_t)(const uint8_t *pcm_bytes, size_t len, uint32_t seq, void *user_ctx);

esp_err_t satellite_audio_init(void);
esp_err_t satellite_audio_play_test_tone(uint32_t frequency_hz, uint32_t duration_ms);
esp_err_t satellite_audio_play_wake_prompt(void);
bool satellite_audio_is_playback_active(void);
int satellite_audio_get_uplink_channel_index(void);
int satellite_audio_get_uplink_gain(void);
esp_err_t satellite_audio_set_uplink_channel_index(int channel_index);
esp_err_t satellite_audio_set_uplink_gain(int gain);
esp_err_t satellite_audio_read_uplink_frame(int16_t *samples, size_t sample_count, TickType_t timeout_ticks);
esp_err_t satellite_audio_capture_stream_ms(uint32_t duration_ms,
                                            satellite_audio_uplink_sink_t sink,
                                            void *user_ctx);
esp_err_t satellite_audio_playback_begin(int sample_rate_hz,
                                         int channels,
                                         int sample_width_bytes,
                                         const char *turn_type,
                                         const char *text);
esp_err_t satellite_audio_playback_feed(const uint8_t *pcm_bytes, size_t len, int seq);
esp_err_t satellite_audio_playback_end(void);
esp_err_t satellite_audio_playback_abort(void);
