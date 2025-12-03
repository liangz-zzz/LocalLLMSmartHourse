# Feature TODO Roadmap

状态标记：`[todo]` 未开始，`[next]` 立即要做，`[ip]` 进行中，`[done]` 完成。

## 当前优先级
- [done] 设备适配器最小闭环  
  - Node ESM 项目，MQTT 订阅 `zigbee2mqtt/#`，解析 `bridge/devices` 与 `zigbee2mqtt/<friendly>`，归一化为 `DeviceModel`。  
  - 内存存储（后续接 Redis），支持 `MODE=offline` 读取 mock 数据。  
  - 单元测试：用现有 mock payload 校验归一化；集成测试：内存 MQTT broker (aedes)。
- [done] API Gateway 最小接口  
  - Fastify + mock store，`GET /devices`、`GET /devices/:id`；WebSocket 占位；`MODE=redis` 可读取 `device:*` JSON（等待适配器写入）。  
  - 测试：mock store 单测 + HTTP 集成测试。
- [done] 设备模型验证工具  
  - 在 `pkg/device-model` 增加 Zod 校验 helper，导出给 adapter/gateway；样例校验单测已添加。
- [done] 事件流与动作总线  
  - 适配器写 Redis 并发布 `device:updates`/`device:action_results`/`device:action_results:state`，监听 `device:actions`，支持 MQTT/HA 下行并回执结果。  
  - 网关默认 Redis 模式，通过 WebSocket `/ws` 转发更新/动作结果/状态快照；动作发布到 `device:actions`；WS 支持 `?devices=id1,id2` 过滤。  
  - 测试：Redis WS、动作参数校验、动作结果流、HA/MQTT 下行集成。
- [done] 数据持久化基础  
  - Prisma schema (`Device`/`DeviceState`) + `DATABASE_URL`，命令内置 `prisma generate/db push`。  
  - 适配器可 `DB_ENABLED=true` 时写入 Postgres（同时写 Redis），网关支持 `MODE=db` 直接从 Postgres 读取。  
  - 测试：适配器 DB 集成测试，网关 DB store/HTTP 集成测试。
- [done] 动作结果持久化与查询  
  - 网关监听 `device:action_results` 并落库，`GET /devices/:id/actions` 查询；WS 推送动作结果/状态快照。  
  - 适配器支持 MQTT/HA 下行并返回结果。
- [done] 规则持久化与管理  
  - 规则落库（Postgres）+ Gateway CRUD（列表/查询/创建/更新/删除），规则引擎从 DB 拉取并热更新。  
  - 规则命中会将动作入 ActionResult 表（status `queued_by_rule`），方便追踪。
- [done] HA 映射与参数校验增强  
  - 扩充 cover/climate/light service 映射（tilt/fan_mode/color_temp），调用 Home Assistant 失败会返回 reason。  
  - capability 参数支持 `required`，REST 校验更严格。
- [done] 前端/LLM 占位  
  - Web 首页展示设备卡片，支持 turn_on/turn_off 快捷操作；右侧 LLM 对话（默认 echo，可经 llm-bridge 代理到上游）。
- [done] 规则引擎骨架  
  - 简单 JSON DSL：`deviceId + traitPath equals` -> 动作发布到 Redis `device:actions`；订阅 `device:updates`。
  - 测试：规则匹配单元；运行入口 `rules-engine` 服务。
- [done] LLM Bridge 占位  
  - OpenAI 兼容 `/v1/chat/completions`，默认回显，支持 `UPSTREAM_API_BASE/UPSTREAM_API_KEY` 转发。
- [done] 前端占位页  
  - Next.js 列表页，调用 `/devices` 显示基础信息；支持 mock/真实数据切换，并提供 LLM 体验面板。
- [done] 工具 & 观测  
  - `mqtt-dump` 辅助脚本；AGENTS 中记录用法。
- [done] CI/质量  
  - GitHub Actions 运行 docker compose 校验 + 各 Node 服务测试（含 Redis/Postgres 依赖启动）。

## 下一步（新增）
- [todo] 前端动作参数输入与状态订阅  
  - 在 Web 端补充参数化动作（温度/亮度/模式），接入 WebSocket `/ws` 实时更新。
- [todo] LLM 意图到设备动作链路  
  - 在 llm-bridge 增加意图解析模板 + 回传推荐动作，前端提供“执行/拒绝”交互。
