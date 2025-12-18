# Smart House Agent（智能家居大脑）

版本：v0.1（2025-12-17）

目标：在现有 `api-gateway` / `device-adapter` / `rules-engine` / `llm-bridge` 基础上，引入一个独立的 `smart-house-agent` 服务作为“智能家居大脑”。该 Agent 通过 MCP（Model Context Protocol）暴露的工具集在运行时查询设备、状态与可执行操作，并以“可审计/可确认/可回滚”的方式执行多步、多设备的任务。

关键原则
- **工具优先**：LLM 不凭空猜测设备/状态，必须通过工具读取事实（设备列表/状态/能力/历史执行结果）。
- **计划与执行分离**：先产出可解释的 `plan`，再经过策略/权限/确认门禁后执行。
- **安全默认**：对写操作（控制设备）实行强约束（置信度阈值、影响面评估、二次确认、速率限制、审计日志）。
- **会话记忆**：支持“唤醒到关闭”的对话周期，保留上下文与用户偏好，并可被工具读取/更新。
- **可扩展**：通过 MCP 将“设备控制/信息源/第三方服务”解耦为可插拔工具服务器（HA、Z2M、能耗、天气、日历等）。

文档索引
- `docs/feature/smart_house_agent/requirements.md`：需求（功能/非功能/安全/体验/验收方向）
- `docs/feature/smart_house_agent/design.md`：设计（架构/数据流/工具体系/会话记忆/安全门禁/可观测性/演进）

快速验证（开发环境）
- 启动：`./deploy/dev-up.sh`
- 直接调用 Agent：
  - `curl -sS -X POST http://localhost:6100/v1/agent/turn -H 'Content-Type: application/json' -d '{"input":"水在烧了么","sessionId":"demo"}' | python -m json.tool`
  - `node backend/tools/agent-run.js --text "关闭烧水壶" --session demo`
  - 如返回 `type=propose`：`node backend/tools/agent-run.js --text "确认" --session demo --confirm`
