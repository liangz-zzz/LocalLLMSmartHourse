from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from voice_satellite.config import (  # noqa: E402
    AgentConfig,
    ApiGatewayConfig,
    AppConfig,
    AudioConfig,
    RuntimeConfig,
    SatelliteServerConfig,
    SttConfig,
    TtsConfig,
    VadConfig,
    VoskConfig,
    WakeConfig,
)
from voice_satellite.audio_types import SynthesizedAudio  # noqa: E402
from voice_satellite.common import prepare_stt_audio  # noqa: E402
from voice_satellite.remote_server import RemoteSatelliteSession  # noqa: E402


class FakeVad:
    def __init__(self, probs: list[float]):
        self.probs = list(probs)

    def probability(self, _block: np.ndarray) -> float:
        if self.probs:
            return self.probs.pop(0)
        return 0.0


class FakeStt:
    def __init__(self, texts: list[str]):
        self.texts = list(texts)

    def transcribe(self, _audio: np.ndarray, *, sample_rate: int) -> tuple[str, dict]:
        if self.texts:
            return self.texts.pop(0), {"sample_rate": sample_rate}
        return "", {"sample_rate": sample_rate}


class FakeTts:
    def __init__(self):
        self.spoken: list[str] = []

    def synthesize(self, text: str) -> SynthesizedAudio:
        self.spoken.append(text)
        pcm = (b"\x01\x02" * 1024)
        return SynthesizedAudio(sample_rate=16000, channels=1, sample_width=2, pcm_s16le=pcm)


class FakeDevices:
    def __init__(self):
        self.by_id = {"light-lr-main": {"name": "客厅主灯"}}
        self.refreshed = False

    def refresh(self) -> None:
        self.refreshed = True

    def refresh_in_background(self) -> bool:
        self.refresh()
        return True


class FakeAgent:
    def __init__(self, out: dict):
        self.out = out
        self.calls: list[dict] = []

    def turn(self, *, session_id: str, text: str, confirm: bool, wake_source: dict | None = None) -> dict:
        self.calls.append({"session_id": session_id, "text": text, "confirm": confirm, "wake_source": wake_source})
        return dict(self.out)


def make_cfg() -> AppConfig:
    return AppConfig(
        mode="ws_server",
        audio=AudioConfig(),
        wake=WakeConfig(phrases=["你好，米奇"], vosk=VoskConfig(model_path=""), cooldown_ms=350, timeout_ms=1500),
        vad=VadConfig(threshold=0.5, end_silence_ms=64, pre_roll_ms=0, max_utterance_ms=2000, min_utterance_ms=32),
        stt=SttConfig(whisper_model="/models/whisper.pt", language="zh", device="cpu"),
        tts=TtsConfig(model_path="/models/piper.onnx", config_path="/models/piper.onnx.json"),
        api_gateway=ApiGatewayConfig(),
        device_config_path="/config/devices.config.json",
        agent=AgentConfig(
            base_url="http://localhost:6100",
            timeout_s=30,
            confirm_phrases=["确认"],
            cancel_phrases=["取消"],
            exit_phrases=["再见"],
        ),
        runtime=RuntimeConfig(session_idle_timeout_ms=5000, log_level="error"),
        satellite_server=SatelliteServerConfig(),
    )


class RemoteSessionTest(unittest.IsolatedAsyncioTestCase):
    async def test_remote_session_produces_tts_after_audio(self) -> None:
        cfg = make_cfg()
        devices = FakeDevices()
        agent = FakeAgent(
            {
                "type": "executed",
                "message": "好的",
                "actions": [{"deviceId": "light-lr-main", "action": "turn_on"}],
                "result": {"results": [{"deviceId": "light-lr-main", "action": "turn_on", "ok": True}]},
            }
        )
        tts = FakeTts()
        session = RemoteSatelliteSession(
            device_id="living-room-respeaker",
            placement={"room": "living_room", "zone": "sofa"},
            cfg=cfg,
            logger=type("L", (), {"info": lambda *a, **k: None, "debug": lambda *a, **k: None, "warn": lambda *a, **k: None, "error": lambda *a, **k: None})(),
            devices=devices,
            agent=agent,
            stt=FakeStt(["打开客厅主灯"]),
            tts=tts,
            vad_factory=lambda: FakeVad([0.9, 0.9, 0.1, 0.1]),
        )

        listening = await session.start_session()
        self.assertEqual(listening[0]["type"], "listening")
        self.assertTrue(devices.refreshed)

        pcm = (np.ones(512 * 4, dtype=np.int16) * 1024).tobytes()
        stop_events = await session.ingest_audio_chunk(pcm)
        events = await session.finalize_audio()
        event_types = [event["type"] for event in events]

        self.assertEqual(stop_events[0]["type"], "stop_capture")
        self.assertIn("transcript", event_types)
        self.assertIn("tts_start", event_types)
        self.assertIn("tts_chunk", event_types)
        self.assertIn("tts_end", event_types)
        self.assertEqual(agent.calls[0]["text"], "打开客厅主灯")
        self.assertEqual(agent.calls[0]["wake_source"]["deviceId"], "living-room-respeaker")
        self.assertEqual(agent.calls[0]["wake_source"]["placement"]["room"], "living_room")
        self.assertEqual(tts.spoken[0], "已提交执行：打开客厅主灯。好的")
        self.assertEqual(session.state, "LISTEN")
        self.assertIsNotNone(session.session_id)

    async def test_exit_phrase_closes_session(self) -> None:
        cfg = make_cfg()
        agent = FakeAgent({"type": "answer", "message": "不应调用"})
        session = RemoteSatelliteSession(
            device_id="living-room-respeaker",
            placement={"room": "living_room"},
            cfg=cfg,
            logger=type("L", (), {"info": lambda *a, **k: None, "debug": lambda *a, **k: None, "warn": lambda *a, **k: None, "error": lambda *a, **k: None})(),
            devices=FakeDevices(),
            agent=agent,
            stt=FakeStt(["再见"]),
            tts=FakeTts(),
            vad_factory=lambda: FakeVad([0.9, 0.9, 0.1, 0.1]),
        )

        await session.start_session()
        pcm = (np.ones(512 * 4, dtype=np.int16) * 512).tobytes()
        stop_events = await session.ingest_audio_chunk(pcm)
        events = await session.finalize_audio()
        event_types = [event["type"] for event in events]

        self.assertEqual(stop_events[0]["type"], "stop_capture")
        self.assertIn("session_closed", event_types)
        self.assertEqual(agent.calls, [])
        self.assertEqual(session.state, "IDLE")

    async def test_tts_audio_is_normalized_to_16k_mono(self) -> None:
        cfg = make_cfg()
        session = RemoteSatelliteSession(
            device_id="living-room-respeaker",
            placement={"room": "living_room"},
            cfg=cfg,
            logger=type("L", (), {"info": lambda *a, **k: None, "debug": lambda *a, **k: None, "warn": lambda *a, **k: None, "error": lambda *a, **k: None})(),
            devices=FakeDevices(),
            agent=FakeAgent({"type": "answer", "message": "ok"}),
            stt=FakeStt([""]),
            tts=FakeTts(),
            vad_factory=lambda: FakeVad([0.0]),
        )

        stereo = np.arange(0, 22050 * 2, dtype=np.int16).reshape(-1, 2)
        audio = SynthesizedAudio(sample_rate=22050, channels=2, sample_width=2, pcm_s16le=stereo.tobytes())
        normalized = session._normalize_tts_audio(audio)

        self.assertEqual(normalized.sample_rate, 16000)
        self.assertEqual(normalized.channels, 1)
        self.assertEqual(normalized.sample_width, 2)
        self.assertGreater(len(normalized.pcm_s16le), 0)
        self.assertNotEqual(len(normalized.pcm_s16le), len(audio.pcm_s16le))

    async def test_remote_session_waits_until_audio_end_before_transcribing(self) -> None:
        cfg = make_cfg()
        stt = FakeStt(["打开客厅主灯"])
        session = RemoteSatelliteSession(
            device_id="living-room-respeaker",
            placement={"room": "living_room"},
            cfg=cfg,
            logger=type("L", (), {"info": lambda *a, **k: None, "debug": lambda *a, **k: None, "warn": lambda *a, **k: None, "error": lambda *a, **k: None})(),
            devices=FakeDevices(),
            agent=FakeAgent({"type": "answer", "message": "ok"}),
            stt=stt,
            tts=FakeTts(),
            vad_factory=lambda: FakeVad([0.9, 0.9, 0.1, 0.1]),
        )

        await session.start_session()
        pcm = (np.ones(512 * 4, dtype=np.int16) * 1024).tobytes()
        events = await session.ingest_audio_chunk(pcm)

        self.assertEqual(events[0]["type"], "stop_capture")
        self.assertEqual(stt.texts, ["打开客厅主灯"])
        self.assertEqual(session.state, "WAIT_AUDIO_END")

        await session.finalize_audio()
        self.assertEqual(stt.texts, [])

    def test_prepare_stt_audio_removes_dc_and_normalizes(self) -> None:
        audio = np.linspace(-0.1, 0.12, num=1600, dtype=np.float32) + 0.2
        prepared, stats = prepare_stt_audio(audio)

        self.assertEqual(prepared.dtype, np.float32)
        self.assertLess(abs(float(prepared.mean())), 1e-3)
        self.assertGreater(float(stats["peak"]), 0.3)
        self.assertLessEqual(float(stats["peak"]), 1.0)
        self.assertGreaterEqual(float(stats["gain"]), 1.0)


if __name__ == "__main__":
    unittest.main()
