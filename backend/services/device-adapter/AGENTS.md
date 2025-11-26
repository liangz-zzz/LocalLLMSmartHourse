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

工具/样例
- `mock-adapter.js`: 离线将 `mock-data/zigbee2mqtt` 的示例 payload 归一化为设备模型，用于无设备时的 dry-run。

运行与测试
- 安装依赖：`docker compose -f deploy/docker-compose.yml run --rm device-adapter npm install`（使用 compose 服务与挂载的 node_modules 卷）。
- 运行离线模式：`docker compose -f deploy/docker-compose.yml run --rm device-adapter npm run dev`（默认 `MODE=offline`，加载 mock 数据）。
- 运行 MQTT + Redis（默认）：`MODE=mqtt MQTT_URL=mqtt://mqtt:1883 docker compose -f deploy/docker-compose.yml run --rm device-adapter npm run dev`（`MODE=mqtt` 时默认 `STORAGE=redis`，写入 `REDIS_URL=redis://redis:6379`，前缀 `REDIS_PREFIX=device`）。
- 存储：可显式 `STORAGE=memory` 关闭 Redis 写入。Redis 模式会在 `REDIS_UPDATES_CHANNEL`（默认 `device:updates`）发布状态更新，监听 `REDIS_ACTIONS_CHANNEL`（默认 `device:actions`）的动作，当前仅日志占位。
- Postgres（Prisma）：`DB_ENABLED=true` 时会将设备与状态落库（默认 `DATABASE_URL=postgres://smarthome:smarthome@db:5432/smarthome`），使用共享 schema `backend/prisma/schema.prisma`。
- 测试：`docker compose -f deploy/docker-compose.yml run --rm device-adapter npm test`（含内存 MQTT + Redis + Postgres 集成用例）。
