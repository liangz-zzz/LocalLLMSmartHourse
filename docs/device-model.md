# 统一设备模型（含位置语义）

目标：跨协议/厂商表示设备，供 API、前端、LLM 共用。重点是可操作性（capabilities）、状态（traits），以及用于 LLM/人理解的位置信息（placement/semantics）。

## 字段总览
- `id` (string): 稳定唯一 ID（UUID 或 slug）
- `name` (string): 展示名称
- `placement` (object): 位置/安装方式/描述，详见下节
- `protocol` (string): 主协议（`zigbee` | `wifi` | `bluetooth_mesh` | `matter` ...）
- `bindings` (object): 底层实体映射，如 `zigbee2mqtt.topic`, `ha_entity_id`, `vendor_extra`
- `traits` (object): 当前状态，按能力分块（见能力表）
- `capabilities` (array): 可执行动作，含参数定义（类型/范围/单位、是否必填）
- `semantics` (object): 自然语言描述/标签/偏好，供 LLM 知识库
- `telemetry` (object): 元数据，如 `last_seen`, `battery`, `rssi`

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
    "telemetry": { "type": "object" }
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
