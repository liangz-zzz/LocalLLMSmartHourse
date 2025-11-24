# AGENTS – Mobile

规划：React Native + Expo，尽量与 Web 共享 TypeScript 类型与 API SDK。

建议功能
- 快速入口：常用场景、房间快捷开关
- 语音入口：与本地语音助手/LLM 网关联动
- 推送：告警/自动化事件（后续可用 FCM/APNs 或本地通知）

开发提示
- 对应的 API/WebSocket 地址应从配置读取，方便局域网/外网切换。
- UI 复用 Web 的设计语言，但针对移动端做简化和手势支持。
