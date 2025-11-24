# AGENTS – Repo Map & Practices

目的：作为项目的“元描述”，帮助任何贡献者理解结构、约定、开发和测试要求。保持与实际实现同步。

## 总述
- 目标：本地优先的全屋智能平台，首期基于 Home Assistant + zigbee2mqtt，统一设备模型，暴露 API（REST/WebSocket）和 LLM (OpenAI 协议) 对接点。
- 主要语言/框架（规划）：后端 TypeScript（NestJS/Fastify 风格）、前端 Next.js (Web) + React Native (未来移动端)；自动化/适配器可用 Python/TS 任选，先以 TS 方案为默认。
- 运维：Docker Compose 本地开发；后续可演进到 Kubernetes。

## 目录地图
- `backend/` 服务端代码与设备模型
- `frontend/` Web 与未来移动端
- `deploy/` 本地开发环境的 docker-compose、反向代理和配置样例
- `docs/` 设计文档（架构、设备模型等）
- `.github/workflows/` CI 配置

每个关键目录下有 `AGENTS.md` 解释用途与要求。

## 统一设备模型（关键字段）
- `id/name`: 稳定 ID 与展示名
- `placement`: 位置/语义描述（room/zone/floor/mount/description），用于 LLM 语义理解
- `protocol/bindings`: 底层实体映射（zigbee2mqtt 主题、HA entity_id 等）
- `traits`: 当前状态（开关/亮度/温度等）
- `capabilities`: 可执行操作（action + 参数定义）
- `semantics`: 自然语言描述/标签（用途、场景、偏好），喂给 LLM 知识库

详见 `docs/device-model.md` 和 `backend/pkg/device-model/AGENTS.md`。

## 开发环境（本地）
1) 安装 Docker / Docker Compose v2
2) 可选：Node.js 20+ (pnpm/yarn/nvm)；Python 3.11+ 如需脚本
3) 复制 `.env.example` 为 `.env` 并根据注释填充（确保 `LOCAL_UID/GID` 与宿主一致，便于挂载写入）
4) 启动基础设施：`docker compose -f deploy/docker-compose.yml up -d --build`（首次运行会创建数据卷）；Dev Containers 直接复用该 compose。

## 测试与质量
- CI：GitHub Actions `ci.yml` 当前仅校验 compose 配置，后续补充 lint/test。
- 本地建议：预留 `pnpm lint/test`（前端、后端分别执行）；`docker compose config` 校验部署。
- 变更时更新相关 `AGENTS.md` 以保持信息真实。

## 安全与密钥
- `.env` 不纳入版本控制；HA Token、LLM Key 存储于本地/Secrets。
- MQTT/HA 建议使用本地网络，必要时反向代理启用 TLS。

## 如何贡献/迭代
- 新协议：新增 adapter，扩展 `bindings` 映射，不破坏上层 API。
- 新服务：在对应目录创建子文件夹与 `AGENTS.md`，更新 `deploy/docker-compose.yml`。
- 文档：新增设计文档时在 `docs/` 创建文件并在此处引用。
- Dev 容器：见 `.devcontainer/AGENTS.md`，默认附着 `api-gateway` 服务，命令保持 `sleep infinity` 供开发者启动自定义任务。 
