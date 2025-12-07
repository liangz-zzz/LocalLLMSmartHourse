# API Surface

- REST：见 `openapi.yaml`（设备列表/详情、动作下发与查询、规则 CRUD、健康检查，支持 ApiKey/JWT）。
- WS：`/ws`（查询参数 `?devices=id1,id2` 可过滤），推送事件：
  - `device_update`：归一化设备状态更新
  - `action_result`：动作回执
  - `state_snapshot`：最新状态快照
- LLM Bridge：`/v1/chat/completions`（OpenAI 兼容，默认回显/可代理上游）、`/v1/intent`（意图解析，返回候选）、`/metrics`（请求计数）。

用法
- 本地 compose：默认 `http://localhost:4000`，WS `ws://localhost:4001/ws`。
- 规则/动作需要 Redis/DB 已启动；LLM Bridge 默认端口 `5000`，`/metrics` 默认开启。
