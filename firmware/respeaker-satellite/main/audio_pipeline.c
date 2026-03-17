#include "audio_pipeline.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "driver/i2s.h"
#include "esp_log.h"
#include "freertos/semphr.h"
#include "satellite_config.h"

static const char *TAG = "satellite_audio";

static i2s_port_t s_i2s_port = I2S_NUM_0;
static bool s_audio_ready = false;
static bool s_playback_active = false;
static SemaphoreHandle_t s_uplink_mutex = NULL;
static size_t s_playback_bytes = 0;
static int s_playback_chunks = 0;
static int s_playback_sample_rate_hz = 0;
static int s_playback_channels = 0;
static int s_playback_sample_width_bytes = 0;
static int s_uplink_channel_index = SATELLITE_I2S_UPLINK_CHANNEL_INDEX;
static int s_uplink_gain = SATELLITE_I2S_UPLINK_GAIN;
static const int16_t SATELLITE_AUDIO_SINE_32[32] = {
    0,     6393,  12539, 18204, 23170, 27245, 30273, 32137,
    32767, 32137, 30273, 27245, 23170, 18204, 12539, 6393,
    0,     -6393, -12539, -18204, -23170, -27245, -30273, -32137,
    -32768, -32137, -30273, -27245, -23170, -18204, -12539, -6393,
};

static const char *satellite_audio_safe_text(const char *value) {
  return value && value[0] ? value : "<empty>";
}

static int16_t satellite_audio_clip16(int32_t sample) {
  if (sample > 32767) {
    return 32767;
  }
  if (sample < -32768) {
    return -32768;
  }
  return (int16_t)sample;
}

static int16_t satellite_audio_uplink_sample_from_i2s(int32_t left, int32_t right) {
  int32_t selected = s_uplink_channel_index == 0 ? left : right;
  int32_t sample16 = selected >> 16;
  sample16 *= s_uplink_gain;
  return satellite_audio_clip16(sample16);
}

bool satellite_audio_is_playback_active(void) {
  return s_playback_active;
}

int satellite_audio_get_uplink_channel_index(void) {
  return s_uplink_channel_index;
}

int satellite_audio_get_uplink_gain(void) {
  return s_uplink_gain;
}

esp_err_t satellite_audio_set_uplink_channel_index(int channel_index) {
  if (channel_index < 0 || channel_index >= SATELLITE_I2S_CHANNELS) {
    return ESP_ERR_INVALID_ARG;
  }

  s_uplink_channel_index = channel_index;
  ESP_LOGI(TAG, "uplink channel set: %d", s_uplink_channel_index);
  return ESP_OK;
}

esp_err_t satellite_audio_set_uplink_gain(int gain) {
  if (gain < 1 || gain > 16) {
    return ESP_ERR_INVALID_ARG;
  }

  s_uplink_gain = gain;
  ESP_LOGI(TAG, "uplink gain set: %dx", s_uplink_gain);
  return ESP_OK;
}

static esp_err_t satellite_audio_write_pcm16_mono(const int16_t *samples, size_t sample_count) {
  if (!samples || sample_count == 0) {
    return ESP_OK;
  }

  int32_t out_frames[128 * SATELLITE_I2S_CHANNELS];
  size_t cursor = 0;
  while (cursor < sample_count) {
    size_t batch = sample_count - cursor;
    if (batch > 128) {
      batch = 128;
    }

    size_t out_index = 0;
    for (size_t i = 0; i < batch; ++i) {
      int32_t sample32 = ((int32_t)samples[cursor + i]) << 16;
      out_frames[out_index++] = sample32;
      out_frames[out_index++] = sample32;
    }

    size_t bytes_to_write = out_index * sizeof(int32_t);
    size_t bytes_written = 0;
    esp_err_t err = i2s_write(s_i2s_port, out_frames, bytes_to_write, &bytes_written, portMAX_DELAY);
    if (err != ESP_OK) {
      return err;
    }
    cursor += batch;
  }
  return ESP_OK;
}

static esp_err_t satellite_audio_write_silence_ms(uint32_t duration_ms) {
  if (duration_ms == 0) {
    return ESP_OK;
  }

  int16_t silence[160] = {0};
  uint32_t samples_total = (SATELLITE_AUDIO_SAMPLE_RATE_HZ * duration_ms) / 1000;
  uint32_t generated = 0;
  while (generated < samples_total) {
    size_t batch = samples_total - generated;
    if (batch > (sizeof(silence) / sizeof(silence[0]))) {
      batch = sizeof(silence) / sizeof(silence[0]);
    }
    esp_err_t err = satellite_audio_write_pcm16_mono(silence, batch);
    if (err != ESP_OK) {
      return err;
    }
    generated += batch;
  }
  return ESP_OK;
}

static esp_err_t satellite_audio_play_soft_tone(uint32_t frequency_hz, uint32_t duration_ms, int16_t peak_amplitude) {
  if (!s_audio_ready) {
    return ESP_ERR_INVALID_STATE;
  }
  if (frequency_hz == 0 || duration_ms == 0 || peak_amplitude <= 0) {
    return ESP_ERR_INVALID_ARG;
  }

  int16_t tone[160];
  const uint32_t table_size = sizeof(SATELLITE_AUDIO_SINE_32) / sizeof(SATELLITE_AUDIO_SINE_32[0]);
  const uint32_t phase_scale = 1U << 16;
  const uint32_t phase_step = (uint32_t)(((uint64_t)frequency_hz * table_size * phase_scale) / SATELLITE_AUDIO_SAMPLE_RATE_HZ);
  uint32_t phase = 0;
  uint32_t samples_total = (SATELLITE_AUDIO_SAMPLE_RATE_HZ * duration_ms) / 1000;
  uint32_t attack_samples = SATELLITE_AUDIO_SAMPLE_RATE_HZ / 200;   // 5 ms
  uint32_t release_samples = SATELLITE_AUDIO_SAMPLE_RATE_HZ / 125;  // 8 ms
  if (attack_samples == 0) {
    attack_samples = 1;
  }
  if (release_samples == 0) {
    release_samples = 1;
  }

  uint32_t generated = 0;
  while (generated < samples_total) {
    size_t batch = samples_total - generated;
    if (batch > (sizeof(tone) / sizeof(tone[0]))) {
      batch = sizeof(tone) / sizeof(tone[0]);
    }

    for (size_t i = 0; i < batch; ++i) {
      uint32_t sample_index = generated + (uint32_t)i;
      uint32_t env_per_mille = 1000;
      if (sample_index < attack_samples) {
        env_per_mille = (sample_index * 1000U) / attack_samples;
      } else if (sample_index + release_samples > samples_total) {
        uint32_t tail_index = samples_total - sample_index;
        env_per_mille = (tail_index * 1000U) / release_samples;
      }
      if (env_per_mille > 1000) {
        env_per_mille = 1000;
      }

      uint32_t table_index = (phase >> 16) & (table_size - 1U);
      int32_t base = SATELLITE_AUDIO_SINE_32[table_index];
      int32_t shaped = (base * peak_amplitude) / 32767;
      shaped = (shaped * (int32_t)env_per_mille) / 1000;
      tone[i] = (int16_t)shaped;
      phase += phase_step;
    }

    esp_err_t err = satellite_audio_write_pcm16_mono(tone, batch);
    if (err != ESP_OK) {
      return err;
    }
    generated += batch;
  }

  return ESP_OK;
}

esp_err_t satellite_audio_init(void) {
  i2s_config_t i2s_cfg = {
      .mode = I2S_MODE_SLAVE | I2S_MODE_TX | I2S_MODE_RX,
      .sample_rate = SATELLITE_I2S_SAMPLE_RATE_HZ,
      .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
      .channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT,
      .communication_format = I2S_COMM_FORMAT_STAND_I2S,
      .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
      .dma_buf_count = 8,
      .dma_buf_len = 256,
      .use_apll = false,
      .tx_desc_auto_clear = true,
      .fixed_mclk = 0,
  };
  i2s_pin_config_t pins = {
      .bck_io_num = SATELLITE_I2S_BCLK_GPIO,
      .ws_io_num = SATELLITE_I2S_LRCLK_GPIO,
      .data_out_num = SATELLITE_I2S_DOUT_GPIO,
      .data_in_num = SATELLITE_I2S_DIN_GPIO,
  };

  ESP_LOGI(TAG,
           "init I2S: bclk=%d lrclk=%d dout=%d din=%d mode=slave %dHz %dbit stereo uplink_ch=%d gain=%dx",
           SATELLITE_I2S_BCLK_GPIO,
           SATELLITE_I2S_LRCLK_GPIO,
           SATELLITE_I2S_DOUT_GPIO,
           SATELLITE_I2S_DIN_GPIO,
           SATELLITE_I2S_SAMPLE_RATE_HZ,
           SATELLITE_I2S_BITS_PER_SAMPLE,
           s_uplink_channel_index,
           s_uplink_gain);

  esp_err_t err = i2s_driver_install(s_i2s_port, &i2s_cfg, 0, NULL);
  if (err != ESP_OK) {
    return err;
  }
  err = i2s_set_pin(s_i2s_port, &pins);
  if (err != ESP_OK) {
    i2s_driver_uninstall(s_i2s_port);
    return err;
  }
  err = i2s_zero_dma_buffer(s_i2s_port);
  if (err != ESP_OK) {
    i2s_driver_uninstall(s_i2s_port);
    return err;
  }
  s_uplink_mutex = xSemaphoreCreateMutex();
  if (!s_uplink_mutex) {
    i2s_driver_uninstall(s_i2s_port);
    return ESP_ERR_NO_MEM;
  }

  s_audio_ready = true;
  ESP_LOGI(TAG,
           "audio pipeline ready: uplink=%s/%dHz/%dch/%d samples, local i2s=%dHz/%dch/%dbit",
           SATELLITE_AUDIO_ENCODING,
           SATELLITE_AUDIO_SAMPLE_RATE_HZ,
           SATELLITE_AUDIO_CHANNELS,
           SATELLITE_AUDIO_FRAME_SAMPLES,
           SATELLITE_I2S_SAMPLE_RATE_HZ,
           SATELLITE_I2S_CHANNELS,
           SATELLITE_I2S_BITS_PER_SAMPLE);
  return ESP_OK;
}

esp_err_t satellite_audio_play_test_tone(uint32_t frequency_hz, uint32_t duration_ms) {
  if (!s_audio_ready) {
    return ESP_ERR_INVALID_STATE;
  }
  if (frequency_hz == 0 || duration_ms == 0) {
    return ESP_ERR_INVALID_ARG;
  }

  int16_t tone[160];
  uint32_t samples_total = (SATELLITE_AUDIO_SAMPLE_RATE_HZ * duration_ms) / 1000;
  uint32_t half_period = SATELLITE_AUDIO_SAMPLE_RATE_HZ / (frequency_hz * 2);
  if (half_period == 0) {
    half_period = 1;
  }

  ESP_LOGI(TAG, "playing local tone: %uHz for %ums", (unsigned int)frequency_hz, (unsigned int)duration_ms);

  uint32_t generated = 0;
  while (generated < samples_total) {
    size_t batch = samples_total - generated;
    if (batch > (sizeof(tone) / sizeof(tone[0]))) {
      batch = sizeof(tone) / sizeof(tone[0]);
    }
    for (size_t i = 0; i < batch; ++i) {
      uint32_t index = generated + (uint32_t)i;
      uint32_t phase = (index / half_period) & 0x1U;
      tone[i] = phase == 0 ? 12000 : -12000;
    }
    esp_err_t err = satellite_audio_write_pcm16_mono(tone, batch);
    if (err != ESP_OK) {
      return err;
    }
    generated += batch;
  }
  return ESP_OK;
}

esp_err_t satellite_audio_play_wake_prompt(void) {
  if (!s_audio_ready) {
    return ESP_ERR_INVALID_STATE;
  }

  s_playback_active = true;
  esp_err_t err = satellite_audio_play_soft_tone(SATELLITE_WAKE_PROMPT_TONE_1_HZ, SATELLITE_WAKE_PROMPT_TONE_MS, 9000);
  if (err == ESP_OK) {
    err = satellite_audio_write_silence_ms(SATELLITE_WAKE_PROMPT_GAP_MS);
  }
  if (err == ESP_OK) {
    err = satellite_audio_play_soft_tone(SATELLITE_WAKE_PROMPT_TONE_2_HZ, SATELLITE_WAKE_PROMPT_TONE_MS, 8000);
  }
  s_playback_active = false;
  return err;
}

esp_err_t satellite_audio_read_uplink_frame(int16_t *samples, size_t sample_count, TickType_t timeout_ticks) {
  if (!s_audio_ready) {
    return ESP_ERR_INVALID_STATE;
  }
  if (!samples || sample_count == 0) {
    return ESP_ERR_INVALID_ARG;
  }
  if (!s_uplink_mutex) {
    return ESP_ERR_INVALID_STATE;
  }
  if (xSemaphoreTake(s_uplink_mutex, timeout_ticks) != pdTRUE) {
    return ESP_ERR_TIMEOUT;
  }

  uint8_t raw_frames[4096];
  size_t produced = 0;
  esp_err_t err = ESP_OK;

  while (produced < sample_count) {
    size_t bytes_wanted = (sample_count - produced) * sizeof(int32_t) * SATELLITE_I2S_CHANNELS;
    if (bytes_wanted > sizeof(raw_frames)) {
      bytes_wanted = sizeof(raw_frames);
    }

    size_t bytes_read = 0;
    err = i2s_read(s_i2s_port, raw_frames, bytes_wanted, &bytes_read, timeout_ticks);
    if (err != ESP_OK) {
      break;
    }
    if (bytes_read == 0) {
      err = ESP_ERR_TIMEOUT;
      break;
    }

    size_t frame_count = bytes_read / (sizeof(int32_t) * SATELLITE_I2S_CHANNELS);
    int32_t *samples32 = (int32_t *)raw_frames;
    for (size_t frame = 0; frame < frame_count && produced < sample_count; ++frame) {
      int32_t left = samples32[frame * 2];
      int32_t right = samples32[frame * 2 + 1];
      samples[produced++] = satellite_audio_uplink_sample_from_i2s(left, right);
    }
  }

  xSemaphoreGive(s_uplink_mutex);
  return err;
}

esp_err_t satellite_audio_discard_uplink_ms(uint32_t duration_ms) {
  if (!s_audio_ready) {
    return ESP_ERR_INVALID_STATE;
  }
  if (duration_ms == 0) {
    return ESP_OK;
  }
  if (!s_uplink_mutex) {
    return ESP_ERR_INVALID_STATE;
  }
  if (xSemaphoreTake(s_uplink_mutex, pdMS_TO_TICKS(1000)) != pdTRUE) {
    return ESP_ERR_TIMEOUT;
  }

  uint8_t raw_frames[4096];
  uint32_t frames_budget = (SATELLITE_I2S_SAMPLE_RATE_HZ * duration_ms) / 1000;
  uint32_t frames_discarded = 0;

  while (frames_discarded < frames_budget) {
    size_t bytes_wanted = sizeof(raw_frames);
    size_t frames_remaining = frames_budget - frames_discarded;
    size_t remaining_bytes = frames_remaining * sizeof(int32_t) * SATELLITE_I2S_CHANNELS;
    if (remaining_bytes < bytes_wanted) {
      bytes_wanted = remaining_bytes;
    }

    size_t bytes_read = 0;
    esp_err_t err = i2s_read(s_i2s_port, raw_frames, bytes_wanted, &bytes_read, pdMS_TO_TICKS(200));
    if (err != ESP_OK) {
      xSemaphoreGive(s_uplink_mutex);
      return err;
    }
    if (bytes_read == 0) {
      continue;
    }
    frames_discarded += bytes_read / (sizeof(int32_t) * SATELLITE_I2S_CHANNELS);
  }

  xSemaphoreGive(s_uplink_mutex);
  ESP_LOGI(TAG, "discarded uplink lead-in: %ums", (unsigned int)duration_ms);
  return ESP_OK;
}

esp_err_t satellite_audio_capture_stream_ms(uint32_t duration_ms,
                                            satellite_audio_uplink_sink_t sink,
                                            void *user_ctx) {
  if (!s_audio_ready) {
    return ESP_ERR_INVALID_STATE;
  }
  if (!sink || duration_ms == 0) {
    return ESP_ERR_INVALID_ARG;
  }

  uint8_t raw_frames[4096];
  int16_t uplink_frame[SATELLITE_AUDIO_FRAME_SAMPLES];
  size_t uplink_count = 0;
  uint32_t uplink_seq = 0;
  uint32_t frames_budget = (SATELLITE_I2S_SAMPLE_RATE_HZ * duration_ms) / 1000;
  uint32_t frames_processed = 0;

  if (!s_uplink_mutex) {
    return ESP_ERR_INVALID_STATE;
  }
  if (xSemaphoreTake(s_uplink_mutex, pdMS_TO_TICKS(1000)) != pdTRUE) {
    return ESP_ERR_TIMEOUT;
  }

  ESP_LOGI(TAG, "capture start: duration_ms=%u", (unsigned int)duration_ms);

  while (frames_processed < frames_budget) {
    size_t bytes_read = 0;
    esp_err_t err = i2s_read(s_i2s_port, raw_frames, sizeof(raw_frames), &bytes_read, pdMS_TO_TICKS(200));
    if (err != ESP_OK) {
      xSemaphoreGive(s_uplink_mutex);
      return err;
    }
    if (bytes_read == 0) {
      continue;
    }

    size_t frame_count = bytes_read / (sizeof(int32_t) * SATELLITE_I2S_CHANNELS);
    int32_t *samples32 = (int32_t *)raw_frames;
    for (size_t frame = 0; frame < frame_count && frames_processed < frames_budget; ++frame, ++frames_processed) {
      int32_t left = samples32[frame * 2];
      int32_t right = samples32[frame * 2 + 1];
      uplink_frame[uplink_count++] = satellite_audio_uplink_sample_from_i2s(left, right);
      if (uplink_count == SATELLITE_AUDIO_FRAME_SAMPLES) {
        err = sink((const uint8_t *)uplink_frame, sizeof(uplink_frame), uplink_seq++, user_ctx);
        if (err != ESP_OK) {
          xSemaphoreGive(s_uplink_mutex);
          return err;
        }
        uplink_count = 0;
      }
    }
  }

  if (uplink_count > 0) {
    esp_err_t err = sink((const uint8_t *)uplink_frame, uplink_count * sizeof(int16_t), uplink_seq++, user_ctx);
    if (err != ESP_OK) {
      xSemaphoreGive(s_uplink_mutex);
      return err;
    }
  }

  xSemaphoreGive(s_uplink_mutex);
  ESP_LOGI(TAG, "capture end: frames=%u chunks=%u", (unsigned int)frames_processed, (unsigned int)uplink_seq);
  return ESP_OK;
}

esp_err_t satellite_audio_playback_begin(int sample_rate_hz,
                                         int channels,
                                         int sample_width_bytes,
                                         const char *turn_type,
                                         const char *text) {
  if (!s_audio_ready) {
    return ESP_ERR_INVALID_STATE;
  }

  s_playback_active = true;
  s_playback_bytes = 0;
  s_playback_chunks = 0;
  s_playback_sample_rate_hz = sample_rate_hz;
  s_playback_channels = channels;
  s_playback_sample_width_bytes = sample_width_bytes;

  ESP_LOGI(TAG,
           "playback start: turn=%s text=%s format=%dHz/%dch/%dB",
           satellite_audio_safe_text(turn_type),
           satellite_audio_safe_text(text),
           sample_rate_hz,
           channels,
           sample_width_bytes);

  if (sample_rate_hz != SATELLITE_AUDIO_SAMPLE_RATE_HZ || channels != SATELLITE_AUDIO_CHANNELS || sample_width_bytes != 2) {
    ESP_LOGW(TAG, "downlink format differs from current resampler expectation (%dHz/%dch/%dB)",
             SATELLITE_AUDIO_SAMPLE_RATE_HZ,
             SATELLITE_AUDIO_CHANNELS,
             2);
  }
  return ESP_OK;
}

esp_err_t satellite_audio_playback_feed(const uint8_t *pcm_bytes, size_t len, int seq) {
  if (!s_playback_active) {
    ESP_LOGW(TAG, "dropping playback chunk before tts_start");
    return ESP_ERR_INVALID_STATE;
  }
  if (!pcm_bytes || len == 0) {
    return ESP_ERR_INVALID_ARG;
  }

  s_playback_bytes += len;
  s_playback_chunks += 1;
  if (s_playback_chunks <= 2 || (s_playback_chunks % 10) == 0) {
    ESP_LOGI(TAG, "playback chunk: seq=%d bytes=%u total_bytes=%u",
             seq,
             (unsigned int)len,
             (unsigned int)s_playback_bytes);
  }

  return satellite_audio_write_pcm16_mono((const int16_t *)pcm_bytes, len / sizeof(int16_t));
}

esp_err_t satellite_audio_playback_end(void) {
  if (!s_playback_active) {
    return ESP_OK;
  }

  ESP_LOGI(TAG,
           "playback end: chunks=%d bytes=%u format=%dHz/%dch/%dB",
           s_playback_chunks,
           (unsigned int)s_playback_bytes,
           s_playback_sample_rate_hz,
           s_playback_channels,
           s_playback_sample_width_bytes);
  s_playback_active = false;
  s_playback_bytes = 0;
  s_playback_chunks = 0;
  s_playback_sample_rate_hz = 0;
  s_playback_channels = 0;
  s_playback_sample_width_bytes = 0;
  return ESP_OK;
}

esp_err_t satellite_audio_playback_abort(void) {
  if (!s_playback_active) {
    return ESP_OK;
  }

  ESP_LOGW(TAG, "playback aborted");
  s_playback_active = false;
  s_playback_bytes = 0;
  s_playback_chunks = 0;
  s_playback_sample_rate_hz = 0;
  s_playback_channels = 0;
  s_playback_sample_width_bytes = 0;
  return ESP_OK;
}
