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
- `pages/_app.tsx` + `components/app-shell.tsx`：共享壳层，统一主导航和 HA / Zigbee2MQTT 外部入口。
- `pages/index.tsx`：Command Center，只保留设备摘要、LLM chat / intent、系统摘要和跳转入口，不再作为主设备控制台。
- `pages/ha-hub.tsx`：集中承载 HA 生态深链入口（Overview / Devices / Automations / Scenes / History / Logbook）。
- `pages/floorplan.tsx`：户型编辑与 3D 预览（2D 房间/设备编辑、三点校准、设备布点、外部系统跳转）。
- `pages/virtual-devices.tsx`：虚拟设备概览页，入口仍聚焦到 floorplan 工作区。
- `pages/scenes.tsx`：高级场景编排，保留 wait_for / step-based / scene 引用等高阶能力。
- `pages/automations.tsx`、`pages/devices/[id].tsx`：过渡/调试入口，正式用户流程优先导向 HA。
- `pages/api/devices.ts`：代理网关 `http://localhost:4000/devices`（可用 `API_HTTP_BASE` 覆盖）。
- `pages/api/devices/[id]/actions.ts`：代理设备动作下发。
- `pages/api/floorplans.ts`/`pages/api/floorplans/[id].ts`：代理户型 CRUD。
- `pages/api/assets.ts`：代理资产上传；`pages/api/assets/[...path].ts` 代理资产访问。
- `pages/api/scenes.ts`/`pages/api/scenes/[id]/expanded.ts`：代理场景列表与展开。
- `pages/api/virtual-devices/models.ts`：代理虚拟设备型号模板列表/批量更新（`GET/PUT /virtual-devices/models`）。
- `pages/api/virtual-devices/models/[id].ts`：代理单个虚拟设备型号模板的 upsert/delete（`PUT/DELETE /virtual-devices/models/:id`）。
- `pages/api/chat.ts`：代理 llm-bridge `/v1/chat/completions`（支持 `LLM_HTTP_BASE`/`LLM_API_KEY`）。
- `pages/api/intent.ts`：代理 llm-bridge `/v1/intent`，返回解析后的动作。
- `lib/device-types.ts`：前端统一设备读模型与 capability 类型。
- `lib/integrations.ts`：HA / Zigbee2MQTT 基址、HA Hub 深链和设备外链解析。
- `lib/api-client.ts`：轻量 API SDK（devices/actions/rules）供前端/集成复用，默认基址 `API_HTTP_BASE`/`NEXT_PUBLIC_API_HTTP_BASE`。
- `public/vendor/three/*`：3D 预览所需的 three.js 模块（importmap + 动态加载）。

环境变量
- `NEXT_PUBLIC_WS_BASE` 可显式设置网关 WebSocket 地址（默认推断 `ws://<host>:4001/ws`），`NEXT_PUBLIC_WS_PORT` 覆盖端口。
- `NEXT_PUBLIC_HA_BASE_URL`：浏览器可访问的 HA 地址，用于 HA Hub 和设备外链。
- `NEXT_PUBLIC_Z2M_BASE_URL`：浏览器可访问的 Zigbee2MQTT Web 地址。
- `NEXT_PUBLIC_HA_LINKS_JSON`：可选 JSON，用于覆盖 HA Hub 默认深链和设备 entity 路径模板。

开发/测试
- 依赖：`npm ci`（目录 `frontend/web`）。
- 开发：`npm run dev`（Next dev server，默认 3000）。
- 构建/启动：`npm run build && npm start`。
- E2E：`npm test`（Playwright，使用 `scripts/serve.js` 启动 Next dev server，测试会拦截 `/api/*` 请求注入假数据；默认端口 3100）。CI 将自动安装 chromium 并运行。
