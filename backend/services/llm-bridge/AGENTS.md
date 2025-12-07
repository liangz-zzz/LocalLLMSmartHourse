# AGENTS – LLM Bridge

职责：统一与本地 LLM 的通信（OpenAI 协议），并提供意图解析/槽位填充的调用包装给 API Gateway。

规划
- 对接：LLM API Base/Key 从环境变量注入；默认假定 OpenAI 兼容。
- 输出：意图结果包含 `action`, `devices`, `room`, `params`, `confidence`，与 `device-model` 的 `capabilities` 对齐。
- 提升稳定性：常用命令规则优先，LLM 兜底；可在此服务实现合并。

测试
- 为 prompt/解析逻辑建黄金样本测试；可在 CI 中使用小模型或 mock。

当前实现
- 占位回显服务：`POST /v1/chat/completions` 返回最新 user 消息的 echo；`/health`。
- 支持透明代理：设置 `UPSTREAM_API_BASE`（可选 `UPSTREAM_API_KEY`）时会转发到兼容 OpenAI 的上游；失败时自动回退到 echo。
- 意图解析：`POST /v1/intent` 将自然语言解析为推荐动作（`action/deviceId/params/confidence/room/candidates`），基于关键词 + 房间/能力匹配；支持 messages fallback（取最后一条 user）。
- 限流：`RATE_LIMIT_PER_MIN`（默认 60）内存滑窗；超限返回 429。
- 观测：`/metrics` 返回简单计数（chat/intent 请求与上游命中/错误）。
- 运行：`docker compose -f deploy/docker-compose.yml run --rm llm-bridge npm install`，`npm run dev`（PORT 默认 5000）。
- 测试：`docker compose -f deploy/docker-compose.yml run --rm llm-bridge npm test`。
