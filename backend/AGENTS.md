# AGENTS – Backend

职责：统一设备数据模型、协议适配、业务 API、规则引擎与 LLM 桥接。

## 目录
- `services/api-gateway/`: 对外 REST/WS，用户/LLM 调用入口
- `services/device-adapter/`: 订阅 MQTT/HA，标准化状态，暴露 `invoke` 等接口
- `services/rules-engine/`: 规则/场景 DSL 与执行器
- `services/llm-bridge/`: OpenAI 协议转发至本地 LLM 服务
- `pkg/device-model/`: 统一设备模型定义、Schema、编解码/校验

## 语言与技术（规划）
- TypeScript (Node 20+)，可用 NestJS/Fastify；MQTT 客户端 `mqtt`；HA 调用走 REST（长期 token）
- 数据存储：Postgres/Redis（在 compose 中）
- 消息：MQTT 主通道；Redis Streams 可做任务队列

## 开发规范
- 所有新协议/设备适配器遵守 `device-model` 的 `traits/capabilities/bindings/placement/semantics`。
- API 一律返回统一错误码与请求 ID；与前端/LLM 共享 TypeScript 类型（放在 `pkg/`）。
- 规则引擎先用 JSON/DSL，后可外挂 Node-RED/n8n。

## 测试
- 单元测试建议 `vitest` 或 `jest`；集成测试可用 `docker compose` 的服务或 testcontainers。
- 在首次实现前创建基础 `pnpm test` 入口，以便 CI 扩展。
