# Voice Assistant（离线语音入口）

目标：在主机本地实现“唤醒词 → 语音对话 → 智能设备查询/控制 → 语音播报”的闭环，且 **不依赖云服务**。

## 组件与职责

- 唤醒词：Vosk（关键词/短语 grammar），唤醒词可配置，默认 `你好，米奇`
- 端点检测：silero-vad（更准的 VAD，用于一句话的开始/结束）
- STT：Whisper（本地模型文件）
- TTS：Piper（本地模型文件 + 本地二进制）
- 对话与执行：`smart-house-agent` + `smart-house-mcp-server`（工具）+ `api-gateway`（事实/副作用）

## 数据流（运行时）

```
Mic
  -> (IDLE) Vosk wake phrase
  -> (LISTEN) silero-vad chunking
  -> Whisper STT -> text
  -> POST smart-house-agent /v1/agent/turn
  -> speech text (message + deterministic action summary)
  -> Piper TTS -> Speaker
  -> （用户说“再见/拜拜/退下”等退出词会结束会话，回到唤醒词监听）
```

## 与 Agent 的交互约定

语音端只发文本给 Agent：
- `POST http://localhost:6100/v1/agent/turn`
- `{ "input": "<STT文本>", "sessionId": "<本次唤醒会话id>" }`

语音端的播报规则：
- `type=answer/clarify/error/canceled`：播报 `out.message`
- `type=propose`：播报 `out.message`，并 **额外播报** “我准备执行：<设备+动作>”
- `type=executed`：播报 **确定性动作摘要**（来自 `out.actions/out.result`），避免二次 LLM 调用与“说错执行内容”

动作摘要的设备名优先来自 `api-gateway GET /devices`（只读，无副作用）。

## 运行（主机）

实现位于：`backend/services/voice-satellite/`

- 参考 `backend/services/voice-satellite/README.md`
- 推荐启动：`backend/services/voice-satellite/run.sh --config backend/services/voice-satellite/config.yaml`
- Docker（Linux）可选：`docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.autostart.yml --profile voice up -d --build voice-satellite`
