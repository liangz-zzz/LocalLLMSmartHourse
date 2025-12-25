# AGENTS – Smart House MCP Server

职责：以 MCP（Model Context Protocol）形式暴露“智能家居工具（tools）”，供 `smart-house-agent` 调用。该服务本身不做 LLM 推理，只做确定性封装与安全校验：
- 读取：设备列表/详情/状态/最近动作回执、场景列表
- 写入：设备动作下发与场景执行（`actions.batch_invoke` 支持 `type=scene` 与 `wait_for`；严格校验 capabilities/参数；支持 dry-run/确认门禁）
- 审计：为每次工具调用生成 `traceId/requestId` 并记录（后续可写入 DB/日志系统）

约定
- 工具一律通过 `api-gateway` 访问系统事实与副作用（不要直连 MQTT/串口）。
- 写操作必须做能力校验：`action` 必须在目标设备 `capabilities` 中。
- 默认保守：不满足条件时返回结构化错误，等待 Agent 触发澄清/确认流程。

运行
- 环境变量：
  - `PORT`（默认 7000）
  - `API_GATEWAY_BASE`（默认 `http://api-gateway:4000`）
  - `API_GATEWAY_API_KEY`（可选，用于调用受保护的 API Gateway）
  - `DRY_RUN_DEFAULT`（默认 true；除非显式 `dryRun=false + confirm=true`，否则不下发真实控制）
  - `MCP_SESSION_TTL_MS`（默认 3600000；MCP session 过期清理，避免内存无限增长）
- 本地（容器）：
  - `npm ci`
  - `npm run dev`

测试
- `npm test`（包含工具 schema/校验逻辑的基础测试；集成测试可在 compose 中跑）
