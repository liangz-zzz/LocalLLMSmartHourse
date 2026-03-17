# 统一设备模型（含位置语义）

目标：跨协议/厂商表示设备，供 API、前端、LLM 共用。重点是可操作性（capabilities）、状态（traits），以及用于 LLM/人理解的位置信息（placement/semantics）。

## 字段总览
- `id` (string): 稳定唯一 ID（UUID 或 slug）
- `name` (string): 展示名称
- `placement` (object): 位置/安装方式/描述，详见下节
- `protocol` (string): 主协议（`zigbee` | `wifi` | `bluetooth_mesh` | `matter` ...）
- `bindings` (object): 底层实体映射，如 `zigbee2mqtt.topic`, `ha_entity_id`, `voice_control`, `vendor_extra`
- `traits` (object): 当前状态，按能力分块（见能力表）
- `capabilities` (array): 可执行动作，含参数定义（类型/范围/单位、是否必填）
- `semantics` (object): 自然语言描述/标签/偏好，供 LLM 知识库
- `telemetry` (object): 元数据，如 `last_seen`, `battery`, `rssi`
- `identity` (object): 稳定业务身份（`stableKey/fingerprint/aliasKeys`），用于设备重连后的稳定匹配

### placement（位置/安装/描述）
```json
{
  "room": "living_room",
  "zone": "sofa_corner",
  "floor": "1F",
  "mount": "ceiling",
  "description": "客厅南侧双路吸顶灯，靠近沙发区",
  "coordinates": { "x": 5.2, "y": 3.1, "z": 2.6 }
}
```
- `room` 必填；`zone`/`floor`/`mount`/`coordinates` 选填。
- `description` 用于 LLM 提供丰富语义，不必严格格式。

### semantics（语义标签/偏好）
```json
{
  "summary": "客厅主灯，常用于观影前调暗 30%",
  "tags": ["ambient", "living_room", "dimmable"],
  "aliases": ["主灯", "客厅主灯"],
  "preferred_scenes": ["movie", "evening_relax"],
  "constraints": ["avoid_full_brightness_after_23"],
  "owner_notes": "观影时设 20~30% 亮度，睡前关灯"
}
```
- 与 placement 互补，提供 LLM 更丰富的上下文；`aliases` 用于同义词/别名匹配（语音/口语更友好）。

### bindings.voice_control（语音外呼控制）
用于“Agent 主动唤醒第三方语音设备并下发命令”或“远端语音终端直连主机 Agent”的配置。

- `transport=local_tts`：典型流程是 `wake -> ack -> command`。
- `transport=ws_satellite`：设备本地做唤醒词，随后通过 WebSocket 把 PCM 音频发给主机；主机完成 VAD/STT/Agent/TTS，再把 PCM 语音回传设备。

```json
{
  "voice_control": {
    "transport": "ws_satellite",
    "priority": "prefer",
    "satellite": {
      "endpoint": "ws://voice-host.local:8765/ws",
      "device_id": "living-room-respeaker",
      "protocol_version": "v1",
      "input_audio": {
        "encoding": "pcm_s16le",
        "sample_rate_hz": 16000,
        "channels": 1,
        "frame_samples": 512
      },
      "output_audio": {
        "encoding": "pcm_s16le",
        "sample_rate_hz": 16000,
        "channels": 1,
        "frame_samples": 512
      }
    },
    "wake": {
      "utterances": ["你好，米奇"]
    },
    "actions": {
      "answer": {
        "utterances": ["请回复"],
        "deterministic": true,
        "risk": "low"
      }
    }
  }
}
```
- `wake`: 唤醒词与重试策略。
- `satellite`: 远端语音终端与主机的 WebSocket 绑定，包含终端标识、地址和音频格式。
- `ack.keywords`: 当 `transport=local_tts` 时，用于设备应答判定关键词；未命中则阻断执行并返回错误原因。
- `actions`: 动作到语音模板的映射，支持参数槽位（例如 `{value}`）。

## 常见能力与状态片段
- `switch`: state `on|off`
- `dimmer`: `brightness` 0-100
- `color_temp`: `mired` 或 `kelvin`
- `cover`: `position` 0-100, `tilt` 0-100
- `climate`: `mode`, `target_temp`, `fan_mode`, `swing_mode`
- `air_quality`: `pm25`, `tvoc`, `co2`
- `sensor`: `temperature`, `humidity`, `occupancy`

## JSON Schema（精简版，用于 Ajv/Zod）
```json
{
  "type": "object",
  "required": ["id", "name", "placement", "protocol", "bindings", "traits", "capabilities"],
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "name": { "type": "string" },
    "placement": {
      "type": "object",
      "required": ["room"],
      "properties": {
        "room": { "type": "string" },
        "zone": { "type": "string" },
        "floor": { "type": "string" },
        "mount": { "type": "string", "enum": ["ceiling", "wall", "desktop", "window", "floor", "other"] },
        "description": { "type": "string" },
        "coordinates": {
          "type": "object",
          "properties": {
            "x": { "type": "number" },
            "y": { "type": "number" },
            "z": { "type": "number" }
          },
          "additionalProperties": false
        }
      },
      "additionalProperties": false
    },
    "protocol": { "type": "string" },
    "bindings": { "type": "object" },
    "traits": { "type": "object" },
    "capabilities": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["action"],
        "properties": {
          "action": { "type": "string" },
          "parameters": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["name", "type"],
              "properties": {
                "name": { "type": "string" },
                "type": { "type": "string", "enum": ["number", "bool", "string", "enum"] },
                "minimum": { "type": "number" },
                "maximum": { "type": "number" },
                "enum": { "type": "array", "items": { "type": "string" } },
                "unit": { "type": "string" },
                "required": { "type": "boolean" }
              },
              "additionalProperties": false
            }
          }
        },
        "additionalProperties": false
      }
    },
    "semantics": { "type": "object" },
    "telemetry": { "type": "object" },
    "identity": {
      "type": "object",
      "properties": {
        "stableKey": { "type": "string" },
        "fingerprint": { "type": "object" },
        "aliasKeys": { "type": "array", "items": { "type": "string" } }
      }
    }
  },
  "additionalProperties": false
}
```

## 样例（含位置语义）
```json
{
  "id": "light-lr-main",
  "name": "客厅主灯",
  "placement": {
    "room": "living_room",
    "zone": "sofa_corner",
    "floor": "1F",
    "mount": "ceiling",
    "description": "客厅南侧吸顶灯，覆盖沙发区，左右分两路"
  },
  "protocol": "zigbee",
  "bindings": {
    "zigbee2mqtt": { "topic": "zigbee2mqtt/lr_main_light" },
    "ha_entity_id": "light.living_room_main"
  },
  "traits": {
    "switch": { "state": "off" },
    "dimmer": { "brightness": 0 }
  },
  "capabilities": [
    { "action": "turn_on", "params": [] },
    { "action": "turn_off", "params": [] },
    {
      "action": "set_brightness",
      "parameters": [
        { "name": "value", "type": "number", "minimum": 1, "maximum": 100, "required": true }
      ]
    }
  ],
  "semantics": {
    "summary": "客厅主灯，观影前常调暗至 30%",
    "tags": ["living_room", "primary", "dimmable"],
    "preferred_scenes": ["movie", "evening_relax"]
  },
  "telemetry": {
    "last_seen": 1712345678,
    "rssi": -55
  }
}
```
