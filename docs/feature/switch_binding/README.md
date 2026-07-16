# 墙壁开关与灯的软件绑定

版本：v1（2026-07-16）

## 决策

- 12 个 Aqara 双键/三键面板在户型图中保持 12 个点位；设备适配器将它们展开为最多 28 个 `relay_channel` 子设备。
- 硬接线关系始终存在：`面板通道 → 本路继电器 → 实际灯具`。平台只能修改显示名称和软件联动，不能改变物理接线。
- 默认使用 `control_relay`，保证网络、规则引擎或 Agent 故障时仍能开关本路灯。`decoupled` 是高级选项，切换前确认，切换后以设备回报的 `traits.switch.operation_mode` 为准。
- 软件绑定唯一事实源是本项目的 `automations.json`；不要在 Home Assistant 中维护同一个按键来源的重复自动化。

## 设备表示

父面板 ID：`zigbee:<IEEE>`，`composition.role=panel`。

通道 ID：`zigbee:<IEEE>:left|center|right`，`composition.role=relay_channel`。通道保存 Zigbee2MQTT 的动态属性名，例如 `state_left` 和 `operation_mode_left`，所以动作只写对应端点。

通道的覆盖名称用于记录硬接事实，例如“玄关左路 · 走廊筒灯”。后续调整物理接线时，先由电工改线，再修改该通道名称；软件绑定是否跟随调整由用户单独决定。

## 软件绑定模型

```json
{
  "id": "entrance_left_single",
  "name": "玄关左键打开公共区",
  "enabled": true,
  "source": {
    "panelId": "zigbee:0x00158d0000001234",
    "selector": "left",
    "trigger": { "type": "button", "gesture": "single" }
  },
  "targets": [
    { "type": "device", "deviceId": "light:hall", "action": "turn_on" },
    { "type": "scene", "sceneId": "evening" }
  ]
}
```

来源：
- `button`：物理单击/双击事件；选择器可为单键，或设备实际支持的 `both`、`left_center`、`left_right`、`center_right`、`all`。
- `state`：某一路继电器状态变为 `on/off`，用于保留本路直控的同时联动其他设备。

目标按数组顺序执行，一个来源可以控制多个设备和场景。保存时会校验面板/通道、设备能力、动作参数、场景、重复来源、自触发和状态绑定环路。

## 调整流程

1. 在户型图选中墙壁面板，核对每一路的继电器状态和硬接灯名称。
2. 编辑现有绑定或新增绑定，选择按键/灯路、触发方式和有序目标。
3. 保持 `control_relay` 时，按键会先改变硬接灯，再由继电器状态绑定联动其他目标；使用按键事件绑定时需确认设备在该模式下仍上报所需事件。
4. 使用 `decoupled` 时，必须先准备可用的软件绑定和恢复路径；UI 会二次确认，并等待设备状态回读。
5. 修改后做一次现场验证：单击、双击、组合键各测试一次，同时确认没有 HA 重复自动化。

## 接口与 Agent

REST：
- `GET/POST /switch-bindings`
- `GET/PUT/DELETE /switch-bindings/:id`
- `POST /switch-bindings/validate`（只校验、不持久化）

MCP：
- 读取：`switch_bindings.list`、`switch_bindings.get`
- 写入：`switch_bindings.upsert`、`switch_bindings.delete`

MCP 写操作默认 dry-run；即使 Agent 运行于自动执行模式，改绑也会保存为待确认提案，用户明确回复“确认”后才执行。
