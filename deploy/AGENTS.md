# AGENTS – Deploy

用途：本地/开发环境的容器编排。生产可迁移到 K8s，但 compose 是最小可运行骨架。

## 核心服务
- `mqtt` (eclipse-mosquitto): 事件总线
- `zigbee2mqtt`: Zigbee <-> MQTT 桥；默认需要 USB 协调器，`ZIGBEE_SERIAL_PATH` 在 `.env` 设置
- `homeassistant`: 自动化/实体管理，存储在 `deploy/homeassistant`
- `db` / `redis`: 状态与缓存
- `api-gateway`: 对外 API (REST/WS) 占位容器
- `device-adapter`: 统一设备模型与底层实体的适配占位容器
- `rules-engine`: 规则/联动占位容器
- `llm-bridge`: OpenAI 协议到自建 LLM API 的桥接占位容器
- `traefik`: 可选反向代理，需添加 `traefik/traefik.yml` 与证书

## 运行
1) `cp .env.example .env` 并按需填写，确保 `LOCAL_UID/GID` 与宿主用户一致（避免挂载权限问题）
2) `docker compose -f deploy/docker-compose.yml up -d --build`
3) 首次启动会在 `deploy/homeassistant`、`deploy/zigbee2mqtt` 等目录生成配置

## 约定
- 协调器使用 `privileged: true` 以兼容更多 USB/串口；如果不需要可移除。
- Compose 采用开发模式：挂载源码目录，`command: sleep infinity` 供 devcontainer 进入后运行自定义命令。
- 任何新增服务需更新此文件与根目录 `AGENTS.md`。
