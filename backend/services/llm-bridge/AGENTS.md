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
- 运行：`docker compose -f deploy/docker-compose.yml run --rm llm-bridge npm install`，`npm run dev`（PORT 默认 5000）。
- 测试：`docker compose -f deploy/docker-compose.yml run --rm llm-bridge npm test`。
