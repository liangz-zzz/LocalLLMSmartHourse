# AGENTS – Deploy

用途：本地/开发环境的容器编排。生产可迁移到 K8s，但 compose 是最小可运行骨架。

## 核心服务
- `mqtt` (eclipse-mosquitto): 事件总线
- `zigbee2mqtt`: Zigbee <-> MQTT 桥；默认需要 USB 协调器，`ZIGBEE_SERIAL_PATH` 在 `.env` 设置
- `homeassistant`: 自动化/实体管理，存储在 `deploy/homeassistant`
- `db` / `redis`: 状态与缓存
- `api-gateway`: 对外 API (REST/WS) 占位容器
- `device-adapter`: 统一设备模型与底层实体的适配占位容器
- `device-simulator`: 基于配置的虚拟设备模拟服务（与真实设备共享发现/控制链路）
- `rules-engine`: 规则/联动占位容器
- `llm-bridge`: OpenAI 协议到自建 LLM API 的桥接占位容器
- `smart-house-mcp-server`: MCP 工具服务器（对接 Agent/LLM，代理 api-gateway 的设备/状态/控制能力）
- `smart-house-agent`: 智能家居大脑入口（对话/规划/确认/执行；通过 MCP 调用工具，通过 llm-bridge 调用模型）
- `voice-satellite`（profile: voice）：离线语音入口（唤醒词/VAD/STT/TTS），将文本转发给 `smart-house-agent` 并播报响应
- `traefik`: 可选反向代理，需添加 `traefik/traefik.yml` 与证书

## 运行
1) `cp .env.example .env` 并按需填写，确保 `LOCAL_UID/GID` 与宿主用户一致（避免挂载权限问题）
2) `docker compose -f deploy/docker-compose.yml up -d --build`
3) 首次启动会在 `deploy/homeassistant`、`deploy/zigbee2mqtt` 等目录生成配置

## 一键启动（推荐给“直接跑起来”场景）
- 自动启动 Node 服务：`./deploy/dev-up.sh`（等价于 `docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.autostart.yml --profile voice up -d --build`）
- 说明：默认 compose 里的业务容器保持 `sleep infinity` 便于 devcontainer；`docker-compose.autostart.yml` 作为覆盖文件会在容器启动时执行 `npm ci`/初始化并 `npm run dev`（为解决 node_modules 权限问题，该覆盖文件用 root 做一次 chown 后再切回 node 用户运行）。

说明：Postgres/Redis 默认映射 `15432` / `16379` 避免与宿主已有实例冲突，若需要其它端口或完全关闭映射可在 `.env` 调整或移除 `ports`。

## 开发容器（简化模式）
- 需要单容器 dev shell 时使用 `deploy/Dockerfile.dev` + `deploy/dev-container.sh`，默认挂载整个仓库到 `/workspace`。
- 构建/启动/进入：`./deploy/dev-container.sh build`、`./deploy/dev-container.sh start`、`./deploy/dev-container.sh into`；停止 `./deploy/dev-container.sh stop`。
- Linux 上会自动 `--network host`，macOS/Windows 默认为桥接；若需要 GPU 支持可设置 `ENABLE_GPU=1`。
- 该容器只提供开发工具链（Node + pnpm + Python 等），业务服务仍可通过 `docker compose -f deploy/docker-compose.yml up <service>` 启动或在容器内手工运行。

## 约定
- 协调器使用 `privileged: true` 以兼容更多 USB/串口；如果不需要可移除。
- Compose 采用开发模式：挂载源码目录，`command: sleep infinity` 供 devcontainer 进入后运行自定义命令。
- 配置目录：默认挂载 `deploy/data/config` 到容器 `/config`（`CONFIG_DIR=/config`）。其中可放置：
  - `devices.config.json`（设备元信息覆盖）
  - `scenes.json`（场景）
  - `automations.json`（自动化/联动，供 `rules-engine` 读取）
- 镜像构建使用 `docker-compose.yml` 中的 `build.context` 作为构建根目录（如 `api-gateway` 指向 `backend/services/api-gateway`）；`deploy/dev-up.sh` 默认带 `--build`，因此会基于该上下文重建镜像。
- 任何新增服务需更新此文件与根目录 `AGENTS.md`。
