# 2D 户型编辑与设备坐标

本目录记录 2D 户型编辑、比例尺校准、房间与设备布点，以及米制坐标绑定的需求和设计。

文档索引
- `requirements.md`: 需求与验收要点。
- `design.md`: 数据模型、坐标换算、持久化与 API 设计。

复合开关面板
- 户型图只放置 `composition.role=panel` 的父设备，继电器通道不作为独立点位出现在待放置列表。
- 选中面板后，属性区内嵌左/中/右灯路：显示通断状态、硬接灯名称和 `control_relay/decoupled` 模式。
- 同一区域维护软件绑定，支持单击/双击/组合键、继电器状态触发，以及有序的多设备/多场景目标。
- 详见 `docs/feature/switch_binding/README.md`。
