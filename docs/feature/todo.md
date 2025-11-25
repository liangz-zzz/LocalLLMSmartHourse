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
- [next] 设备模型验证工具  
  - 在 `pkg/device-model` 增加 Zod 校验 helper，导出给 adapter/gateway；为样例跑校验测试。
- [todo] 数据持久化基础  
  - 选 Prisma，建 `device`/`device_state` 表，迁移脚本 & `pnpm db:migrate`。  
  - 适配 adapter 写入与 gateway 读取。
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
