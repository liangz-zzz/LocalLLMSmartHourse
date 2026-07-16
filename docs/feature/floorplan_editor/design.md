# 2D 户型编辑与设备坐标设计

版本：v0.2（2026-07-16）

## 1. 数据来源

- `floorplans.json` 保存可编辑的图片、比例尺、房间和设备图像位置。
- `devices.config.json` 保存派生后的设备房间和米制坐标，供 Device Adapter、API 和 Agent 读取。
- 户型布点是自动房间和 `source=floorplan` 坐标的事实来源；API Gateway 在启动及每次户型增删改后进行全量协调。
- 设备覆盖项使用内部 `_floorplanPlacement` 元数据跟踪自动房间来源；该字段不会进入统一设备读模型。

## 2. 户型模型

```json
{
  "version": 2,
  "floorplans": [
    {
      "id": "floor1",
      "name": "一层",
      "image": {
        "assetId": "asset_001",
        "url": "/assets/floorplans/floor1.png",
        "width": 2048,
        "height": 1536,
        "mime": "image/png",
        "size": 1839201
      },
      "imageScale": {
        "points": [
          { "x": 0.13, "y": 0.84 },
          { "x": 0.38, "y": 0.84 }
        ],
        "distanceMeters": 3.5
      },
      "rooms": [
        {
          "id": "living",
          "name": "客厅",
          "polygon": [
            { "x": 0.12, "y": 0.08 },
            { "x": 0.42, "y": 0.08 },
            { "x": 0.42, "y": 0.36 }
          ]
        }
      ],
      "devices": [
        {
          "deviceId": "humidifier_1",
          "x": 0.2,
          "y": 0.22,
          "height": 1.2,
          "roomId": "living"
        }
      ]
    }
  ]
}
```

- `x/y` 是 0～1 的归一化图像坐标。
- `height` 是设备离地高度（米），派生为物理坐标的 `z`。
- 同一设备最多属于一个户型。

## 3. 比例尺与坐标计算

设图片原始尺寸为 `W × H`，比例尺两点为 `a/b`，实际长度为 `D` 米：

```text
pixelDistance = hypot((b.x-a.x) * W, (b.y-a.y) * H)
metersPerPixel = D / pixelDistance

physicalX = device.x * W * metersPerPixel
physicalY = device.y * H * metersPerPixel
physicalZ = device.height ?? 0
```

生成的设备属性：

```json
{
  "placement": {
    "room": "客厅",
    "coordinates": {
      "x": 2.48,
      "y": 1.536,
      "z": 1.2,
      "unit": "m",
      "frame": "floorplan_image",
      "floorplanId": "floor1",
      "source": "floorplan"
    }
  }
}
```

坐标原点位于图片左上角，`x` 向右、`y` 向下、`z` 向上。未来距离逻辑必须先确认双方 `unit/frame/floorplanId` 一致。

## 4. 保存与协调

- 前端使用相同公式提供实时预览；后端重新计算并作为可信结果。
- 有设备的户型必须具备图片宽高和有效比例尺。
- API Gateway 从所有户型构建 `deviceId -> { room, coordinates }` 映射，并批量更新普通设备覆盖和 `voice_control.mics[]`。
- `roomId` 通过当前户型的房间表解析为房间名称并写入 `placement.room`；移动设备或重命名房间时自动更新。
- 首次协调仅接管空值或 `unknown_room`；用户后续手工修改 `placement.room` 后，协调逻辑保留手工值。
- 当前户型中的设备坐标覆盖已有手工坐标；设备移出全部户型后，仅删除 `source=floorplan` 的坐标。
- `GET /devices` 与 `GET /devices/:id` 直接合并最新覆盖配置，不等待 Adapter 热加载。
- 启动协调用于修复跨文件写入中断或旧数据未同步的情况。

## 5. API 与校验

- `GET/POST/PUT/DELETE /floorplans`：户型 CRUD。
- `POST /assets`：仅接受 `kind=floorplan_image` 的 PNG/JPG。
- `GET /devices/:id`：设备已布点时返回完整 `placement.coordinates`。
- 坐标数字必须有限；`source=floorplan` 时必须同时包含 `x/y/z/unit/frame/floorplanId`。
- 房间多边形至少三个点，所有归一化坐标必须位于 0～1，设备高度不得小于零。

## 6. 兼容策略

- 读取旧版户型时忽略 `model/modelTransform/calibrationPoints` 和设备 `rotation/scale`。
- 下一次保存写入版本 2，旧字段不再落盘。
- 不自动删除历史 GLB 文件，避免破坏性数据清理。
- 旧的无比例尺户型允许加载；只有补齐比例尺后才能保存包含设备的配置。
