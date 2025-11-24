# AGENTS – Web

规划：Next.js 14 (App Router) + TypeScript + React Query + Zustand；UI 可用 Ant Design/MUI/Chakra 任选。

页面建议
- 概览仪表盘：房间/设备状态摘要、告警
- 设备详情：traits/capabilities 渲染，实时状态订阅
- 场景/规则：创建/编辑/启停
- 日志：MQTT/自动化事件时间线

开发提示
- API SDK 从后端共享类型生成（OpenAPI codegen 或手写）。
- WebSocket 订阅设备状态/事件；考虑指数退避重连。
- 将 `placement/semantics` 渲染为“位置/用途”说明，便于人工核对 LLM 知识库。
