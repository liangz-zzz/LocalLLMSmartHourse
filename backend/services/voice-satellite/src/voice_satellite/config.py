from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

import yaml


@dataclass(frozen=True)
class BeepConfig:
    enabled: bool = True
    frequency_hz: int = 880
    duration_ms: int = 120
    volume: float = 0.2


@dataclass(frozen=True)
class AudioConfig:
    sample_rate: int = 16000
    block_size: int = 512
    input_device: Optional[Any] = None
    output_device: Optional[Any] = None
    input_backend: str = "sounddevice"  # sounddevice | pulse | auto
    output_backend: str = "sounddevice"  # sounddevice | pulse | auto
    pulse_source: str = "default"
    beep: BeepConfig = BeepConfig()


@dataclass(frozen=True)
class VoskConfig:
    model_path: str = ""


@dataclass(frozen=True)
class WakeConfig:
    phrases: list[str]
    vosk: VoskConfig
    cooldown_ms: int = 350
    timeout_ms: int = 8000


@dataclass(frozen=True)
class VadConfig:
    threshold: float = 0.55
    end_silence_ms: int = 700
    pre_roll_ms: int = 400
    max_utterance_ms: int = 20000
    min_utterance_ms: int = 300


@dataclass(frozen=True)
class SttConfig:
    whisper_model: str = ""
    language: str = "zh"
    device: str = "cpu"  # cpu | cuda


@dataclass(frozen=True)
class TtsConfig:
    piper_bin: str = "piper"
    model_path: str = ""
    config_path: str = ""
    speaker: Optional[int] = None


@dataclass(frozen=True)
class ApiGatewayConfig:
    base_url: str = "http://localhost:4000"
    api_key: str = ""


@dataclass(frozen=True)
class AgentConfig:
    base_url: str = "http://localhost:6100"
    timeout_s: int = 30
    confirm_phrases: list[str] = None  # type: ignore[assignment]
    cancel_phrases: list[str] = None  # type: ignore[assignment]
    exit_phrases: list[str] = None  # type: ignore[assignment]


@dataclass(frozen=True)
class RuntimeConfig:
    session_idle_timeout_ms: int = 30000
    log_level: str = "info"


@dataclass(frozen=True)
class AppConfig:
    audio: AudioConfig
    wake: WakeConfig
    vad: VadConfig
    stt: SttConfig
    tts: TtsConfig
    api_gateway: ApiGatewayConfig
    agent: AgentConfig
    runtime: RuntimeConfig


def load_config(path: str) -> AppConfig:
    with open(path, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}

    audio_raw = raw.get("audio") or {}
    beep_raw = (audio_raw.get("beep") or {}) if isinstance(audio_raw, dict) else {}
    audio = AudioConfig(
        sample_rate=int(audio_raw.get("sample_rate") or 16000),
        block_size=int(audio_raw.get("block_size") or 512),
        input_device=audio_raw.get("input_device"),
        output_device=audio_raw.get("output_device"),
        input_backend=str(audio_raw.get("input_backend") or "sounddevice"),
        output_backend=str(audio_raw.get("output_backend") or "sounddevice"),
        pulse_source=str(audio_raw.get("pulse_source") or "default"),
        beep=BeepConfig(
            enabled=bool(beep_raw.get("enabled", True)),
            frequency_hz=int(beep_raw.get("frequency_hz") or 880),
            duration_ms=int(beep_raw.get("duration_ms") or 120),
            volume=float(beep_raw.get("volume") or 0.2),
        ),
    )

    wake_raw = raw.get("wake") or {}
    phrases = list(wake_raw.get("phrases") or ["老管家"])
    vosk_raw = wake_raw.get("vosk") or {}
    wake = WakeConfig(
        phrases=[str(p) for p in phrases if str(p).strip()],
        vosk=VoskConfig(model_path=str(vosk_raw.get("model_path") or "")),
        cooldown_ms=int(wake_raw.get("cooldown_ms") or 350),
        timeout_ms=int(wake_raw.get("timeout_ms") or 8000),
    )

    vad_raw = raw.get("vad") or {}
    vad = VadConfig(
        threshold=float(vad_raw.get("threshold") or 0.55),
        end_silence_ms=int(vad_raw.get("end_silence_ms") or 700),
        pre_roll_ms=int(vad_raw.get("pre_roll_ms") or 400),
        max_utterance_ms=int(vad_raw.get("max_utterance_ms") or 20000),
        min_utterance_ms=int(vad_raw.get("min_utterance_ms") or 300),
    )

    stt_raw = raw.get("stt") or {}
    stt = SttConfig(
        whisper_model=str(stt_raw.get("whisper_model") or ""),
        language=str(stt_raw.get("language") or "zh"),
        device=str(stt_raw.get("device") or "cpu"),
    )

    tts_raw = raw.get("tts") or {}
    speaker = tts_raw.get("speaker", None)
    tts = TtsConfig(
        piper_bin=str(tts_raw.get("piper_bin") or "piper"),
        model_path=str(tts_raw.get("model_path") or ""),
        config_path=str(tts_raw.get("config_path") or ""),
        speaker=int(speaker) if speaker is not None else None,
    )

    api_raw = raw.get("api_gateway") or {}
    api_gateway = ApiGatewayConfig(base_url=str(api_raw.get("base_url") or "http://localhost:4000"), api_key=str(api_raw.get("api_key") or ""))

    agent_raw = raw.get("agent") or {}
    agent = AgentConfig(
        base_url=str(agent_raw.get("base_url") or "http://localhost:6100"),
        timeout_s=int(agent_raw.get("timeout_s") or 30),
        confirm_phrases=list(agent_raw.get("confirm_phrases") or ["确认", "执行", "是", "好的", "可以"]),
        cancel_phrases=list(agent_raw.get("cancel_phrases") or ["取消", "不要", "算了", "停止"]),
        exit_phrases=list(agent_raw.get("exit_phrases") or ["再见", "拜拜"]),
    )

    runtime_raw = raw.get("runtime") or {}
    runtime = RuntimeConfig(
        session_idle_timeout_ms=int(runtime_raw.get("session_idle_timeout_ms") or 30000),
        log_level=str(runtime_raw.get("log_level") or "info"),
    )

    if not wake.vosk.model_path:
        raise SystemExit("Missing required config: wake.vosk.model_path")
    if not stt.whisper_model:
        raise SystemExit("Missing required config: stt.whisper_model")
    if not tts.model_path or not tts.config_path:
        raise SystemExit("Missing required config: tts.model_path / tts.config_path")

    return AppConfig(
        audio=audio,
        wake=wake,
        vad=vad,
        stt=stt,
        tts=tts,
        api_gateway=api_gateway,
        agent=agent,
        runtime=runtime,
    )
