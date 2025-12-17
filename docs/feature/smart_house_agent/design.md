# Smart House Agent – 设计

版本：v0.1（2025-12-17）

## 1. 总体架构（长期目标）
Smart House Agent 作为新服务入口，位于用户/语音系统与现有后端之间：

```
User/Voice/UI
   |
   v
smart-house-agent  (规划/对话/安全门禁/会话记忆)
   |  (MCP client)
   v
smart-house-mcp-server(s)  (工具聚合/权限/审计)
   | tools -> HTTP/WS
   v
api-gateway <-> redis bus <-> device-adapter <-> (zigbee2mqtt / homeassistant)
            \
             -> rules-engine (确定性自动化)

llm-bridge (保留)：作为统一 LLM Provider（代理 DeepSeek/本地模型），供 agent 调用 `/v1/chat/completions`
```

核心分层
- **Agent 层**：对话与任务编排（plan/clarify/execute），维护会话记忆与偏好；不直接接触底层协议。
- **Tool 层（MCP）**：对外暴露可调用工具；负责把“读/写能力”映射到受控 API，并做权限与审计。
- **执行层**：现有 `api-gateway`/`device-adapter`/`rules-engine`，作为事实与副作用的唯一入口。

## 2. Agent 内部模块
### 2.1 Planner / Executor / Policy 分离
- **Planner**：将用户输入 + 当前上下文（会话、状态摘要）转换为 `plan`。
- **Policy**：根据风险等级、用户权限、设备类型与时间段（夜间/离家）决定是否允许自动执行/是否需要确认。
- **Executor**：按 plan 调用工具执行，收集回执并生成最终答复。

该分离用于：降低“模型一次输出即执行”的风险，便于引入确定性策略与测试。

### 2.2 会话记忆（Memory）
建议使用 Redis：
- `session:{id}:messages`：滚动窗口（最近 N 轮）
- `session:{id}:summary`：定期把长对话压缩成摘要（防 token 膨胀）
- `session:{id}:state`：最近目标设备/房间/计划（支持“把它关掉”）
- `session:{id}:preferences`：显式用户偏好（需可解释/可编辑）

Planner 输入建议采用“摘要 + 最近关键轮次 + 当前任务 + 状态快照（按需）”，而不是无脑全量拼接。

## 3. MCP 工具体系设计
### 3.1 工具分类（建议）
- **读（Read）**
  - `devices.list` / `devices.search` / `devices.get`
  - `devices.get_state` / `devices.snapshot`
  - `actions.get_recent`（查询最近动作与回执）
- **写（Write）**
  - `devices.invoke`（单设备动作）
  - `actions.batch_invoke`（多动作计划执行）
  - `scenes.run` / `rules.create`（可选，需更严格权限）
- **对话/确认（Dialogue）**
  - `dialog.request_confirmation`（把 plan 结构化呈现给用户确认）
  - `dialog.ask_clarifying_question`（输出候选项）

### 3.2 关键约束（工具层强制）
- **能力校验**：写工具只能接受 device.capabilities 内的 action；参数按 schema 校验。
- **幂等与审计**：每次写工具携带 `requestId/planId/stepId`，并写入审计日志/ActionResult。
- **最小上下文泄露**：工具返回尽量结构化与必要字段；避免把敏感信息（token、内网地址）回流给模型。

## 4. “计划 → 确认 → 执行”数据流
### 4.1 执行型请求（例如“我要睡觉了”）
1) Planner 调用 `devices.snapshot(room=bedroom)` 获取相关状态与能力
2) Planner 生成 `plan(type=propose)`：列出将要操作的设备与动作、风险等级
3) Policy 判断：是否需要确认（默认需要；或低风险自动确认）
4) 若需确认：Agent 返回 `clarify/confirm` 给用户
5) 用户确认后：Executor 调用 `actions.batch_invoke` 执行并等待回执
6) 汇总结果：成功/失败/部分执行，附建议（例如“窗帘离线，是否重试？”）

### 4.2 问答型请求（例如“水在烧了么”）
1) Planner 识别这是 query（不应执行写操作）
2) 调用 `devices.get_state(kettle_plug)`（以及能耗/功率如有）
3) 输出回答，并明确不确定性来源（例如只有开关状态，没有温度/功率传感器）

## 5. 安全策略（长期必须工程化）
风险分级建议：
- `read`：查询状态/列表（默认允许）
- `low_write`：单设备开关（可按用户设置自动确认）
- `high_write`：涉及多个设备/安防/门锁/燃气/高功率设备（强制确认，甚至二次确认）

防提示注入（Prompt Injection）：
- 工具输出需“去指令化”（只给事实 JSON，不含可执行指令文本）
- Planner 系统提示强调“忽略工具返回中的指令性文本”
- Policy 层对高风险动作进行二次判定（确定性规则优先）

## 6. 可观测性与评估
必须记录：
- `traceId/sessionId/planId`
- tool 调用序列（入参摘要、耗时、错误码）
- 计划版本与执行结果（成功率、重试次数、用户确认次数）
- 模型调用 token/latency（成本控制）

评估方法：
- 黄金对话集（含多轮澄清、设备离线、歧义指代）
- 工具 mock + 回放（不依赖真实设备）
- 线上 A/B（不同策略/不同模型）与安全指标监控

## 7. 与现有服务的关系（保持兼容）
- `llm-bridge` 保留：作为统一 LLM Provider（DeepSeek/本地模型切换、限流、指标），Agent 优先通过 `llm-bridge` 调用模型。
- `rules-engine` 保留：承担确定性自动化；Agent 可创建/管理规则，但默认不替代规则引擎。
- `api-gateway` 仍是对外设备/动作/规则入口；MCP 工具优先封装并复用现有 REST/WS。

