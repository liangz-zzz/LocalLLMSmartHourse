from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import threading
import time
import uuid
import wave
from typing import Any, Callable, Optional

import numpy as np

from .agent_client import AgentClient
from .audio_types import SynthesizedAudio
from .common import (
    PROCESS_BLOCK_SIZE,
    PROCESS_SAMPLE_RATE,
    audio_stats,
    build_resampler,
    clean_user_text,
    match_short_phrase,
    normalize_for_match,
    prepare_stt_audio,
    resample_block,
    split_pcm16le_blocks,
)
from .config import AppConfig
from .devices import DeviceCatalog
from .log import Logger
from .speech import compose_speech

TTS_CHUNK_BYTES = 4096
TTS_CHUNK_PACING_SEC = TTS_CHUNK_BYTES / float(PROCESS_SAMPLE_RATE * 2)


class RemoteSatelliteSession:
    def __init__(
        self,
        *,
        device_id: str,
        cfg: AppConfig,
        logger: Logger,
        devices: DeviceCatalog,
        agent: AgentClient,
        stt: Any,
        tts: Any,
        stt_lock: Optional[threading.Lock] = None,
        vad_factory: Optional[Callable[[], Any]] = None,
    ):
        self.device_id = device_id
        self.cfg = cfg
        self.logger = logger
        self.devices = devices
        self.agent = agent
        self.stt = stt
        self.tts = tts
        self._stt_lock = stt_lock
        if vad_factory:
            self._vad = vad_factory()
        else:
            from .vad_silero import SileroVad

            self._vad = SileroVad(threshold=cfg.vad.threshold, sample_rate=PROCESS_SAMPLE_RATE)

        self.pre_roll_chunks = max(0, int(cfg.vad.pre_roll_ms / 1000 * PROCESS_SAMPLE_RATE / PROCESS_BLOCK_SIZE))
        self.end_silence_chunks = max(1, int(cfg.vad.end_silence_ms / 1000 * PROCESS_SAMPLE_RATE / PROCESS_BLOCK_SIZE))
        self.max_utt_chunks = max(1, int(cfg.vad.max_utterance_ms / 1000 * PROCESS_SAMPLE_RATE / PROCESS_BLOCK_SIZE))
        self.min_utt_chunks = max(1, int(cfg.vad.min_utterance_ms / 1000 * PROCESS_SAMPLE_RATE / PROCESS_BLOCK_SIZE))
        self.confirm_set = {normalize_for_match(s) for s in cfg.agent.confirm_phrases}
        self.cancel_set = {normalize_for_match(s) for s in cfg.agent.cancel_phrases}
        self.exit_set = {normalize_for_match(s) for s in cfg.agent.exit_phrases}

        self.state = "IDLE"
        self.session_id: Optional[str] = None
        self.wake_started_at = 0.0
        self.awaiting_first_utterance = False
        self.last_turn_at = 0.0
        self.prebuffer: list[np.ndarray] = []
        self.utterance: list[np.ndarray] = []
        self.capture_blocks: list[np.ndarray] = []
        self.speech_started = False
        self.capture_max_vad_probability = 0.0
        self.pending_pcm = bytearray()

    async def start_session(self) -> list[dict[str, Any]]:
        now = time.monotonic()
        if not self.session_id or self.state == "IDLE":
            self.session_id = f"voice-{uuid.uuid4().hex[:8]}"
        self.state = "LISTEN"
        self.wake_started_at = now
        self.last_turn_at = now
        self.awaiting_first_utterance = True
        self._reset_recording()
        try:
            await asyncio.to_thread(self.devices.refresh)
        except Exception as exc:
            self.logger.warn({"msg": "devices.refresh.failed", "device_id": self.device_id, "error": str(exc)})
        return [
            {
                "type": "listening",
                "deviceId": self.device_id,
                "sessionId": self.session_id,
                "wakeTimeoutMs": self.cfg.wake.timeout_ms,
            }
        ]

    async def tick(self) -> list[dict[str, Any]]:
        if self.state != "LISTEN" or not self.session_id:
            return []
        now = time.monotonic()
        if self.awaiting_first_utterance and self.wake_started_at and (now - self.wake_started_at) * 1000 > self.cfg.wake.timeout_ms:
            self.logger.info({"msg": "satellite.wake_timeout", "device_id": self.device_id, "session_id": self.session_id})
            return self._close_session(reason="wake_timeout")
        if self.last_turn_at and (now - self.last_turn_at) * 1000 > self.cfg.runtime.session_idle_timeout_ms:
            self.logger.info({"msg": "satellite.session_timeout", "device_id": self.device_id, "session_id": self.session_id})
            return self._close_session(reason="idle_timeout")
        return []

    async def begin_capture(self) -> list[dict[str, Any]]:
        if self.state != "LISTEN":
            return []
        self.pending_pcm.clear()
        self.capture_blocks = []
        return []

    async def ingest_audio_chunk(self, pcm_bytes: bytes) -> list[dict[str, Any]]:
        timeout_events = await self.tick()
        if timeout_events:
            return timeout_events
        if self.state != "LISTEN" or not self.session_id:
            return [{"type": "error", "code": "session_not_started", "message": "wake the device before sending audio"}]

        self.pending_pcm.extend(pcm_bytes)
        for block in split_pcm16le_blocks(self.pending_pcm, block_samples=PROCESS_BLOCK_SIZE):
            self.capture_blocks.append(block.copy())
            block_events = await self._process_block(block)
            if block_events:
                return block_events
        return []

    async def finalize_audio(self) -> list[dict[str, Any]]:
        timeout_events = await self.tick()
        if timeout_events:
            return timeout_events
        if self.state != "LISTEN":
            return []
        if not self.capture_blocks:
            self._reset_recording()
            return []
        if not self.speech_started:
            self.logger.warn(
                {
                    "msg": "satellite.vad.no_speech_fallback",
                    "device_id": self.device_id,
                    "session_id": self.session_id,
                    "chunks": len(self.capture_blocks),
                }
            )
        return await self._complete_capture()

    def _reset_recording(self) -> None:
        self.prebuffer = []
        self.utterance = []
        self.capture_blocks = []
        self.speech_started = False
        self.capture_max_vad_probability = 0.0
        self.pending_pcm.clear()

    def _close_session(self, *, reason: str) -> list[dict[str, Any]]:
        session_id = self.session_id
        self.state = "IDLE"
        self.session_id = None
        self.wake_started_at = 0.0
        self.awaiting_first_utterance = False
        self.last_turn_at = 0.0
        self._reset_recording()
        return [{"type": "session_closed", "deviceId": self.device_id, "sessionId": session_id, "reason": reason}]

    async def _process_block(self, block: np.ndarray) -> list[dict[str, Any]]:
        now = time.monotonic()
        if self.awaiting_first_utterance and self.wake_started_at and (now - self.wake_started_at) * 1000 > self.cfg.wake.timeout_ms:
            return self._close_session(reason="wake_timeout")

        prob = float(self._vad.probability(block))
        if prob > self.capture_max_vad_probability:
            self.capture_max_vad_probability = prob
        is_speech = prob >= self.cfg.vad.threshold

        if not self.speech_started:
            if is_speech:
                self.speech_started = True
                if self.awaiting_first_utterance:
                    self.awaiting_first_utterance = False
                self.last_turn_at = now
                self.logger.debug(
                    {
                        "msg": "satellite.vad.start",
                        "device_id": self.device_id,
                        "session_id": self.session_id,
                        "probability": prob,
                    }
                )
            return []

        if is_speech:
            self.last_turn_at = now
        return []

    async def _complete_capture(self) -> list[dict[str, Any]]:
        pcm = np.concatenate(self.capture_blocks).astype(np.float32) / 32768.0
        trimmed = self._trim_capture_pcm(pcm)
        self.logger.debug(
            {
                "msg": "satellite.capture.trim",
                "device_id": self.device_id,
                "session_id": self.session_id,
                "full_samples": int(pcm.size),
                "trimmed_samples": int(trimmed.size),
            }
        )
        return await self._complete_pcm(trimmed)

    async def _complete_pcm(self, pcm: np.ndarray) -> list[dict[str, Any]]:
        self.state = "SPEAK"
        self.awaiting_first_utterance = False
        try:
            stats = audio_stats(pcm)
            stt_pcm, stt_stats = prepare_stt_audio(pcm)
            self.logger.info(
                {
                    "msg": "satellite.audio.stats",
                    "device_id": self.device_id,
                    "session_id": self.session_id,
                    "vad_max_probability": self.capture_max_vad_probability,
                    **stats,
                }
            )
            self.logger.debug(
                {
                    "msg": "satellite.audio.prepared",
                    "device_id": self.device_id,
                    "session_id": self.session_id,
                    **stt_stats,
                }
            )
            text_raw, _meta = await asyncio.to_thread(self._transcribe_blocking, stt_pcm)
            text_raw = clean_user_text(text_raw)
            self.logger.info(
                {
                    "msg": "satellite.stt.done",
                    "device_id": self.device_id,
                    "session_id": self.session_id,
                    "text": text_raw,
                }
            )

            if not text_raw:
                dump_path = await asyncio.to_thread(self._dump_debug_wav, pcm)
                self.logger.warn(
                    {
                        "msg": "satellite.stt.empty",
                        "device_id": self.device_id,
                        "session_id": self.session_id,
                        "wav_path": dump_path,
                        **stats,
                    }
                )
                self.state = "LISTEN"
                self.last_turn_at = time.monotonic()
                self._reset_recording()
                return []

            match = normalize_for_match(text_raw)
            confirm = match in self.confirm_set
            cancel = match in self.cancel_set
            exit_requested = match_short_phrase(match, self.exit_set, max_extra_chars=4)
            events = [
                {
                    "type": "transcript",
                    "deviceId": self.device_id,
                    "sessionId": self.session_id,
                    "text": text_raw,
                    "confirm": bool(confirm),
                    "cancel": bool(cancel),
                }
            ]

            if exit_requested:
                events.extend(await self._build_tts_events("好的，再见。", turn_type="exit"))
                events.extend(self._close_session(reason="exit"))
                return events

            out = await asyncio.to_thread(self.agent.turn, session_id=self.session_id or "", text=text_raw, confirm=confirm)
            speech = compose_speech(out, self.devices.by_id)
            self.logger.info(
                {
                    "msg": "satellite.agent.reply",
                    "device_id": self.device_id,
                    "session_id": self.session_id,
                    "type": out.get("type"),
                    "speech": speech,
                }
            )
            events.extend(await self._build_tts_events(speech, turn_type=str(out.get("type") or "answer")))
            self.state = "LISTEN"
            self.last_turn_at = time.monotonic()
            self._reset_recording()
            return events
        except Exception as exc:
            self.logger.error(
                {
                    "msg": "satellite.turn.failed",
                    "device_id": self.device_id,
                    "session_id": self.session_id,
                    "error": str(exc),
                }
            )
            error_events: list[dict[str, Any]] = [
                {
                    "type": "error",
                    "deviceId": self.device_id,
                    "sessionId": self.session_id,
                    "code": "turn_failed",
                    "message": str(exc),
                }
            ]
            try:
                error_events.extend(await self._build_tts_events("抱歉，我刚才没有处理成功。", turn_type="error"))
            except Exception as synth_exc:
                self.logger.error(
                    {
                        "msg": "satellite.tts.failed",
                        "device_id": self.device_id,
                        "session_id": self.session_id,
                        "error": str(synth_exc),
                    }
                )
            self.state = "LISTEN"
            self.last_turn_at = time.monotonic()
            self._reset_recording()
            return error_events

    def _trim_capture_pcm(self, pcm: np.ndarray) -> np.ndarray:
        if pcm.size <= PROCESS_BLOCK_SIZE:
            return pcm

        frame = 320
        if pcm.size < frame:
            return pcm

        usable = (pcm.size // frame) * frame
        if usable < frame:
            return pcm

        frames = pcm[:usable].reshape(-1, frame)
        rms = np.sqrt(np.mean(np.square(frames, dtype=np.float32), axis=1, dtype=np.float32))
        max_rms = float(np.max(rms)) if rms.size else 0.0
        if max_rms < 0.01:
            return pcm

        threshold = max(0.015, max_rms * 0.2)
        active = np.flatnonzero(rms >= threshold)
        if active.size == 0:
            return pcm

        pre_pad_frames = 5
        post_pad_frames = 8
        start_frame = max(0, int(active[0]) - pre_pad_frames)
        end_frame = min(len(rms), int(active[-1]) + 1 + post_pad_frames)
        start = start_frame * frame
        end = min(pcm.size, end_frame * frame)
        trimmed = pcm[start:end]
        return trimmed if trimmed.size else pcm

    def _transcribe_blocking(self, pcm: np.ndarray) -> tuple[str, dict[str, Any]]:
        if self._stt_lock is None:
            return self.stt.transcribe(pcm, sample_rate=PROCESS_SAMPLE_RATE)
        with self._stt_lock:
            return self.stt.transcribe(pcm, sample_rate=PROCESS_SAMPLE_RATE)

    async def _build_tts_events(self, text: str, *, turn_type: str) -> list[dict[str, Any]]:
        audio = await asyncio.to_thread(self.tts.synthesize, text)
        return self._audio_to_events(audio, text=text, turn_type=turn_type)

    def _audio_to_events(self, audio: SynthesizedAudio, *, text: str, turn_type: str) -> list[dict[str, Any]]:
        audio = self._normalize_tts_audio(audio)
        events: list[dict[str, Any]] = [
            {
                "type": "tts_start",
                "deviceId": self.device_id,
                "sessionId": self.session_id,
                "turnType": turn_type,
                "text": text,
                "encoding": "pcm_s16le",
                "sampleRate": audio.sample_rate,
                "channels": audio.channels,
                "sampleWidth": audio.sample_width,
                "chunkBytes": TTS_CHUNK_BYTES,
            }
        ]
        payload = audio.pcm_s16le or b""
        for seq, offset in enumerate(range(0, len(payload), TTS_CHUNK_BYTES)):
            chunk = payload[offset : offset + TTS_CHUNK_BYTES]
            events.append(
                {
                    "type": "tts_chunk",
                    "deviceId": self.device_id,
                    "sessionId": self.session_id,
                    "seq": seq,
                    "data": base64.b64encode(chunk).decode("ascii"),
                }
            )
        events.append({"type": "tts_end", "deviceId": self.device_id, "sessionId": self.session_id, "turnType": turn_type, "text": text})
        return events

    def _normalize_tts_audio(self, audio: SynthesizedAudio) -> SynthesizedAudio:
        if not audio.pcm_s16le:
            return SynthesizedAudio(sample_rate=PROCESS_SAMPLE_RATE, channels=1, sample_width=2, pcm_s16le=b"")
        if audio.sample_width != 2:
            raise RuntimeError(f"unsupported tts sample width: {audio.sample_width}")

        pcm = np.frombuffer(audio.pcm_s16le, dtype=np.int16)
        if audio.channels > 1:
            pcm = pcm.reshape(-1, audio.channels).astype(np.int32).mean(axis=1)
            pcm = np.clip(pcm, -32768, 32767).astype(np.int16)
        elif audio.channels == 1:
            pcm = pcm.astype(np.int16, copy=False)
        else:
            raise RuntimeError(f"unsupported tts channels: {audio.channels}")

        if audio.sample_rate != PROCESS_SAMPLE_RATE:
            out_len = max(1, int(round(len(pcm) * PROCESS_SAMPLE_RATE / max(1, audio.sample_rate))))
            pcm = resample_block(pcm, build_resampler(len(pcm), out_len))

        return SynthesizedAudio(
            sample_rate=PROCESS_SAMPLE_RATE,
            channels=1,
            sample_width=2,
            pcm_s16le=pcm.astype(np.int16, copy=False).tobytes(),
        )

    def _dump_debug_wav(self, pcm: np.ndarray) -> str:
        clipped = np.clip(pcm * 32768.0, -32768, 32767).astype(np.int16)
        path = f"/tmp/voice_satellite_{self.device_id}_{int(time.time() * 1000)}.wav"
        with wave.open(path, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(PROCESS_SAMPLE_RATE)
            wav.writeframes(clipped.tobytes())
        return path


async def run_ws_server(cfg: AppConfig, logger: Logger) -> int:
    from websockets.legacy.server import serve
    from .stt_whisper import WhisperStt
    from .tts_piper import PiperTts

    devices = DeviceCatalog(base_url=cfg.api_gateway.base_url, api_key=cfg.api_gateway.api_key, logger=logger)
    agent = AgentClient(base_url=cfg.agent.base_url, timeout_s=cfg.agent.timeout_s, logger=logger)
    stt = WhisperStt(model_ref=cfg.stt.whisper_model, device=cfg.stt.device, language=cfg.stt.language, logger=logger)
    tts = PiperTts(
        piper_bin=cfg.tts.piper_bin,
        model_path=cfg.tts.model_path,
        config_path=cfg.tts.config_path,
        speaker=cfg.tts.speaker,
        output_device=None,
        output_backend="sounddevice",
        logger=logger,
    )
    stt_lock = threading.Lock()

    async def handler(websocket: Any, path: str) -> None:
        expected_path = cfg.satellite_server.path or "/ws"
        if expected_path and path != expected_path:
            await websocket.close(code=1008, reason="invalid path")
            return

        remote = getattr(websocket, "remote_address", None)
        send_lock = asyncio.Lock()
        session: Optional[RemoteSatelliteSession] = None

        async def send_event(event: dict[str, Any]) -> None:
            async with send_lock:
                await websocket.send(json.dumps(event, ensure_ascii=False))

        async def send_events(events: list[dict[str, Any]]) -> None:
            for event in events:
                await send_event(event)
                if event.get("type") == "tts_chunk":
                    await asyncio.sleep(TTS_CHUNK_PACING_SEC)

        async def watchdog() -> None:
            while True:
                await asyncio.sleep(1.0)
                if session is None:
                    continue
                events = await session.tick()
                if events:
                    await send_events(events)

        logger.info({"msg": "satellite.connection.open", "remote": str(remote), "path": path})
        watchdog_task = asyncio.create_task(watchdog())
        try:
            async for raw in websocket:
                if isinstance(raw, bytes):
                    await send_event({"type": "error", "code": "binary_not_supported", "message": "send JSON text frames only"})
                    continue
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    await send_event({"type": "error", "code": "invalid_json", "message": "message must be valid JSON"})
                    continue
                if not isinstance(msg, dict):
                    await send_event({"type": "error", "code": "invalid_message", "message": "message must be an object"})
                    continue

                msg_type = str(msg.get("type") or "").strip()
                if session is None:
                    if msg_type != "hello":
                        await send_event({"type": "error", "code": "hello_required", "message": "send hello before other messages"})
                        await websocket.close(code=1008, reason="hello required")
                        return
                    device_id = str(msg.get("deviceId") or "").strip()
                    if not device_id:
                        await send_event({"type": "error", "code": "missing_device_id", "message": "hello.deviceId is required"})
                        await websocket.close(code=1008, reason="missing device id")
                        return
                    auth_token = str(msg.get("authToken") or "")
                    if cfg.satellite_server.auth_token and auth_token != cfg.satellite_server.auth_token:
                        await send_event({"type": "error", "code": "auth_failed", "message": "invalid auth token"})
                        await websocket.close(code=1008, reason="auth failed")
                        return
                    sample_rate = int(msg.get("sampleRate") or PROCESS_SAMPLE_RATE)
                    encoding = str(msg.get("encoding") or "pcm_s16le").strip().lower()
                    channels = int(msg.get("channels") or 1)
                    if sample_rate != PROCESS_SAMPLE_RATE or channels != 1 or encoding != "pcm_s16le":
                        await send_event(
                            {
                                "type": "error",
                                "code": "unsupported_audio_format",
                                "message": "expected mono 16kHz pcm_s16le audio",
                            }
                        )
                        await websocket.close(code=1008, reason="unsupported audio format")
                        return
                    session = RemoteSatelliteSession(
                        device_id=device_id,
                        cfg=cfg,
                        logger=logger,
                        devices=devices,
                        agent=agent,
                        stt=stt,
                        tts=tts,
                        stt_lock=stt_lock,
                    )
                    logger.info({"msg": "satellite.hello", "device_id": device_id, "remote": str(remote)})
                    await send_event(
                        {
                            "type": "hello_ack",
                            "deviceId": device_id,
                            "sessionIdleTimeoutMs": cfg.runtime.session_idle_timeout_ms,
                            "audioFormat": {
                                "encoding": "pcm_s16le",
                                "sampleRate": PROCESS_SAMPLE_RATE,
                                "channels": 1,
                                "frameSamples": PROCESS_BLOCK_SIZE,
                            },
                        }
                    )
                    continue

                if msg_type == "ping":
                    await send_event({"type": "pong", "deviceId": session.device_id, "ts": int(time.time() * 1000)})
                    continue
                if msg_type == "debug_tts":
                    text = str(msg.get("text") or "这是网络语音播报测试。").strip() or "这是网络语音播报测试。"
                    if not session.session_id:
                        session.session_id = f"voice-{uuid.uuid4().hex[:8]}"
                    events = await session._build_tts_events(text, turn_type="debug")
                    events.extend(session._close_session(reason="debug_tts"))
                    await send_events(events)
                    continue
                if msg_type == "wake":
                    await send_events(await session.start_session())
                    continue
                if msg_type == "audio_start":
                    await send_events(await session.begin_capture())
                    continue
                if msg_type == "audio_end":
                    await send_events(await session.finalize_audio())
                    continue
                if msg_type == "audio_chunk":
                    data = msg.get("data")
                    if not isinstance(data, str) or not data:
                        await send_event({"type": "error", "code": "missing_audio", "message": "audio_chunk.data is required"})
                        continue
                    try:
                        pcm_bytes = base64.b64decode(data, validate=True)
                    except Exception:
                        await send_event({"type": "error", "code": "invalid_audio", "message": "audio_chunk.data must be base64"})
                        continue
                    await send_events(await session.ingest_audio_chunk(pcm_bytes))
                    continue

                await send_event({"type": "error", "code": "unsupported_message", "message": f"unsupported type: {msg_type or '<empty>'}"})
        finally:
            watchdog_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await watchdog_task
            logger.info({"msg": "satellite.connection.close", "remote": str(remote), "device_id": getattr(session, 'device_id', None)})

    logger.info(
        {
            "msg": "satellite_server.ready",
            "host": cfg.satellite_server.host,
            "port": cfg.satellite_server.port,
            "path": cfg.satellite_server.path,
        }
    )
    async with serve(
        handler,
        cfg.satellite_server.host,
        cfg.satellite_server.port,
        max_size=cfg.satellite_server.max_message_bytes,
        ping_interval=cfg.satellite_server.ping_interval_s,
        ping_timeout=cfg.satellite_server.ping_timeout_s,
    ):
        await asyncio.Future()
    return 0
