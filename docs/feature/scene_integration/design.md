# 场景集成设计

版本：v0.1（2025-12-25）

## 1. 总体思路
- 场景定义由 API Gateway 统一管理，作为系统事实来源。
- MCP 仅暴露场景“列表”给 Agent；场景展开由 API Gateway 完成并返回线性动作序列，MCP 负责顺序执行。
- Agent 产出包含 `scene` 的执行计划，执行仍走 `actions.batch_invoke` 入口。

## 2. 配置与存储
- 场景文件：`scenes.json`。
- 与设备配置文件同目录，建议新增 `CONFIG_DIR`：
  - `DEVICE_CONFIG_PATH=${CONFIG_DIR}/devices.config.json`
  - `SCENES_PATH=${CONFIG_DIR}/scenes.json`
- API Gateway 负责场景文件读写与校验；写入采用“临时文件 + rename”保证原子性。

## 3. 数据模型
### 3.1 Scene
```json
{
  "id": "sleep",
  "name": "睡觉",
  "description": "关灯、落窗帘、空调睡眠模式",
  "steps": [
    { "type": "device", "deviceId": "bed_light", "action": "turn_off" },
    {
      "type": "device",
      "deviceId": "curtain",
      "action": "set_cover_position",
      "params": { "position": 0 },
      "wait_for": {
        "traitPath": "traits.cover.position",
        "operator": "eq",
        "value": 0,
        "timeoutMs": 20000,
        "pollMs": 500,
        "on_timeout": "abort"
      }
    },
    { "type": "scene", "sceneId": "night_base" }
  ]
}
```

### 3.2 wait_for 语义
- `traitPath`: 读取设备状态的路径（如 `traits.cover.position`）。
- `operator`: `eq | neq | gt | gte | lt | lte`。
- `value`: 期望值。
- `timeoutMs`: 超时阈值。
- `pollMs`: 轮询间隔，默认 500ms。
- `on_timeout`: 仅支持 `abort`。

## 4. 校验与展开
- 校验要点：
  - `id` 唯一。
  - 引用的 `sceneId` 必须存在。
  - 禁止循环嵌套：DFS 检测 `visiting` 栈中的回边即报错。
- 展开规则：API Gateway 递归 inline 展开 `scene` 步骤，保持顺序，得到线性设备动作队列；对调用方隐藏递归过程。

## 5. API 设计（API Gateway）
- `GET /scenes`：返回 `id/name/description` 列表。
- `GET /scenes/:id`：返回完整场景定义。
- `POST /scenes`：创建场景（校验 + 持久化）。
- `PUT /scenes/:id`：更新场景（校验 + 持久化）。
- `DELETE /scenes/:id`：删除场景（如有依赖需 `?cascade=true` 级联删除）。
- `GET /scenes/:id/expanded`：返回展开后的设备动作序列（供 MCP 执行）。

## 6. MCP 工具与 Agent
- MCP 新增：`scenes.list`，只返回 `id/name/description`。
- Agent 在每轮开始时与 `devices.list` 一起拉取 `scenes.list`，并写入系统上下文提示。
- Agent 计划支持 `actions` 中的 `type=scene`：
```json
{ "type": "scene", "sceneId": "sleep" }
```

## 7. 执行策略
- `actions.batch_invoke` 支持接收 `type=scene`。
- MCP 调用 API Gateway 的 `GET /scenes/:id/expanded` 获取线性设备动作列表后顺序执行。
- 每个设备动作执行后，若有 `wait_for`：
  1) 轮询 `devices.state` 直到条件满足或超时。
  2) 超时即中止剩余步骤，并返回失败结果。

## 8. 失败与输出
- 超时中止必须携带明确原因，示例：
```json
{
  "error": "scene_wait_timeout",
  "message": "scene sleep step 2: device curtain traits.cover.position != 0 within 20000ms"
}
```
- Agent 将错误原样传达给用户，并说明场景已中止。
