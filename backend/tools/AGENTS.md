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

如新增工具，请在此列出用途与用法。***
