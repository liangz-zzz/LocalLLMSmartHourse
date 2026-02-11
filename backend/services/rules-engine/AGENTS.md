# AGENTS – Rules Engine

职责：场景/联动/定时规则的定义与执行，作为 LLM 之外的确定性执行路径。

规划
- 规则表示：JSON/DSL (if/when/then)，优先支持常用触发（时间、传感器变化、地理围栏）和动作（调用 `device-adapter`/HA）。
- 执行模型：订阅 MQTT 事件；持久化规则到 Postgres；锁与去重用 Redis。
- 回退：当 LLM 不可用时，规则引擎仍可执行。

测试
- 覆盖规则解析、条件判断、动作调用的单元测试；集成测试模拟 MQTT 事件流。

当前实现
- 简单 JSON 规则（`rules.json`）：条件 `deviceId + traitPath + equals`，动作发布到 Redis `device:actions`。
- 自动化（`automations.json`）：支持更通用的触发/条件/延迟/冷却，并可执行 Scene 或多设备动作（面向“用户可配置联动”场景）。
- 运行：订阅 `device:updates`，匹配规则即发布动作；入口 `npm run dev`（需 `REDIS_URL`）。若设置 `DATABASE_URL` 则从 Postgres `Rule` 表拉取规则并周期刷新（`RULES_REFRESH_MS`），并将命中记录写入 `ActionResult` 表（status `queued_by_rule`）。
- 测试：`docker compose -f deploy/docker-compose.yml run --rm rules-engine npm test`（规则匹配单元）。
- 使用 Postgres 时先执行 `npm run prisma:generate && npm run prisma:push` 并确保 `PRISMA_SCHEMA` 指向共享 schema（在宿主机可用绝对路径 `backend/prisma/schema.prisma`）。
- 观测：默认暴露 `/metrics`（`METRICS_PORT`，默认 9100）返回 JSON counters（规则匹配计数等）。

## automations.json（用户可配置自动化）
定位：用 JSON 声明“什么时候触发（trigger）+ 需要满足的条件（when）+ 过多久执行（forMs）+ 执行什么（then）”，以支持多设备联动与更复杂的触发场景。

路径与热加载
- 默认读取：当前工作目录下 `./automations.json`（即容器内 `/app/automations.json`）。
- 可配置：`AUTOMATIONS_PATH=/path/to/automations.json`；或设置 `CONFIG_DIR=/config` 后使用 `${CONFIG_DIR}/automations.json`。
- 热加载：`AUTOMATIONS_REFRESH_MS`（默认 3000ms）按 mtime 变化自动重载；重载会清除旧的 pending timer。

依赖
- 执行 `then.type=scene` 需要 API Gateway：`API_GATEWAY_BASE`（默认 `http://api-gateway:4000`），可选 `API_GATEWAY_API_KEY`（X-API-Key）。
- 规则引擎启动时会从 Redis 读一份设备快照以支持跨设备条件：`REDIS_PREFIX`（默认 `device`）。

支持的 trigger（可扩展）
- `device`：监听某个设备更新（可选按 `traitPath/operator/value/changed` 匹配）。
- `interval`：按固定间隔触发（`everyMs`）。
- `time`：每天固定时刻触发（`at: "HH:MM" | string[]`，按容器时区 `TZ`）。

when 条件表达式（可扩展）
- 原子条件：`{ deviceId, traitPath, operator, value }`（operator 支持 `eq/neq/gt/gte/lt/lte`；也兼容 `equals`）。
- 组合：`{ all: [...] }` / `{ any: [...] }` / `{ not: ... }`
- 时间窗口：`{ time: { after?: "HH:MM", before?: "HH:MM" } }`

then 动作
- `scene`：`{ type: "scene", sceneId }`（会展开为一串 device step 并依次下发；如 step 含 `wait_for` 会等待满足或超时中止）。
- `device`：`{ type: "device", deviceId, action, params?, wait_for? }`

示例
- 见 `automations.json`（默认包含一个 `enabled=false` 的占位示例）。
