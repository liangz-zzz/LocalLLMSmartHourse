# 户型编辑与 3D 预览设计

版本：v0.1（2026-01-04）

## 1. 总体思路
- 2D 视图作为编辑入口（房间边界 + 设备位置/高度），3D 视图仅用于预览。
- 通过三点校准建立 2D 坐标到 3D 地面的映射，避免依赖模型内部坐标约定。
- 资产与配置均落在本机 `CONFIG_DIR`，以 JSON 文件为事实来源。

## 2. 配置与存储
- 配置文件：`floorplans.json`。
- 路径：`FLOORPLANS_PATH=${CONFIG_DIR}/floorplans.json`（默认 `./floorplans.json`）。
- 资产目录：`ASSETS_DIR=${CONFIG_DIR}/assets`，户型相关放在 `assets/floorplans/`。
- API Gateway 负责读写与校验；写入使用“临时文件 + rename”原子落盘。

## 3. 数据模型
### 3.1 floorplans.json
```json
{
  "version": 1,
  "floorplans": [
    {
      "id": "floor1",
      "name": "一层",
      "image": {
        "assetId": "asset_20260104_001",
        "url": "/assets/floorplans/floor1.png",
        "width": 2048,
        "height": 1536,
        "mime": "image/png",
        "size": 1839201
      },
      "model": {
        "assetId": "asset_20260104_002",
        "url": "/assets/floorplans/floor1.glb",
        "mime": "model/gltf-binary",
        "size": 32891212
      },
      "modelTransform": {
        "matrix": [1.2, 0.0, 0.0, 1.1],
        "translate": { "x": -3.2, "z": 4.8 }
      },
      "calibrationPoints": {
        "image": [
          { "x": 0.12, "y": 0.08 },
          { "x": 0.84, "y": 0.12 },
          { "x": 0.18, "y": 0.78 }
        ],
        "model": [
          { "x": -6.0, "y": 0.0, "z": 5.0 },
          { "x": 6.5, "y": 0.0, "z": 5.6 },
          { "x": -4.8, "y": 0.0, "z": -4.2 }
        ]
      },
      "rooms": [
        {
          "id": "living",
          "name": "客厅",
          "polygon": [
            { "x": 0.12, "y": 0.08 },
            { "x": 0.42, "y": 0.08 },
            { "x": 0.42, "y": 0.36 },
            { "x": 0.12, "y": 0.36 }
          ]
        }
      ],
      "devices": [
        {
          "deviceId": "humidifier_1",
          "x": 0.2,
          "y": 0.22,
          "height": 1.2,
          "rotation": 0,
          "scale": 1,
          "roomId": "living"
        }
      ]
    }
  ]
}
```

### 3.2 坐标与单位
- 2D 坐标为归一化值（0~1），原点位于左上角，`x` 向右，`y` 向下。
- 3D 坐标以 GLB 世界坐标为准，地面平面使用 `x/z`，`y` 为高度。
- `height` 单位为米（支持小数）。

## 4. 三点校准
- 用户在 2D 与 3D 视图中分别选择 3 个对应点（需非共线）。
- 计算 2D 到 3D 平面映射（仿射变换）：
  - 设 2D 点 `u1/u2/u3`，3D 点 `v1/v2/v3`（仅取 `x/z`）。
  - `M = [v2 - v1, v3 - v1] * inverse([u2 - u1, u3 - u1])`
  - `T = v1 - M * u1`
  - 任意点映射：`[x, z] = M * [u, v] + T`
- 变换结果写入 `modelTransform`；`calibrationPoints` 可保留用于二次编辑。
- PNG 或 GLB 更新后需重新校准，`modelTransform` 置空或标记失效。

## 5. 房间归属判定
- 使用 point-in-polygon（射线法或绕行法）判断设备中心点所在房间。
- 多个房间重叠时选择面积最小者；若无匹配则 `roomId` 为空。

## 6. API 设计（API Gateway）
- `GET /floorplans`：返回户型列表（含 `id/name/image/model` 概览）。
- `GET /floorplans/:id`：返回完整户型配置。
- `POST /floorplans`：创建户型（校验 + 持久化）。
- `PUT /floorplans/:id`：更新户型（校验 + 持久化）。
- `DELETE /floorplans/:id`：删除户型。
- `POST /assets`：上传 PNG/JPG/GLB，返回 `url` 与元信息。

## 7. 上传与静态资源
- `POST /assets` 使用 multipart/form-data：`file` + `kind=floorplan_image|floorplan_model`。
- 后端落盘到 `ASSETS_DIR/floorplans/` 并返回 `/assets/...` URL。
- 默认限制：PNG/JPG 20MB、GLB 200MB；支持配置覆盖。

## 8. 校验与错误
- `id` 唯一，`rooms` 多边形至少 3 点，坐标必须在 0~1。
- `devices` 坐标必须在 0~1，`height >= 0`。
- 错误码建议：`floorplan_exists`、`floorplan_not_found`、`invalid_floorplan`、`asset_invalid`、`payload_too_large`。

## 9. 预览与状态联动
- 视图模式订阅 `/ws` 设备状态；编辑模式可暂停订阅。
- 场景预览读取 `/scenes` 与 `/scenes/:id/expanded`，仅显示视觉效果。
- 执行场景需显式按钮 + 二次确认。

## 10. 实现建议（Frontend + Compose）
### 10.1 前端页面与交互
- 新增页面：`/floorplan`（Next.js 页面）。
- 模式切换：视图 / 房间编辑 / 设备编辑 / 校准。
- 2D 编辑：
  - 背景底图加载 `image.url`。
  - 房间编辑：点击绘制多边形，闭合后命名；可拖拽顶点、删除房间。
  - 设备编辑：设备列表拖入或点选拖拽；支持旋转、缩放与高度编辑（m，小数）。
  - 拖拽结束后执行 point-in-polygon，自动更新 `roomId`。
- 3D 预览：
  - 使用 GLB 加载 `model.url`。
  - 校准完成后，将 2D 坐标映射到 3D `x/z`，`height` 映射到 `y`。
  - 设备效果采用标记/光晕/颜色叠加，首期不依赖模型内部动画。
- 校准模式：
  - 2D/3D 各选择 3 点；校准后保存 `modelTransform` 与 `calibrationPoints`。
  - PNG/GLB 更新时标记校准失效，强制重新校准。

### 10.2 前端数据流
- 资产上传：`POST /assets`（multipart/form-data），返回 `url` 后写入 `floorplans.json`。
- 读写户型：`GET/POST/PUT/DELETE /floorplans`。
- 场景预览：`GET /scenes` + `GET /scenes/:id/expanded`。
- 实时状态：视图模式订阅 `/ws`，编辑模式可暂停订阅。

### 10.3 Compose 与配置接线
- 建议在 `.env` 增加：
  - `CONFIG_DIR`（如 `./deploy/data/config`）
  - `FLOORPLANS_PATH=${CONFIG_DIR}/floorplans.json`
  - `ASSETS_DIR=${CONFIG_DIR}/assets`
  - `ASSET_MAX_IMAGE_MB=20`
  - `ASSET_MAX_MODEL_MB=200`
- `deploy/docker-compose.yml` 中为 `api-gateway` 挂载 `${CONFIG_DIR}`，并透传上述环境变量。
