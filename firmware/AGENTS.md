# AGENTS – Firmware

用途：存放设备端固件工程，当前以 `ESP32-S3 + ReSpeaker Lite` 远端语音终端为主。

约定：
- 首选 `ESP-IDF`；除非有充分理由，不在此目录引入 Arduino 风格工程。
- 不把真实 `Wi-Fi SSID/密码`、生产 token、局域网地址写入仓库；统一通过 `menuconfig`、本地 `sdkconfig` 或设备侧配网流程注入。
- 设备端默认对接主机侧 `voice-satellite ws_server`，音频格式与协议保持和仓库实现一致。
- 重大运行方式、刷机方式或硬件口说明变更时，同步更新本目录和根 `AGENTS.md`。

当前工程：
- `respeaker-satellite/`：XIAO ESP32S3 + ReSpeaker Lite 语音卫星固件骨架。
