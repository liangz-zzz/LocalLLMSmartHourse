#include "voice_turn.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "audio_pipeline.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "protocol.h"
#include "satellite_config.h"
#include "ws_client.h"

static const char *TAG = "satellite_turn";
static bool s_voice_turn_busy = false;
static const size_t SATELLITE_FOLLOW_UP_PREROLL_FRAMES = 4;

typedef struct {
  const char *source;
  bool send_wake;
  bool wait_for_local_speech;
  uint32_t capture_ms;
} satellite_voice_turn_request_t;

static esp_err_t satellite_voice_turn_uplink_sink(const uint8_t *pcm_bytes, size_t len, uint32_t seq, void *user_ctx) {
  (void)user_ctx;
  return satellite_ws_send_audio_chunk(pcm_bytes, len, seq);
}

bool satellite_voice_turn_is_busy(void) {
  return s_voice_turn_busy;
}

static int32_t satellite_voice_turn_frame_rms(const int16_t *samples, size_t sample_count) {
  if (!samples || sample_count == 0) {
    return 0;
  }

  int64_t energy = 0;
  for (size_t i = 0; i < sample_count; ++i) {
    int32_t sample = samples[i];
    energy += (int64_t)sample * (int64_t)sample;
  }

  uint32_t mean_square = (uint32_t)(energy / (int64_t)sample_count);
  uint32_t lo = 0;
  uint32_t hi = mean_square > 0 ? mean_square : 1;
  while (lo <= hi) {
    uint32_t mid = lo + ((hi - lo) / 2U);
    uint64_t square = (uint64_t)mid * (uint64_t)mid;
    if (square == mean_square) {
      return (int32_t)mid;
    }
    if (square < mean_square) {
      lo = mid + 1U;
    } else {
      if (mid == 0) {
        break;
      }
      hi = mid - 1U;
    }
  }
  return (int32_t)hi;
}

static esp_err_t satellite_voice_turn_send_frames(const int16_t *frames,
                                                  size_t frame_count,
                                                  uint32_t *seq,
                                                  uint32_t *samples_sent,
                                                  uint32_t sample_budget) {
  if (!frames || frame_count == 0 || !seq || !samples_sent) {
    return ESP_ERR_INVALID_ARG;
  }

  for (size_t i = 0; i < frame_count; ++i) {
    if (*samples_sent >= sample_budget) {
      return ESP_OK;
    }
    uint32_t remaining = sample_budget - *samples_sent;
    size_t samples_to_send = remaining < SATELLITE_AUDIO_FRAME_SAMPLES ? remaining : SATELLITE_AUDIO_FRAME_SAMPLES;
    const int16_t *frame = frames + (i * SATELLITE_AUDIO_FRAME_SAMPLES);
    esp_err_t err = satellite_voice_turn_uplink_sink(
        (const uint8_t *)frame,
        samples_to_send * sizeof(int16_t),
        (*seq)++,
        NULL);
    if (err != ESP_OK) {
      return err;
    }
    *samples_sent += (uint32_t)samples_to_send;
  }

  return ESP_OK;
}

static esp_err_t satellite_voice_turn_wait_for_follow_up_speech(int16_t *pre_roll_frames,
                                                                size_t pre_roll_capacity_frames,
                                                                size_t *captured_pre_roll_frames) {
  if (!pre_roll_frames || pre_roll_capacity_frames == 0 || !captured_pre_roll_frames) {
    return ESP_ERR_INVALID_ARG;
  }

  const size_t frame_bytes = SATELLITE_AUDIO_FRAME_SAMPLES * sizeof(int16_t);
  size_t pre_roll_count = 0;
  int64_t deadline_us = esp_timer_get_time() + ((int64_t)SATELLITE_FOLLOW_UP_LISTEN_MS * 1000LL);

  while (esp_timer_get_time() < deadline_us) {
    if (!satellite_ws_is_connected() || !satellite_protocol_is_ready() || !satellite_protocol_is_listening()) {
      return ESP_ERR_INVALID_STATE;
    }

    int16_t frame[SATELLITE_AUDIO_FRAME_SAMPLES];
    esp_err_t err = satellite_audio_read_uplink_frame(frame, SATELLITE_AUDIO_FRAME_SAMPLES, pdMS_TO_TICKS(120));
    if (err == ESP_ERR_TIMEOUT) {
      continue;
    }
    if (err != ESP_OK) {
      return err;
    }

    if (pre_roll_count < pre_roll_capacity_frames) {
      memcpy(pre_roll_frames + (pre_roll_count * SATELLITE_AUDIO_FRAME_SAMPLES), frame, frame_bytes);
      pre_roll_count += 1;
    } else {
      memmove(pre_roll_frames,
              pre_roll_frames + SATELLITE_AUDIO_FRAME_SAMPLES,
              (pre_roll_capacity_frames - 1) * frame_bytes);
      memcpy(pre_roll_frames + ((pre_roll_capacity_frames - 1) * SATELLITE_AUDIO_FRAME_SAMPLES), frame, frame_bytes);
      pre_roll_count = pre_roll_capacity_frames;
    }

    int32_t rms = satellite_voice_turn_frame_rms(frame, SATELLITE_AUDIO_FRAME_SAMPLES);
    if (rms >= SATELLITE_FOLLOW_UP_RMS_THRESHOLD) {
      *captured_pre_roll_frames = pre_roll_count;
      ESP_LOGI(TAG, "follow-up speech detected: rms=%ld frames=%u",
               (long)rms,
               (unsigned int)pre_roll_count);
      return ESP_OK;
    }
  }

  *captured_pre_roll_frames = 0;
  return ESP_ERR_NOT_FOUND;
}

static esp_err_t satellite_voice_turn_stream_follow_up_capture(size_t pre_roll_frames_count,
                                                               const int16_t *pre_roll_frames,
                                                               uint32_t capture_ms) {
  uint32_t seq = 0;
  uint32_t samples_sent = 0;
  uint32_t sample_budget = (SATELLITE_AUDIO_SAMPLE_RATE_HZ * capture_ms) / 1000U;
  if (sample_budget == 0) {
    return ESP_ERR_INVALID_ARG;
  }

  esp_err_t err = satellite_ws_send_audio_start();
  if (err != ESP_OK) {
    return err;
  }

  err = satellite_voice_turn_send_frames(pre_roll_frames, pre_roll_frames_count, &seq, &samples_sent, sample_budget);
  if (err != ESP_OK) {
    return err;
  }

  while (samples_sent < sample_budget) {
    int16_t frame[SATELLITE_AUDIO_FRAME_SAMPLES];
    err = satellite_audio_read_uplink_frame(frame, SATELLITE_AUDIO_FRAME_SAMPLES, pdMS_TO_TICKS(200));
    if (err == ESP_ERR_TIMEOUT) {
      continue;
    }
    if (err != ESP_OK) {
      return err;
    }
    err = satellite_voice_turn_send_frames(frame, 1, &seq, &samples_sent, sample_budget);
    if (err != ESP_OK) {
      return err;
    }
  }

  return ESP_OK;
}

static void satellite_voice_turn_task(void *arg) {
  satellite_voice_turn_request_t *request = (satellite_voice_turn_request_t *)arg;
  const char *source = request && request->source ? request->source : "unknown";
  esp_err_t err = ESP_OK;

  if (!satellite_ws_is_connected() || !satellite_protocol_is_ready()) {
    ESP_LOGW(TAG, "voice server is not ready yet; source=%s", source);
    goto done;
  }

  if (request && request->send_wake) {
    err = satellite_ws_send_wake();
    if (err != ESP_OK) {
      ESP_LOGE(TAG, "wake send failed: %s", esp_err_to_name(err));
      goto done;
    }

    for (int attempt = 0; attempt < 30; ++attempt) {
      if (satellite_protocol_is_listening()) {
        break;
      }
      vTaskDelay(pdMS_TO_TICKS(100));
    }
    if (!satellite_protocol_is_listening()) {
      ESP_LOGW(TAG, "listening state was not confirmed after wake; source=%s", source);
      goto done;
    }

    err = satellite_ws_send_audio_start();
    if (err != ESP_OK) {
      ESP_LOGE(TAG, "audio_start send failed: %s", esp_err_to_name(err));
      goto done;
    }

    err = satellite_audio_discard_uplink_ms(SATELLITE_UPLINK_LEAD_IN_DISCARD_MS);
    if (err != ESP_OK) {
      ESP_LOGW(TAG, "uplink lead-in discard failed: %s", esp_err_to_name(err));
    }

    err = satellite_audio_capture_stream_ms(
        request && request->capture_ms ? request->capture_ms : SATELLITE_MANUAL_TEST_CAPTURE_MS,
        satellite_voice_turn_uplink_sink,
        NULL);
    if (err != ESP_OK) {
      ESP_LOGE(TAG, "capture stream failed: %s", esp_err_to_name(err));
    }
  } else if (request && request->wait_for_local_speech) {
    if (!satellite_protocol_is_listening()) {
      ESP_LOGW(TAG, "follow-up requested without active listening session; source=%s", source);
      goto done;
    }

    if (SATELLITE_FOLLOW_UP_COOLDOWN_MS > 0) {
      vTaskDelay(pdMS_TO_TICKS(SATELLITE_FOLLOW_UP_COOLDOWN_MS));
    }

    int16_t pre_roll_frames[SATELLITE_FOLLOW_UP_PREROLL_FRAMES * SATELLITE_AUDIO_FRAME_SAMPLES];
    size_t pre_roll_count = 0;
    err = satellite_voice_turn_wait_for_follow_up_speech(
        pre_roll_frames,
        SATELLITE_FOLLOW_UP_PREROLL_FRAMES,
        &pre_roll_count);
    if (err == ESP_ERR_NOT_FOUND) {
      ESP_LOGI(TAG, "follow-up listen window expired without speech; source=%s", source);
      err = ESP_OK;
      goto done;
    }
    if (err != ESP_OK) {
      ESP_LOGW(TAG, "follow-up speech wait failed: %s", esp_err_to_name(err));
      goto done;
    }

    err = satellite_voice_turn_stream_follow_up_capture(
        pre_roll_count,
        pre_roll_frames,
        request->capture_ms ? request->capture_ms : SATELLITE_FOLLOW_UP_CAPTURE_MS);
    if (err != ESP_OK) {
      ESP_LOGE(TAG, "follow-up capture stream failed: %s", esp_err_to_name(err));
    }
  } else {
    err = ESP_ERR_INVALID_STATE;
    ESP_LOGW(TAG, "voice turn request had no valid mode; source=%s", source);
    goto done;
  }

  err = satellite_ws_send_audio_end();
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "audio_end send failed: %s", esp_err_to_name(err));
  } else {
    ESP_LOGI(TAG, "voice turn completed from %s, waiting for transcript and TTS", source);
  }

done:
  s_voice_turn_busy = false;
  free(request);
  vTaskDelete(NULL);
}

static esp_err_t satellite_voice_turn_start_internal(const char *source,
                                                     bool send_wake,
                                                     bool wait_for_local_speech,
                                                     uint32_t capture_ms) {
  if (s_voice_turn_busy) {
    return ESP_ERR_INVALID_STATE;
  }

  satellite_voice_turn_request_t *request = calloc(1, sizeof(*request));
  if (!request) {
    return ESP_ERR_NO_MEM;
  }
  request->source = source ? source : "unknown";
  request->send_wake = send_wake;
  request->wait_for_local_speech = wait_for_local_speech;
  request->capture_ms = capture_ms;

  s_voice_turn_busy = true;
  BaseType_t rc = xTaskCreate(satellite_voice_turn_task,
                              "satellite_turn",
                              10240,
                              request,
                              4,
                              NULL);
  if (rc != pdPASS) {
    s_voice_turn_busy = false;
    free(request);
    return ESP_FAIL;
  }

  return ESP_OK;
}

esp_err_t satellite_voice_turn_start(const char *source) {
  return satellite_voice_turn_start_internal(source, true, false, SATELLITE_MANUAL_TEST_CAPTURE_MS);
}

esp_err_t satellite_voice_turn_start_follow_up(const char *source) {
  return satellite_voice_turn_start_internal(source, false, true, SATELLITE_FOLLOW_UP_CAPTURE_MS);
}
