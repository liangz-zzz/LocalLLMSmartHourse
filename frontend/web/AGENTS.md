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

当前占位
- `pages/index.tsx`：设备卡片 + 快捷开/关 + 参数化动作，意图解析→执行，右侧 llm-bridge 对话演示（echo/可代理上游），通过 Next API 代理调用网关；监听 WebSocket `/ws` 实时更新。
- `pages/api/devices.ts`：代理网关 `http://localhost:4000/devices`（可用 `API_HTTP_BASE` 覆盖）。
- `pages/api/devices/[id]/actions.ts`：代理设备动作下发。
- `pages/api/chat.ts`：代理 llm-bridge `/v1/chat/completions`（支持 `LLM_HTTP_BASE`/`LLM_API_KEY`）。
- `pages/api/intent.ts`：代理 llm-bridge `/v1/intent`，返回解析后的动作。
- `lib/api-client.ts`：轻量 API SDK（devices/actions/rules）供前端/集成复用，默认基址 `API_HTTP_BASE`/`NEXT_PUBLIC_API_HTTP_BASE`。

环境变量
- `NEXT_PUBLIC_WS_BASE` 可显式设置网关 WebSocket 地址（默认推断 `ws://<host>:4001/ws`），`NEXT_PUBLIC_WS_PORT` 覆盖端口。

开发/测试
- 依赖：`npm ci`（目录 `frontend/web`）。
- 开发：`npm run dev`（Next dev server，默认 3000）。
- 构建/启动：`npm run build && npm start`。
- E2E：`npm test`（Playwright，使用 `scripts/serve.js` 启动 Next dev server，测试会拦截 `/api/*` 请求注入假数据；默认端口 3100）。CI 将自动安装 chromium 并运行。
