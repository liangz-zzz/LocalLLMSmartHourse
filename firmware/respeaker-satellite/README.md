# ReSpeaker Satellite Firmware

这个工程是 `XIAO ESP32S3 + ReSpeaker Lite` 的设备端固件骨架，目标是让设备作为独立供电的远端语音终端运行。

当前阶段已完成：
- `ESP-IDF` 工程结构
- `Wi-Fi` 站点模式连接
- `WebSocket` 客户端连接主机侧 `voice-satellite ws_server`
- 上线后自动发送 `hello`
- 周期性发送 `ping`
- 接收并解析主机侧 `hello_ack / listening / transcript / tts_* / session_closed / error`
- `tts_chunk` 的 base64 解码与 `I2S` 播放
- `I2S` 真机录放底座，按 `GPIO8/7/43/44` 对接 `ReSpeaker Lite`
- 串口手动联调入口：本地音调测试、手动 `wake + audio_*` 上传
- 固定唤醒词配置项（仓库内默认占位值，真实值建议只放本地覆盖文件）

当前阶段尚未完成：
- 真正的本地唤醒词引擎（建议后续接 `ESP-SR / WakeNet`）
- 自动 `wake -> audio_*` 状态机

## 你现在是否需要 Wi-Fi 密码？

真实联网测试时当然需要，但**不需要把密码、真实唤醒词、真实 device id 写进仓库**。这个工程把它们做成配置项，并支持本地忽略文件：

- `SATELLITE_WIFI_SSID`
- `SATELLITE_WIFI_PASSWORD`
- `SATELLITE_WS_URL`
- `SATELLITE_DEVICE_ID`
- `SATELLITE_AUTH_TOKEN`
- `SATELLITE_WAKE_WORD`

推荐方式：

```bash
cd firmware/respeaker-satellite
cp sdkconfig.defaults.local.example sdkconfig.defaults.local
```

然后把真实值填进 `sdkconfig.defaults.local`。这个文件已加入 `.gitignore`，不会进仓库。

后续你只需要在本地执行：

```bash
cd firmware/respeaker-satellite
idf.py set-target esp32s3
idf.py menuconfig
idf.py build
idf.py -p /dev/ttyACM0 flash monitor
```

刷机后串口测试命令：

```text
p  # 本地 440Hz 测试音
w  # 发送 wake，然后采 4 秒麦克风音频上传到主机
h  # 打印帮助
```

`w` 这条测试链路依赖两件事：
- 主机侧 `voice-satellite` 已以 `ws_server` 模式运行
- `XMOS/ReSpeaker Lite` 已刷成 `I2S firmware`

## 当前固定唤醒词

仓库里的默认值只是占位：

```text
你好，小屋
```

真实唤醒词应通过 `sdkconfig.defaults.local` 或 `idf.py menuconfig` 在本地覆盖。

## 硬件口说明

- 刷这个固件：使用“远离耳机孔”的 `ESP32-S3` USB-C 口
- `XMOS/ReSpeaker Lite` 固件确认：后续临时切到“靠近耳机孔”的口，确认/刷成 `I2S firmware`
- 最终运行：设备脱离电脑，只接电源供电
