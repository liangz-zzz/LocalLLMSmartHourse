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
  - 适配器写 Redis 并发布 `device:updates`，监听 `device:actions`（当前 stub 日志）。  
  - 网关默认 Redis 模式，通过 WebSocket `/ws` 转发更新，`POST /devices/:id/actions` 发布到 `device:actions`。  
  - 测试：Redis WS 集成测试（gateway）、Redis 集成（adapter）。
- [done] 数据持久化基础  
  - Prisma schema (`Device`/`DeviceState`) + `DATABASE_URL`，命令内置 `prisma generate/db push`。  
  - 适配器可 `DB_ENABLED=true` 时写入 Postgres（同时写 Redis），网关支持 `MODE=db` 直接从 Postgres 读取。  
  - 测试：适配器 DB 集成测试，网关 DB store/HTTP 集成测试。
- [todo] 规则引擎骨架  
  - 定义最小 JSON DSL（triggers + conditions + actions），加载本地 rules.json，匹配后打印动作（占位）。
- [todo] LLM Bridge 占位  
  - OpenAI 兼容 `/v1/chat/completions`，内部可回显或代理配置中的 API_BASE，方便前端/LLM 测试。
- [todo] 前端占位页  
  - Next.js 列表页，调用 `/devices` 显示基础信息；支持 mock/真实数据切换。
- [todo] 工具 & 观测  
  - `mqtt-dump` 辅助脚本；日志格式统一（JSON line），README/AGENTS 中记录验证命令。
- [todo] CI/质量  
  - GitHub Actions 增加 pnpm lint/test；各服务 package.json 加 `lint`/`test`。

> 当前准备先启动「设备适配器最小闭环」，完成后再推进 API Gateway。
