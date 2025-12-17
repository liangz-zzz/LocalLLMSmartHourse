# AGENTS – Smart House Agent

职责：作为“智能家居大脑”的新入口服务，负责对话/规划/确认/执行编排。该服务：
- 通过 `llm-bridge` 调用 LLM（OpenAI 兼容 `/v1/chat/completions`）。
- 作为 MCP Client 连接 `smart-house-mcp-server`，只通过工具读取事实与下发动作（不直连 MQTT/HA）。
- 维护会话记忆（短期对话、最近目标设备、待确认的计划）。
- 对写操作实施安全门禁：默认 dry-run/提案，确认后再执行。

约定
- 工具调用只走 MCP（`smart-house-mcp-server`），不要直接访问 `api-gateway`（除非作为工具的实现细节）。
- 永远不要相信模型“猜测的状态/能力”：需要事实时先调用 `devices.*` 工具。
- 写操作默认不执行：必须显式确认（`confirm=true` 或识别为用户确认语句）才会真实下发。

运行
- 环境变量：
  - `PORT`（默认 6000）
  - `LLM_API_BASE`（默认 `http://llm-bridge:5000/v1`）
  - `LLM_API_KEY`（可选；透传给上游）
  - `AGENT_MODEL`（默认 `deepseek-chat`）
  - `MCP_URL`（默认 `http://smart-house-mcp-server:7000/mcp`）
  - `REDIS_URL`（可选；如提供则用于会话存储）
  - `SESSION_TTL_MS`（默认 3600000）
  - `SESSION_MAX_MESSAGES`（默认 30）
- 本地（容器）：
  - `npm ci`
  - `npm run dev`

测试
- `npm test`

