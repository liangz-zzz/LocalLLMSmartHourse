# AGENTS – Devcontainer

用途：支持 VS Code Dev Containers 直接附着到 `api-gateway` 服务容器进行开发。容器内以非 root 用户运行，避免宿主权限问题。

关键点
- `dockerComposeFile`: 使用 `deploy/docker-compose.yml`
- `service`: `api-gateway`（挂载整个仓库路径 `../backend/services/api-gateway:/app`）
- `remoteUser`: `app`（UID/GID 通过 `.env` 的 `LOCAL_UID/GID` 传入构建）
- `command`: 容器默认 `sleep infinity`，请在终端运行 `pnpm install` 后启动 dev 任务。

使用
1) `cp .env.example .env` 并确保 `LOCAL_UID/GID` 与宿主一致
2) `docker compose -f deploy/docker-compose.yml up -d --build`
3) VS Code 打开仓库，选择 “Reopen in Container”
4) 在容器终端执行需要的 dev 命令（pnpm install / pnpm dev 等）
