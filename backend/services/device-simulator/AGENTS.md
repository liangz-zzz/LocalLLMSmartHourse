# AGENTS – Device Simulator

职责：通过配置文件声明“虚拟设备”，将其注册到统一设备存储，并消费动作总线进行状态机模拟。

核心职责
- 读取 `devices.config.json` 中的 `virtual` 段并生成设备模型。
- 将模拟设备写入与真实设备相同的 Redis key 空间（默认 `device:*`），让 API/MCP/Agent 使用同一发现链路。
- 监听动作通道（默认 `device:actions`），按能力与模拟规则更新 traits，并发布动作结果（默认 `device:action_results`）。

配置约定
- `SIMULATOR_ENABLED`：是否启用服务（默认 true）。
- `SIM_DEVICE_CONFIG_PATH` / `DEVICE_CONFIG_PATH` / `CONFIG_DIR/devices.config.json`：配置文件路径。
- `SIM_REDIS_URL` / `REDIS_URL`：Redis 地址。
- `SIM_REDIS_PREFIX` / `REDIS_PREFIX`：设备 key 前缀。
- `SIM_ACTIONS_CHANNEL` / `REDIS_ACTIONS_CHANNEL`：动作通道。
- `SIM_UPDATES_CHANNEL` / `REDIS_UPDATES_CHANNEL`：设备更新通道。
- `SIM_ACTION_RESULTS_CHANNEL` / `REDIS_ACTION_RESULTS_CHANNEL`：动作结果通道。

运行
- 安装依赖：`docker compose -f deploy/docker-compose.yml run --rm device-simulator npm install`
- 启动：`docker compose -f deploy/docker-compose.yml run --rm device-simulator npm run dev`

测试
- `docker compose -f deploy/docker-compose.yml run --rm device-simulator npm test`
