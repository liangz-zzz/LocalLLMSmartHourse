# AGENTS – Device Adapter

职责：将底层协议实体（zigbee2mqtt、HA service call 等）映射为统一设备模型；处理发现、状态同步、动作调用。

核心接口（建议）
- `discover()`: 订阅/轮询底层，返回标准化的设备清单
- `get_state(id)`: 从缓存/HA/MQTT 获取状态并归一化为 `traits`
- `invoke(id, action, params)`: 校验 `capabilities` 后执行底层调用

实现要点
- 首期协议：Zigbee via zigbee2mqtt，辅以 HA service call 作为兜底。
- 绑定：保持 `bindings.zigbee2mqtt.topic` 与 `bindings.ha_entity_id`，便于多协议共存。
- 状态缓存：Redis；事件源：MQTT 订阅 `zigbee2mqtt/#`，落库 Postgres。
- 位置信息：解析/维护 `placement` 与 `semantics`，供 LLM 使用。

测试
- 单元：对编解码/校验函数；集成：使用本地 mqtt + 模拟 zigbee2mqtt payload。
