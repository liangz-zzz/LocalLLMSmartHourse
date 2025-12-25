# AGENTS – API Gateway

职责：面向 Web/移动/LLM 的 REST + WebSocket 网关，提供设备查询、控制、场景、日志订阅等。

规划要点
- 框架：NestJS/Fastify + TypeScript。
- 接口：设备 CRUD、状态查询、动作执行、场景/规则 CRUD（含 `/scenes/:id/expanded`）、LLM 意图入口。
- 实时：WebSocket/SSE 订阅 MQTT 归一化事件。
- 安全：JWT + API Key（给 LLM），后续可支持 HA SSO。

开发提示
- 共享类型与设备模型从 `backend/pkg/device-model` 导入。
- 与 `device-adapter` 通讯：REST/GRPC/消息队列任选，首发可直接调用其 HTTP。
- 在实现时替换 compose 占位镜像与命令。
- 动作参数校验：capability.parameters 支持 `required`/`enum`/`minimum`/`maximum`，REST/WS 会按定义校验并返回 reason。
- 鉴权：可设置 `API_KEYS`（逗号分隔）启用 API Key 校验，HTTP 使用 `X-API-Key` 或 Bearer，WS 使用 `?api_key=` 或 `Sec-WebSocket-Protocol` 携带；也可配置 `JWT_SECRET`（可选 `JWT_AUD`/`JWT_ISS`）启用 JWT 校验（互为或条件）。
- 场景文件：通过 `SCENES_PATH`（或 `CONFIG_DIR/scenes.json`）配置；与设备配置文件同目录便于管理。

运行/模式
- 默认 `MODE=redis`（compose 场景下直接读适配器写入的 `device:*`）；如无 Redis 可切换 `MODE=mock` 使用 `src/fixtures/living_room_plug.json`。`MODE=db` 可直接从 Postgres 读取最新状态。
- `MODE=redis` 时从 `REDIS_URL` 读取 `device:*` JSON（由 device-adapter 写入），并通过 Redis Pub/Sub (`device:updates`) 向 WebSocket `/ws` 推送更新，动作下行发布到 `device:actions`，动作结果/状态快照监听 `device:action_results`/`device:action_results:state` 并推送到 WebSocket；`?devices=id1,id2` 可过滤。
- `MODE=db` 时使用 Prisma 读取 `DATABASE_URL`（schema 位于 `backend/prisma/schema.prisma`，表 `Device`/`DeviceState`）。
- 动作结果持久化：默认开启（`ACTION_RESULTS_PERSIST`），在 Redis 模式监听动作结果并落库表 `ActionResult`，可通过 `GET /devices/:id/actions` 查询。
- 规则管理：REST `GET /rules`/`GET /rules/:id`/`POST /rules`/`PUT /rules/:id`/`DELETE /rules/:id`，依赖 Postgres（Rule 表）。

命令（通过 compose 容器）
- 安装依赖：`docker compose -f deploy/docker-compose.yml run --rm api-gateway npm install`
- 运行（mock 模式）：`docker compose -f deploy/docker-compose.yml run --rm api-gateway npm run dev`
- 运行（redis 模式）：`MODE=redis REDIS_URL=redis://redis:6379 docker compose -f deploy/docker-compose.yml run --rm api-gateway npm run dev`
- 运行（db 模式）：`MODE=db DATABASE_URL=postgres://smarthome:smarthome@db:5432/smarthome docker compose -f deploy/docker-compose.yml run --rm api-gateway npm run dev`
- 测试：`docker compose -f deploy/docker-compose.yml run --rm api-gateway npm test`（含 mock store 单测、Redis + WebSocket 集成、DB store + 动作结果查询集成）
