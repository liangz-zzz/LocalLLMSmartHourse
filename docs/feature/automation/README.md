# 自动化（Automation）/规则（Rule）

目标：让用户用 JSON 配置“触发条件 →（可选）持续/延迟 → 执行动作”，并复用已有 Scene（多设备动作序列）。

本项目当前落点：
- Scene：由 `api-gateway` 管理（`scenes.json` + REST），并可展开为线性 device step 序列。
- Automation：由 `rules-engine` 读取 `automations.json` 执行（订阅 `device:updates`，向 `device:actions` 发布动作）。

## automations.json（初版 DSL）
文件位置与热加载见：
- `backend/services/rules-engine/AGENTS.md`

示例文件：
- `docs/feature/automation/automations.example.json`

核心结构（简化）：
```json
{
  "id": "string",
  "enabled": true,
  "trigger": { "type": "device|time|interval", "..." : "..." },
  "when": { "all|any|not|time|deviceId+traitPath+operator+value": "..." },
  "forMs": 600000,
  "cooldownMs": 3600000,
  "then": [
    { "type": "scene", "sceneId": "sleep" },
    { "type": "device", "deviceId": "light.bedroom", "action": "turn_on" }
  ]
}
```

### trigger（什么时候开始检查/执行）
当前支持三类触发器：
- `device`：设备状态更新触发（可选要求 trait 变化/匹配某个值）。
- `time`：每天固定时刻触发（按容器 `TZ` 时区）。
- `interval`：固定间隔触发（轮询式定时）。

`device` 触发（简化）：
```json
{
  "type": "device",
  "deviceId": "binary_sensor.bedroom_motion",
  "traitPath": "traits.raw.state",
  "operator": "eq",
  "value": "on",
  "changed": true
}
```
- `changed=true` 表示必须“发生变化”才算触发（避免每次同值上报都触发）。
- 若只想“任何更新都触发”，可只写 `deviceId`（不写 `traitPath/value`）。

`time` 触发（简化）：
```json
{ "type": "time", "at": ["23:00", "07:30"] }
```

`interval` 触发（简化）：
```json
{ "type": "interval", "everyMs": 60000 }
```

### when（触发后需要满足的条件）
支持组合表达式（递归）：
- `all`：全部满足
- `any`：任一满足
- `not`：取反
- `time`：时间窗口（可跨午夜）

原子条件（device state 比较）：
```json
{ "deviceId": "binary_sensor.living_room_motion", "traitPath": "traits.raw.state", "operator": "eq", "value": "off" }
```

时间窗口条件：
```json
{ "time": { "after": "22:30", "before": "07:00" } }
```

### forMs（“持续满足多久才执行”）
`forMs>0` 时表示：在 trigger 命中且 `when` 为真后，延迟 `forMs` 执行；如果等待期间任何相关设备更新导致 `when` 变为假，会自动取消本次执行。

### then（执行什么）
两类动作：
- `scene`：执行一个场景（会从 `api-gateway` 拉取 `/scenes/:id/expanded` 并顺序下发每个 device step）。
- `device`：下发单个设备动作。

并支持 `wait_for`（等待状态满足后继续下一步，超时抛错并中止当前自动化执行）：
```json
{
  "type": "device",
  "deviceId": "cover.living_room",
  "action": "set_cover_position",
  "params": { "position": 0 },
  "wait_for": { "traitPath": "traits.cover.position", "operator": "eq", "value": 0, "timeoutMs": 20000, "pollMs": 500, "on_timeout": "abort" }
}
```

## 典型用法：占用传感器联动（从客厅到卧室）
思路：以“卧室有人（changed_to=on）”作为触发，在 `when` 里要求“客厅无人”，并用 `forMs` 表达“长时间未返回”。

注意：不同传感器在统一设备模型里的 `traitPath` 可能不同。最稳妥方式是先通过 API Gateway 的 `/devices/:id` 查看当前设备的 `traits` 结构，再填写 `traitPath`。
