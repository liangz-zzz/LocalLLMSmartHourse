# 设备模拟（Device Simulation）

## 背景
当前系统通过真实设备接入（zigbee2mqtt/HA）后，Agent 才能发现并调用设备。该模式在“无真机开发/调试”场景下效率低。

本特性引入独立 `device-simulator` 服务：通过配置定义虚拟设备，写入同一设备存储与动作总线，让 Agent 在同一链路下完成发现与控制。

## 目标
- 支持通过配置声明虚拟设备（而不是硬编码 mock）。
- Agent 对虚拟设备与真实设备“透明”，继续调用 `devices.list/get/invoke`。
- 支持状态机级模拟：动作后状态变化、延迟、失败注入。
- 与真实设备共存，避免职责混杂到 `api-gateway` 或 `smart-house-agent`。

## 非目标
- 不模拟底层 MQTT/HA 协议细节。
- 不引入新的 Agent 工具协议。
- 不实现复杂物理模型或高精度时序仿真。

## 配置方式
统一使用 `devices.config.json`，新增顶层 `virtual` 段。

```json
{
  "devices": [
    {
      "id": "kettle_plug",
      "name": "烧水壶插座",
      "placement": { "room": "kitchen" }
    }
  ],
  "virtual": {
    "enabled": true,
    "defaults": {
      "latency_ms": 120,
      "failure_rate": 0
    },
    "devices": [
      {
        "id": "sim_light_lr",
        "name": "客厅模拟灯",
        "placement": { "room": "living_room", "zone": "sofa" },
        "protocol": "virtual",
        "bindings": {},
        "traits": {
          "switch": { "state": "off" },
          "dimmer": { "state": "off", "brightness": 0 }
        },
        "capabilities": [
          { "action": "turn_on" },
          { "action": "turn_off" },
          {
            "action": "set_brightness",
            "parameters": [{ "name": "brightness", "type": "number", "minimum": 0, "maximum": 100, "required": true }]
          }
        ],
        "simulation": {
          "latency_ms": 80,
          "failure_rate": 0.02,
          "transitions": {
            "set_brightness": {
              "from_params": [{ "param": "brightness", "trait_path": "dimmer.brightness" }],
              "traits": { "switch": { "state": "on" }, "dimmer": { "state": "on" } }
            }
          }
        }
      }
    ]
  }
}
```

说明：
- `virtual.defaults` 为全局默认值。
- `simulation.transitions.<action>.traits`：动作后附加 traits patch。
- `simulation.transitions.<action>.from_params`：把动作参数映射到 traits 路径。
- 若未配置 transition，服务内置常见动作默认状态演进（如 `turn_on/turn_off/set_brightness/...`）。

## 架构与链路
1. `device-simulator` 启动时读取 `virtual.devices[]`。
2. 写入 Redis `device:*`（与 `device-adapter` 相同 key 前缀）。
3. 订阅 `device:actions`，仅处理自身设备 ID。
4. 执行动作后更新 traits，发布：
- `device:updates`
- `device:action_results`
- `device:action_results:state`
5. `api-gateway` 与 `smart-house-mcp-server` 无需新增控制接口。

## Agent 透明性
- 模拟来源标记写在 `bindings.vendor_extra.__simulator_source=true`（后台可见，便于排查）。
- `smart-house-mcp-server` 在 `devices.list/get/state` 返回前会移除该内部标记，避免 Agent 感知“是否模拟设备”。

## 与现有配置/管理接口兼容
- `device-adapter` 的配置解析已将 `virtual` 视为保留顶层字段，不会误当作设备覆盖项。
- `api-gateway` 的 `device-overrides` 存储已改为“保留 envelope”：通过 API 更新 `devices` 时不会覆盖 `virtual`/`voice_control` 等段。

## 运行
在 compose 中新增 `device-simulator` 服务（默认 `sleep infinity`，配合 autostart 覆盖运行 `npm run dev`）。

核心环境变量：
- `SIMULATOR_ENABLED`（默认 `true`）
- `SIM_DEVICE_CONFIG_PATH`（默认复用 `CONFIG_DIR/devices.config.json`）
- `SIM_REDIS_URL` / `REDIS_URL`
- `SIM_ACTIONS_CHANNEL` / `REDIS_ACTIONS_CHANNEL`

## 测试范围
- `backend/services/device-simulator/test/simulator.test.js`
  - 虚拟设备加载与注册
  - 默认动作状态演进
  - 失败注入
  - 非模拟设备 action 忽略
- `backend/services/device-adapter/test/device-config.voice.test.js`
  - `virtual` 顶层字段不被误解析为设备覆盖
- `backend/services/api-gateway/test/device-overrides-store.test.js`
  - 更新 device overrides 时保留 `virtual` 段
- `backend/services/smart-house-mcp-server/test/tools.test.js`
  - MCP 返回对 Agent 隐藏模拟来源标记
