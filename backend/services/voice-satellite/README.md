# Voice Satellite（离线语音入口）

目标：在主机本地完成唤醒词 + 端点检测 + STT + TTS，并把文本对话交给现有 `smart-house-agent`。

## 数据流

1. **IDLE**：持续监听唤醒词（Vosk grammar）
2. 唤醒后进入 **LISTEN**：silero-vad 识别一句话的开始/结束
3. 对该句音频做 **Whisper STT** → 得到文本
4. 调用 `POST http://localhost:6100/v1/agent/turn`
5. 将 `out.message` 播报；若包含 `actions/result`，额外播报“执行了哪些设备/动作”（确定性模板）
6. 在同一 `sessionId` 下继续多轮（直到超时回到 IDLE 或用户说“再见/拜拜”）

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
- 修改 `vosk.model_path / stt.whisper_model / tts.piper_*` 等路径

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
