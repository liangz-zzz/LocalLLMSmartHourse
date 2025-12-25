# AGENTS – Voice Satellite (Offline Voice I/O)

职责：本地语音入口（主机端常驻进程）。完成：
- **唤醒词**（Vosk，支持配置多个短语）
- **端点检测**（silero-vad，离线 VAD）
- **语音转文字 STT**（Whisper，本地模型文件）
- **文字转语音 TTS**（Piper，本地模型文件 + 本地二进制）
- **与智能家居大脑对接**：把文本发送到 `smart-house-agent` 的 `POST /v1/agent/turn`，并把响应播报；对 `executed/propose` 等包含动作的输出，额外用确定性模板播报“执行了哪些设备/动作”。

约定
- 运行时不访问任何云服务；仅访问本机/局域网 HTTP（默认 `localhost`）。
- 不增加二次 LLM 调用：语音播报的“执行内容”来自 agent 的 `actions/result` 结构化结果 + 本地设备名映射（`api-gateway /devices`）。
- 唤醒词可配置，默认 `"老管家"`。

运行
- 配置文件：`config.yaml`（参考 `config.example.yaml`），启动：
  - `backend/services/voice-satellite/run.sh --config backend/services/voice-satellite/config.yaml`
- 依赖：见 `requirements.txt`；另需安装 `piper` 可执行文件并准备 Piper voice 模型（`.onnx` + `.json`）。
