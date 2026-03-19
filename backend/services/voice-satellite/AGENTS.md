# AGENTS – Voice Satellite (Offline Voice I/O)

职责：语音入口服务（主机端常驻进程）。支持两种模式：
- **本地模式**：主机直接使用本地麦克风/音箱。
- **远端卫星模式**：远端设备本地做唤醒词，通过 WebSocket 把 PCM 音频发送到主机，主机完成 VAD/STT/Agent/TTS 并回传 PCM。

完成：
- **唤醒词**（Vosk，支持配置多个短语）
- **端点检测**（silero-vad，离线 VAD）
- **语音转文字 STT**（Whisper，本地模型文件）
- **文字转语音 TTS**（Piper，本地模型文件 + 本地二进制）
- **与智能家居大脑对接**：把文本发送到 `smart-house-agent` 的 `POST /v1/agent/turn`，并把响应播报；对 `executed/propose` 等包含动作的输出，额外用确定性模板播报“执行了哪些设备/动作”。

约定
- 运行时不访问任何云服务；仅访问本机/局域网 HTTP（默认 `localhost`）。
- 当前仓库默认要求 `voice-satellite` 在 Docker 中使用 NVIDIA GPU 运行 Whisper；`stt.device` 默认应为 `cuda`，启动时会强校验 CUDA 可用性。
- 不增加二次 LLM 调用：语音播报的“执行内容”来自 agent 的 `actions/result` 结构化结果 + 本地设备名映射（`api-gateway /devices`）。
- 唤醒词可配置，默认 `"你好，米奇"`。
- 远端卫星模式的主机接口是 WebSocket，当前固定音频格式为 `PCM s16le / mono / 16kHz / 512 samples per frame`。
- ws 卫星必须先登记到共享 `devices.config.json` 的 `voice_control.mics[]`；`mic.id` 必须等于卫星 `hello.deviceId`，且必须提供 `placement.room`。
- 远端卫星模式下，主机转发到 Agent 时会附带 `wakeSource={ transport, deviceId, placement }`，供 Agent 按唤醒设备所在房间解析省略指令。
- 远端卫星模式下，主机侧会在 VAD 判定一句话结束后主动下发 `stop_capture`，设备收到后应尽快结束 uplink 并发送 `audio_end`。

运行
- 配置文件：`config.yaml`（参考 `config.example.yaml`），启动：
  - `backend/services/voice-satellite/run.sh --config backend/services/voice-satellite/config.yaml`
- 依赖：见 `requirements.txt`；另需安装 `piper` 可执行文件并准备 Piper voice 模型（`.onnx` + `.json`）。
