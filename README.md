# LocalLLMSmartHouse

本仓库提供全屋本地智能的项目骨架：以 Home Assistant + zigbee2mqtt 为设备中枢，API/适配器服务统一设备数据模型，并通过 OpenAI 协议的 LLM 服务完成语音/文本意图到设备控制的闭环。

## 快速启动
1) 复制环境变量：
   - `cp .env.example .env`
   - 按需填写（建议设置 `LOCAL_UID/GID` 与宿主一致，避免挂载权限问题）
2) 启动后端与基础服务：
   - `./deploy/dev-up.sh`
3) 启动前端：
   - `cd frontend/web`
   - `npm ci`
   - `npm run dev`
4) 打开页面：
   - `http://localhost:3000/`（设备面板）
   - `http://localhost:3000/floorplan`（户型编辑与 3D 预览）

## 数据与资产
- 户型与资产默认保存在 `deploy/data/config/`（由 `CONFIG_DIR=/config` 映射）。
