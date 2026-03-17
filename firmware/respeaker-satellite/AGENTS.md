# AGENTS – ReSpeaker Satellite Firmware

目标：让 `XIAO ESP32S3 + ReSpeaker Lite` 作为独立供电的远端语音终端运行：
- 本地唤醒词
- `Wi-Fi` 连接主机
- `WebSocket` 对接主机侧 `voice-satellite ws_server`
- 后续接入 `I2S` 采音/播放

当前阶段（v0）：
- 已落固件骨架：`NVS`、`Wi-Fi`、`WebSocket hello/ping`、主机消息解析、`tts_chunk` 解码、`I2S` 录放底座、串口手动联调入口、固定唤醒词配置。
- 暂未落：WakeNet/ESP-SR、自动上行采音状态机、按钮输入。

开发约定：
- 使用 `ESP-IDF` 标准工程结构。
- 固定唤醒词当前先保留为配置项，仓库内默认值只作为占位。
- `Wi-Fi` 和 `WebSocket` 地址通过 `menuconfig` 提供，不提交真实私密值。

验证：
- 安装 `ESP-IDF` 后执行 `idf.py set-target esp32s3`
- `idf.py build`
- 刷机使用“远离耳机孔”的 `ESP32-S3` USB-C 口
