# Feature TODO Roadmap

状态标记：`[todo]` 未开始，`[next]` 立即要做，`[ip]` 进行中，`[done]` 完成。所有上一阶段项已完成，以下为新一轮计划。

## 已完成（里程碑回顾）
- 设备适配器最小闭环（MQTT/Z2M 归一化 + Redis/DB 持久化 + HA/MQTT 动作回执）
- API Gateway（mock/Redis/DB 模式，REST + WS，总线发布/订阅，动作结果持久化）
- 设备模型校验工具（Zod/JSON Schema + 样例）
- 事件总线（Redis updates/actions/action_results + WS 转发）
- 数据持久化（Prisma schema + adapter/gateway DB 模式）
- 动作结果持久化与查询（HTTP + WS）
- 规则持久化与管理（Gateway CRUD + 引擎 DB 热加载 + ActionResult 记录）
- HA 映射与参数校验增强（cover/climate/light；capability.required）
- 前端占位（设备卡片、快捷开关、参数化动作、WS 实时、LLM 聊天）
- LLM Bridge 占位（chat completions 代理/回显；intent 解析接口）
- 工具与 CI（mqtt-dump；CI 运行各服务测试）

## 新一轮计划
- [ip] 前端自动化与回归  
  - 已接入 Playwright + 首个 E2E（设备卡片/参数化动作/意图解析）并在 CI 中启动，后续补充更多场景或组件单测（RTL/Vitest）。  
  - 注：本地受端口限制测试可能失败，优先在 CI/容器内执行。
- [done] LLM 解析增强  
  - 基于关键词/房间/能力的多候选解析，输出动作候选及置信度；支持 messages fallback。  
  - 后续可接入 Prompt/规则混合与真实 LLM，以现有结构为兜底。
- [todo] API/WS 文档与 SDK  
  - 生成 OpenAPI/AsyncAPI，前端/LLM 侧使用统一 SDK（typescript-fetch 或自行封装）。  
  - 在 AGENTS 中补充示例调用与错误码。
- [todo] 安全与鉴权  
  - API/WS 支持 API Key/JWT，llm-bridge 限流/签名校验；规则/动作审计（谁下发）。  
  - 前端接入登录占位（stub）。
- [todo] 运维与观测  
  - 增加基础日志/metrics（JSON line + Prometheus stub），本地 docker-compose 替换占位命令为服务启动。  
  - 提供 mqtt/redis/db 观测脚本或 dashboard 雏形。
