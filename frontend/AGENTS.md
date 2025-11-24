# AGENTS – Frontend

职责：Web 控制台与未来移动端，提供设备可视化、控制、自动化配置、日志/告警查看。

目录
- `web/`: Web 客户端 (Next.js 14 + React Query + Zustand 规划)
- `mobile/`: 未来 React Native/Expo 客户端

开发规范
- 共享类型直接从后端的 TypeScript 包导入（设备模型、API 类型）。
- 状态更新通过 WebSocket；写操作通过 API Gateway。
- UI 建议组件化（房间/设备卡片/场景/日志）。

测试
- Web：首选 `vitest` + React Testing Library；E2E 可用 Playwright（后续）。
- 移动端待定，建议保持 Storybook/Preview 以便视觉验证。
