# AGENTS – Device Model

职责：统一设备的结构定义、Schema、编解码与验证工具，供前后端与 LLM 共享。

核心字段
- `id`: 稳定唯一 ID（UUID/slug）
- `name`: 展示名称
- `placement`: 用于定位/语义的结构（见下）
- `protocol`: 主协议（zigbee | wifi | bluetooth_mesh ...）
- `bindings`: 底层实体映射（如 `zigbee2mqtt.topic`, `ha_entity_id`, `vendor_extra`）
- `traits`: 当前状态；按能力分块，如 `switch`, `dimmer`, `climate`, `cover`
- `capabilities`: 可执行动作，描述 action 名、参数名/类型/范围
- `semantics`: 供 LLM/搜索的自然语言描述、标签、偏好（例如常用场景、限制因素）
- `telemetry`: 元数据，如 `last_seen`, `battery`, `signal`

placement 细化（满足“位置/功能描述”需求）
- `room` (必填): `living_room` 等
- `zone` (可选): 细分区域 `sofa_corner` / `dining_area`
- `floor` (可选): `1F/2F` 或 `B1`
- `mount` (可选): `ceiling` | `wall` | `desktop` | `window`
- `description` (可选): 自然语言说明（例：“客厅南面窗户，双轨窗帘左轨”）
- `coordinates` (可选): `{ x, y, z }` 室内坐标或 `{ lat, lon }`

Schema
- 详见 `docs/device-model.md` 的 JSON Schema/样例。
- TypeScript 类型：`types.ts`
- JSON Schema：`device.schema.json`
- 样例：`examples/living_room_plug.json`

测试
- 需提供 Schema 校验测试（Ajv/Zod）与样例解析测试。
