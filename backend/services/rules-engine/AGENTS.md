# AGENTS – Rules Engine

职责：场景/联动/定时规则的定义与执行，作为 LLM 之外的确定性执行路径。

规划
- 规则表示：JSON/DSL (if/when/then)，优先支持常用触发（时间、传感器变化、地理围栏）和动作（调用 `device-adapter`/HA）。
- 执行模型：订阅 MQTT 事件；持久化规则到 Postgres；锁与去重用 Redis。
- 回退：当 LLM 不可用时，规则引擎仍可执行。

测试
- 覆盖规则解析、条件判断、动作调用的单元测试；集成测试模拟 MQTT 事件流。

当前实现
- 简单 JSON 规则（`rules.json`）：条件 `deviceId + traitPath + equals`，动作发布到 Redis `device:actions`。
- 运行：订阅 `device:updates`，匹配规则即发布动作；入口 `npm run dev`（需 `REDIS_URL`）。
- 测试：`docker compose -f deploy/docker-compose.yml run --rm rules-engine npm test`（规则匹配单元）。
