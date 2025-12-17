# AGENTS – Tools

用途：后端开发辅助脚本。

## 脚本
- `ha-check.js`: 校验 Home Assistant API 连通性。使用 `HA_ELEVATED_TOKEN` 与可选 `HA_BASE_URL`（默认 `http://localhost:8123`）。示例：
  - `node backend/tools/ha-check.js --entity switch.living_room_plug`
  - `node backend/tools/ha-check.js --full` 打印所有状态（可能很长）。
- `mqtt-dump.js`: 订阅 MQTT 主题并打印 payload，便于调试 zigbee2mqtt/设备事件。示例：
  - `npm install`（首次在 `backend/tools` 目录）后运行
  - `node backend/tools/mqtt-dump.js --url mqtt://localhost:1883 --topic zigbee2mqtt/#`
  - `MQTT_URL=mqtt://mqtt:1883 MQTT_TOPIC=zigbee2mqtt/living_room/# node backend/tools/mqtt-dump.js`
- `intent-run.js`: 拉取网关设备列表 → 调用 llm-bridge `/v1/intent` →（可选）下发动作到网关。默认 dry-run，不会真的控制设备：
  - `node backend/tools/intent-run.js --text "打开烧水壶"`（只打印解析结果）
  - `node backend/tools/intent-run.js --text "打开烧水壶" --execute`（实际下发动作，请确保负载安全）
- `agent-run.js`: 调用 `smart-house-agent` 的 `/v1/agent/turn`，便于验证 MCP 工具调用与“提案→确认→执行”流程：
  - `node backend/tools/agent-run.js --text "水在烧了么" --session demo`
  - `node backend/tools/agent-run.js --text "关闭烧水壶" --session demo`
  - `node backend/tools/agent-run.js --text "确认" --session demo --confirm`

如新增工具，请在此列出用途与用法。***
