#include "protocol.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "audio_pipeline.h"
#include "cJSON.h"
#include "esp_log.h"
#include "mbedtls/base64.h"
#include "satellite_config.h"
#include "voice_turn.h"

static const char *TAG = "satellite_proto";

typedef struct {
  bool transport_connected;
  bool hello_acked;
  bool listening;
  bool playing_tts;
  int session_idle_timeout_ms;
  int audio_sample_rate_hz;
  int audio_channels;
  int audio_frame_samples;
  char session_id[64];
} satellite_protocol_state_t;

static satellite_protocol_state_t s_state;

static const char *satellite_protocol_safe_text(const char *value) {
  return value && value[0] ? value : "<empty>";
}

static void satellite_protocol_copy_string(char *dst, size_t dst_len, const char *src) {
  if (!dst || dst_len == 0) {
    return;
  }
  if (!src) {
    dst[0] = '\0';
    return;
  }
  size_t copy_len = strlen(src);
  if (copy_len >= dst_len) {
    copy_len = dst_len - 1;
  }
  memcpy(dst, src, copy_len);
  dst[copy_len] = '\0';
}

static const char *satellite_protocol_get_string(cJSON *root, const char *field) {
  cJSON *item = cJSON_GetObjectItemCaseSensitive(root, field);
  if (!cJSON_IsString(item) || !item->valuestring) {
    return NULL;
  }
  return item->valuestring;
}

static int satellite_protocol_get_int(cJSON *root, const char *field, int fallback) {
  cJSON *item = cJSON_GetObjectItemCaseSensitive(root, field);
  if (!cJSON_IsNumber(item)) {
    return fallback;
  }
  return item->valueint;
}

static bool satellite_protocol_get_bool(cJSON *root, const char *field, bool fallback) {
  cJSON *item = cJSON_GetObjectItemCaseSensitive(root, field);
  if (cJSON_IsBool(item)) {
    return cJSON_IsTrue(item);
  }
  return fallback;
}

static void satellite_protocol_reset_session(void) {
  s_state.listening = false;
  s_state.playing_tts = false;
  s_state.session_id[0] = '\0';
}

static esp_err_t satellite_protocol_handle_hello_ack(cJSON *root) {
  cJSON *audio_format = cJSON_GetObjectItemCaseSensitive(root, "audioFormat");
  s_state.hello_acked = true;
  s_state.session_idle_timeout_ms = satellite_protocol_get_int(root, "sessionIdleTimeoutMs", 0);
  s_state.audio_sample_rate_hz = 0;
  s_state.audio_channels = 0;
  s_state.audio_frame_samples = 0;
  if (cJSON_IsObject(audio_format)) {
    s_state.audio_sample_rate_hz = satellite_protocol_get_int(audio_format, "sampleRate", 0);
    s_state.audio_channels = satellite_protocol_get_int(audio_format, "channels", 0);
    s_state.audio_frame_samples = satellite_protocol_get_int(audio_format, "frameSamples", 0);
  }

  ESP_LOGI(TAG,
           "hello_ack: idle_timeout_ms=%d audio=%dHz/%dch/%d samples",
           s_state.session_idle_timeout_ms,
           s_state.audio_sample_rate_hz,
           s_state.audio_channels,
           s_state.audio_frame_samples);
  return ESP_OK;
}

static esp_err_t satellite_protocol_handle_listening(cJSON *root) {
  const char *session_id = satellite_protocol_get_string(root, "sessionId");
  int wake_timeout_ms = satellite_protocol_get_int(root, "wakeTimeoutMs", 0);
  satellite_protocol_copy_string(s_state.session_id, sizeof(s_state.session_id), session_id);
  s_state.listening = true;
  ESP_LOGI(TAG,
           "session listening: session_id=%s wake_timeout_ms=%d",
           satellite_protocol_safe_text(s_state.session_id),
           wake_timeout_ms);
  return ESP_OK;
}

static esp_err_t satellite_protocol_handle_transcript(cJSON *root) {
  const char *text = satellite_protocol_get_string(root, "text");
  bool confirm = satellite_protocol_get_bool(root, "confirm", false);
  bool cancel = satellite_protocol_get_bool(root, "cancel", false);
  ESP_LOGI(TAG,
           "transcript: text=%s confirm=%s cancel=%s",
           satellite_protocol_safe_text(text),
           confirm ? "true" : "false",
           cancel ? "true" : "false");
  return ESP_OK;
}

static esp_err_t satellite_protocol_handle_tts_start(cJSON *root) {
  const char *session_id = satellite_protocol_get_string(root, "sessionId");
  const char *turn_type = satellite_protocol_get_string(root, "turnType");
  const char *text = satellite_protocol_get_string(root, "text");
  int sample_rate_hz = satellite_protocol_get_int(root, "sampleRate", 0);
  int channels = satellite_protocol_get_int(root, "channels", 0);
  int sample_width = satellite_protocol_get_int(root, "sampleWidth", 0);
  int chunk_bytes = satellite_protocol_get_int(root, "chunkBytes", 0);

  satellite_protocol_copy_string(s_state.session_id, sizeof(s_state.session_id), session_id);
  s_state.listening = false;
  s_state.playing_tts = true;
  ESP_LOGI(TAG,
           "tts_start: session_id=%s chunk_bytes=%d",
           satellite_protocol_safe_text(s_state.session_id),
           chunk_bytes);
  return satellite_audio_playback_begin(sample_rate_hz, channels, sample_width, turn_type, text);
}

static esp_err_t satellite_protocol_handle_tts_chunk(cJSON *root) {
  const char *data = satellite_protocol_get_string(root, "data");
  int seq = satellite_protocol_get_int(root, "seq", -1);
  if (!data || !data[0]) {
    ESP_LOGW(TAG, "tts_chunk without data");
    return ESP_ERR_INVALID_ARG;
  }

  size_t data_len = strlen(data);
  size_t pcm_capacity = ((data_len + 3) / 4) * 3;
  unsigned char *pcm = NULL;
  size_t pcm_len = 0;
  int rc;

  pcm = (unsigned char *)malloc(pcm_capacity ? pcm_capacity : 1);
  if (!pcm) {
    return ESP_ERR_NO_MEM;
  }

  rc = mbedtls_base64_decode(pcm, pcm_capacity, &pcm_len, (const unsigned char *)data, data_len);
  if (rc != 0) {
    ESP_LOGW(TAG, "failed to decode tts_chunk base64: rc=%d", rc);
    free(pcm);
    return ESP_FAIL;
  }

  esp_err_t err = satellite_audio_playback_feed(pcm, pcm_len, seq);
  free(pcm);
  return err;
}

static esp_err_t satellite_protocol_handle_tts_end(cJSON *root) {
  const char *turn_type = satellite_protocol_get_string(root, "turnType");
  const char *text = satellite_protocol_get_string(root, "text");
  s_state.playing_tts = false;
  s_state.listening = true;
  ESP_LOGI(TAG, "tts_end: turn=%s text=%s", satellite_protocol_safe_text(turn_type), satellite_protocol_safe_text(text));
  esp_err_t err = satellite_audio_playback_end();
  if (err != ESP_OK) {
    return err;
  }

  if (SATELLITE_FOLLOW_UP_ENABLED &&
      s_state.session_id[0] &&
      turn_type &&
      strcmp(turn_type, "exit") != 0 &&
      strcmp(turn_type, "debug") != 0) {
    err = satellite_voice_turn_start_follow_up("tts_end");
    if (err == ESP_ERR_INVALID_STATE) {
      ESP_LOGD(TAG, "follow-up listen window skipped because voice turn is already busy");
      return ESP_OK;
    }
    if (err != ESP_OK) {
      ESP_LOGW(TAG, "failed to start follow-up listen window: %s", esp_err_to_name(err));
      return err;
    }
    ESP_LOGI(TAG, "follow-up listen window armed for session=%s", satellite_protocol_safe_text(s_state.session_id));
  }

  return ESP_OK;
}

static esp_err_t satellite_protocol_handle_session_closed(cJSON *root) {
  const char *reason = satellite_protocol_get_string(root, "reason");
  ESP_LOGI(TAG, "session closed: reason=%s", satellite_protocol_safe_text(reason));
  satellite_audio_playback_abort();
  satellite_protocol_reset_session();
  return ESP_OK;
}

static esp_err_t satellite_protocol_handle_error(cJSON *root) {
  const char *code = satellite_protocol_get_string(root, "code");
  const char *message = satellite_protocol_get_string(root, "message");
  ESP_LOGW(TAG, "server error: code=%s message=%s", satellite_protocol_safe_text(code), satellite_protocol_safe_text(message));
  if (s_state.playing_tts) {
    satellite_audio_playback_abort();
    s_state.playing_tts = false;
  }
  return ESP_OK;
}

esp_err_t satellite_protocol_init(void) {
  memset(&s_state, 0, sizeof(s_state));
  return ESP_OK;
}

bool satellite_protocol_is_ready(void) { return s_state.transport_connected && s_state.hello_acked; }

bool satellite_protocol_is_listening(void) { return s_state.listening; }

void satellite_protocol_handle_ws_connection(bool connected, void *user_ctx) {
  (void)user_ctx;
  s_state.transport_connected = connected;
  if (connected) {
    s_state.hello_acked = false;
    satellite_protocol_reset_session();
    ESP_LOGI(TAG, "transport connected");
    return;
  }

  ESP_LOGW(TAG, "transport disconnected");
  satellite_audio_playback_abort();
  s_state.hello_acked = false;
  satellite_protocol_reset_session();
}

void satellite_protocol_handle_ws_message(const char *payload, size_t len, void *user_ctx) {
  (void)user_ctx;
  if (!payload || len == 0) {
    return;
  }

  cJSON *root = cJSON_Parse(payload);
  if (!root) {
    ESP_LOGW(TAG, "failed to parse ws message as json");
    return;
  }
  if (!cJSON_IsObject(root)) {
    ESP_LOGW(TAG, "ws message is not an object");
    cJSON_Delete(root);
    return;
  }

  const char *msg_type = satellite_protocol_get_string(root, "type");
  if (!msg_type || !msg_type[0]) {
    ESP_LOGW(TAG, "ws message missing type");
    cJSON_Delete(root);
    return;
  }

  esp_err_t err = ESP_OK;
  if (strcmp(msg_type, "hello_ack") == 0) {
    err = satellite_protocol_handle_hello_ack(root);
  } else if (strcmp(msg_type, "pong") == 0) {
    ESP_LOGD(TAG, "pong received");
  } else if (strcmp(msg_type, "listening") == 0) {
    err = satellite_protocol_handle_listening(root);
  } else if (strcmp(msg_type, "transcript") == 0) {
    err = satellite_protocol_handle_transcript(root);
  } else if (strcmp(msg_type, "tts_start") == 0) {
    err = satellite_protocol_handle_tts_start(root);
  } else if (strcmp(msg_type, "tts_chunk") == 0) {
    err = satellite_protocol_handle_tts_chunk(root);
  } else if (strcmp(msg_type, "tts_end") == 0) {
    err = satellite_protocol_handle_tts_end(root);
  } else if (strcmp(msg_type, "session_closed") == 0) {
    err = satellite_protocol_handle_session_closed(root);
  } else if (strcmp(msg_type, "error") == 0) {
    err = satellite_protocol_handle_error(root);
  } else {
    ESP_LOGW(TAG, "unsupported server message type: %s", msg_type);
  }

  if (err != ESP_OK) {
    ESP_LOGW(TAG, "failed to handle message type=%s: %s", msg_type, esp_err_to_name(err));
  }

  cJSON_Delete(root);
}
