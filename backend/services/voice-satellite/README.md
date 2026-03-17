# Voice Satellite（离线语音入口）

目标：在主机侧完成 VAD + STT + TTS，并把文本对话交给现有 `smart-house-agent`。服务支持：
- `local`：主机本地麦克风/音箱模式。
- `ws_server`：远端语音终端通过 WebSocket 发送/接收 PCM 音频，适合 `ESP32 + ReSpeaker Lite` 一类设备。

## 数据流

1. **IDLE**：持续监听唤醒词（Vosk grammar，仅 `local` 模式）
2. 唤醒后进入 **LISTEN**：silero-vad 识别一句话的开始/结束
3. 对该句音频做 **Whisper STT** → 得到文本
4. 调用 `POST http://localhost:6100/v1/agent/turn`
5. 将 `out.message` 播报；若包含 `actions/result`，额外播报“执行了哪些设备/动作”（确定性模板）
6. 在同一 `sessionId` 下继续多轮（直到超时回到 IDLE 或用户说“再见/拜拜/退下”等退出词）

## 快速开始（主机运行）

1) 安装系统依赖（示例：Debian/Ubuntu）
- `sudo apt-get update && sudo apt-get install -y ffmpeg`

2) 创建 Python venv 并安装依赖
- `python -m venv .venv && source .venv/bin/activate`
- `pip install -r backend/services/voice-satellite/requirements.txt`

3) 准备本地模型/资源（必须离线可用）
- Vosk 中文模型目录：例如 `vosk-model-small-cn-0.22/`
- Whisper 模型文件：例如 `whisper-small.pt`（本地路径）
- Piper：安装 `piper` 二进制；准备 voice 的 `*.onnx` + `*.json`

4) 复制并修改配置
- `cp backend/services/voice-satellite/config.example.yaml backend/services/voice-satellite/config.yaml`
- 修改 `mode`、`vosk.model_path / stt.whisper_model / tts.piper_*` 等路径

5) 启动（确保 `api-gateway / smart-house-agent` 已在本机可访问）
- `backend/services/voice-satellite/run.sh --config backend/services/voice-satellite/config.yaml`

## Docker 运行（Linux，免宿主 Python 环境）

说明：
- 仍需你自行准备本地模型文件（Vosk/Whisper/Piper voice），并在 `config.yaml` 指向容器内路径（建议统一挂载到 `/models`）。
- 需要宿主可用的音频设备；compose 已尝试透传 `/dev/snd`（ALSA）。如果你用 PipeWire/PulseAudio，可能需要额外配置。

1) 准备 `config.yaml`
- `cp backend/services/voice-satellite/config.example.yaml backend/services/voice-satellite/config.yaml`
- 把模型路径改成容器内路径（例如 `/models/...`）

2) 启动（profile `voice`）
- `docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.autostart.yml --profile voice up -d --build voice-satellite`

## 远端卫星模式（WebSocket）

当 `mode: "ws_server"` 时，主机不再打开本地麦克风/音箱，而是监听 WebSocket：

- `satellite_server.host / port / path`
- 音频格式固定为 `pcm_s16le, mono, 16kHz`
- 每个输入帧默认按 `512 samples` 切块做流式 VAD

最小消息协议：

- 设备 -> 主机
  - `hello`：`deviceId / authToken / encoding / sampleRate / channels`
  - `wake`
  - `audio_start`
  - `audio_chunk`：JSON 文本帧，`data` 为 base64 编码 PCM
  - `audio_end`
  - `ping`
- 主机 -> 设备
  - `hello_ack`
  - `listening`
  - `transcript`
  - `tts_start`
  - `tts_chunk`
  - `tts_end`
  - `session_closed`
  - `error`
  - `pong`

推荐接入方式：
- 设备本地只做唤醒词和音频采集/播放。
- 主机负责一句话的 VAD 断句、Whisper STT、Agent 调用和 Piper TTS。
- 设备在 `wake` 之后开始上行音频；主机识别出一句话后回传 TTS 音频，设备播放即可。

## PulseAudio（Ubuntu Desktop）

如果麦克风被系统音频服务占用（例如 USB 摄像头麦克风），推荐使用 PulseAudio 输入：

- `config.yaml` 里设置：
  - `audio.input_backend: "pulse"`
  - `audio.pulse_source: "default"`（或指定 `pactl list sources` 中的名称）
  - 可选：`audio.output_backend: "pulse"` 让播报走系统默认输出
- `deploy/docker-compose.yml` 已挂载：
  - `/run/user/$LOCAL_UID/pulse` → 容器同路径
  - `$HOME/.config/pulse` → `/home/app/.config/pulse`
  - `PULSE_COOKIE=/home/app/.config/pulse/cookie`（避免找不到认证 cookie）

手动 `docker run` 时需自行挂载以上路径并设置 `PULSE_SERVER=unix:/run/user/$UID/pulse/native`（必要时加 `PULSE_COOKIE=/home/app/.config/pulse/cookie`）。

## 说明：为什么不再调用一次 LLM

语音播报“执行了什么”默认用确定性模板从 `out.actions/out.result` 生成，优点：
- 更快、更稳定、可测试
- 不会把“计划/猜测”说成“已执行”
- 离线场景不额外消耗模型算力
