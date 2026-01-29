from __future__ import annotations

import argparse
import json
import os
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import wave
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import numpy as np
import sounddevice as sd

from .agent_client import AgentClient
from .config import AppConfig, load_config
from .devices import DeviceCatalog
from .log import Logger
from .speech import compose_speech
from .stt_whisper import WhisperStt
from .tts_piper import PiperTts
from .vad_silero import SileroVad
from .wake_vosk import VoskWakeWord

PROCESS_SAMPLE_RATE = 16000
PROCESS_BLOCK_SIZE = 512


class AudioIn:
    def __init__(self, *, sample_rate: int, block_size: int, input_device: Optional[Any], logger: Logger):
        self.sample_rate = sample_rate
        self.block_size = block_size
        self.input_device = input_device
        self.logger = logger
        self._q: "queue.Queue[np.ndarray]" = queue.Queue(maxsize=256)
        self._stream: Optional[sd.InputStream] = None

    def start(self) -> None:
        device = resolve_device(sd.query_devices(), self.input_device, kind="input")
        self.logger.info({"msg": "audio.input.open", "sample_rate": self.sample_rate, "block_size": self.block_size, "device": device})
        self._stream = sd.InputStream(
            samplerate=self.sample_rate,
            blocksize=self.block_size,
            dtype="int16",
            channels=1,
            device=device,
            callback=self._callback,
        )
        self._stream.start()

    def stop(self) -> None:
        if self._stream:
            try:
                self._stream.stop()
                self._stream.close()
            finally:
                self._stream = None

    def read(self, timeout_s: float = 1.0) -> Optional[np.ndarray]:
        try:
            return self._q.get(timeout=timeout_s)
        except queue.Empty:
            return None

    def clear(self) -> None:
        while True:
            try:
                self._q.get_nowait()
            except queue.Empty:
                return

    def _callback(self, indata, _frames, _time, status) -> None:
        if status:
            self.logger.debug({"msg": "audio.input.status", "status": str(status)})
        block = np.asarray(indata).reshape(-1).copy()
        try:
            self._q.put_nowait(block)
        except queue.Full:
            # Drop audio if the main loop is busy (e.g., STT/TTS). Safe for our state machine.
            pass


class PulseAudioIn:
    def __init__(self, *, sample_rate: int, block_size: int, source: str, logger: Logger):
        self.sample_rate = sample_rate
        self.block_size = block_size
        self.source = source or "default"
        self.logger = logger
        self._q: "queue.Queue[np.ndarray]" = queue.Queue(maxsize=256)
        self._proc: Optional[subprocess.Popen[bytes]] = None
        self._thread: Optional[threading.Thread] = None
        self._stderr_thread: Optional[threading.Thread] = None
        self._stop = threading.Event()

    def start(self) -> None:
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "pulse",
            "-i",
            self.source,
            "-ac",
            "1",
            "-ar",
            str(self.sample_rate),
            "-f",
            "s16le",
            "-",
        ]
        self.logger.info({"msg": "audio.pulse.open", "sample_rate": self.sample_rate, "block_size": self.block_size, "source": self.source})
        self._proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self._stop.clear()
        self._thread = threading.Thread(target=self._reader, daemon=True)
        self._thread.start()
        self._stderr_thread = threading.Thread(target=self._drain_stderr, daemon=True)
        self._stderr_thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._proc:
            try:
                self._proc.terminate()
            except Exception:
                pass
            try:
                self._proc.wait(timeout=2)
            except Exception:
                try:
                    self._proc.kill()
                except Exception:
                    pass
            self._proc = None
        if self._thread:
            self._thread.join(timeout=1)
            self._thread = None
        if self._stderr_thread:
            self._stderr_thread.join(timeout=1)
            self._stderr_thread = None

    def read(self, timeout_s: float = 1.0) -> Optional[np.ndarray]:
        try:
            return self._q.get(timeout=timeout_s)
        except queue.Empty:
            return None

    def clear(self) -> None:
        while True:
            try:
                self._q.get_nowait()
            except queue.Empty:
                return

    def _reader(self) -> None:
        if not self._proc or not self._proc.stdout:
            return
        block_bytes = self.block_size * 2
        buf = bytearray()
        while not self._stop.is_set():
            chunk = self._proc.stdout.read(block_bytes)
            if not chunk:
                break
            buf += chunk
            while len(buf) >= block_bytes:
                frame = bytes(buf[:block_bytes])
                del buf[:block_bytes]
                block = np.frombuffer(frame, dtype=np.int16).copy()
                try:
                    self._q.put_nowait(block)
                except queue.Full:
                    pass
        if self._proc and self._proc.poll() is not None:
            self.logger.warn({"msg": "audio.pulse.exit", "code": self._proc.returncode})

    def _drain_stderr(self) -> None:
        if not self._proc or not self._proc.stderr:
            return
        for line in self._proc.stderr:
            msg = line.decode("utf-8", "ignore").strip()
            if msg:
                self.logger.warn({"msg": "audio.pulse.stderr", "line": msg})


def resolve_device(devices: List[dict], selector: Optional[Any], *, kind: str) -> Optional[int]:
    if selector is None:
        return None
    if isinstance(selector, int):
        return selector
    s = str(selector).strip()
    if not s:
        return None
    if s.isdigit():
        return int(s)
    key = s.lower()
    for i, d in enumerate(devices):
        name = str(d.get("name", "")).lower()
        if key in name:
            # sounddevice uses device index across all devices.
            return i
    raise SystemExit(f"No {kind} device matches selector: {selector!r}")


def list_audio_devices() -> None:
    devices = sd.query_devices()
    hostapis = sd.query_hostapis()
    print("Audio devices:")
    for i, d in enumerate(devices):
        api = hostapis[d["hostapi"]]["name"] if isinstance(d.get("hostapi"), int) else "unknown"
        print(f"  [{i}] {d.get('name')} (api={api}, in={d.get('max_input_channels')}, out={d.get('max_output_channels')})")


def play_beep(cfg: AppConfig, logger: Logger) -> None:
    if not cfg.audio.beep.enabled:
        return
    sr = cfg.audio.sample_rate
    freq = cfg.audio.beep.frequency_hz
    duration_s = max(0.01, cfg.audio.beep.duration_ms / 1000.0)
    t = np.linspace(0, duration_s, int(sr * duration_s), endpoint=False)
    tone = (np.sin(2 * np.pi * freq * t) * float(cfg.audio.beep.volume)).astype(np.float32)
    backend = str(cfg.audio.output_backend or "sounddevice").lower()
    if backend == "auto":
        backend = "pulse" if os.environ.get("PULSE_SERVER") else "sounddevice"
    if backend == "pulse":
        _play_beep_pulse(tone, sr, logger)
        return
    try:
        device = resolve_device(sd.query_devices(), cfg.audio.output_device, kind="output")
        sd.play(tone, sr, device=device, blocking=True)
    except Exception as e:
        logger.warn({"msg": "beep.failed", "error": str(e)})


def _play_beep_pulse(tone: np.ndarray, sample_rate: int, logger: Logger) -> None:
    pcm = np.clip(tone * 32767.0, -32768, 32767).astype(np.int16)
    with tempfile.TemporaryDirectory(prefix="voice_satellite_beep_") as td:
        wav_path = os.path.join(td, "beep.wav")
        with wave.open(wav_path, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(pcm.tobytes())
        cmd = ["ffplay", "-nodisp", "-autoexit", "-loglevel", "error", wav_path]
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if p.returncode != 0:
            err = (p.stderr or b"")[:200].decode("utf-8", "ignore")
            logger.warn({"msg": "beep.pulse_failed", "error": err})


def _build_resampler(in_len: int, out_len: int) -> Optional[tuple[np.ndarray, np.ndarray]]:
    if in_len == out_len:
        return None
    if in_len <= 1 or out_len <= 1:
        return None
    x_old = np.linspace(0.0, float(in_len - 1), num=in_len, dtype=np.float32)
    x_new = np.linspace(0.0, float(in_len - 1), num=out_len, dtype=np.float32)
    return (x_old, x_new)


def _resample_block(block: np.ndarray, resampler: Optional[tuple[np.ndarray, np.ndarray]]) -> np.ndarray:
    if resampler is None:
        return block
    x_old, x_new = resampler
    y = np.interp(x_new, x_old, block.astype(np.float32))
    y = np.clip(y, -32768, 32767).astype(np.int16)
    return y


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="voice-satellite", description="Offline voice satellite for smart-house-agent.")
    parser.add_argument("--config", help="Path to YAML config.")
    parser.add_argument("--list-devices", action="store_true", help="List audio devices and exit.")
    args = parser.parse_args(argv)

    if args.list_devices:
        list_audio_devices()
        return 0
    if not args.config:
        parser.error("--config is required unless --list-devices is used")

    cfg = load_config(args.config)
    logger = Logger(cfg.runtime.log_level)

    input_backend = str(cfg.audio.input_backend or "sounddevice").lower()
    if input_backend == "auto":
        input_backend = "pulse" if os.environ.get("PULSE_SERVER") else "sounddevice"
    if input_backend not in ("sounddevice", "pulse"):
        raise SystemExit("audio.input_backend must be one of: sounddevice | pulse | auto")
    output_backend = str(cfg.audio.output_backend or "sounddevice").lower()
    if output_backend == "auto":
        output_backend = "pulse" if os.environ.get("PULSE_SERVER") else "sounddevice"
    if output_backend not in ("sounddevice", "pulse"):
        raise SystemExit("audio.output_backend must be one of: sounddevice | pulse | auto")

    capture_rate = cfg.audio.sample_rate
    capture_block = cfg.audio.block_size
    process_rate = PROCESS_SAMPLE_RATE
    process_block = PROCESS_BLOCK_SIZE
    if capture_rate != process_rate or capture_block != process_block:
        logger.warn(
            {
                "msg": "audio.resample.enabled",
                "capture_rate": capture_rate,
                "capture_block": capture_block,
                "process_rate": process_rate,
                "process_block": process_block,
            }
        )
    resampler = _build_resampler(capture_block, process_block)

    # Core components
    wake = VoskWakeWord(model_path=cfg.wake.vosk.model_path, phrases=cfg.wake.phrases, sample_rate=process_rate, logger=logger)
    vad = SileroVad(threshold=cfg.vad.threshold, sample_rate=process_rate)
    stt = WhisperStt(model_ref=cfg.stt.whisper_model, device=cfg.stt.device, language=cfg.stt.language, logger=logger)
    tts = PiperTts(
        piper_bin=cfg.tts.piper_bin,
        model_path=cfg.tts.model_path,
        config_path=cfg.tts.config_path,
        speaker=cfg.tts.speaker,
        output_device=cfg.audio.output_device,
        output_backend=output_backend,
        logger=logger,
    )
    devices = DeviceCatalog(base_url=cfg.api_gateway.base_url, api_key=cfg.api_gateway.api_key, logger=logger)
    agent = AgentClient(base_url=cfg.agent.base_url, timeout_s=cfg.agent.timeout_s, logger=logger)

    if input_backend == "pulse":
        audio = PulseAudioIn(sample_rate=capture_rate, block_size=capture_block, source=cfg.audio.pulse_source, logger=logger)
    else:
        audio = AudioIn(sample_rate=capture_rate, block_size=capture_block, input_device=cfg.audio.input_device, logger=logger)
    audio.start()

    state = "IDLE"  # IDLE | LISTEN | SPEAK
    session_id: Optional[str] = None
    wake_started_at = 0.0
    awaiting_first_utterance = False
    last_turn_at = 0.0
    ignore_until = 0.0

    pre_roll_chunks = max(0, int(cfg.vad.pre_roll_ms / 1000 * process_rate / process_block))
    end_silence_chunks = max(1, int(cfg.vad.end_silence_ms / 1000 * process_rate / process_block))
    max_utt_chunks = max(1, int(cfg.vad.max_utterance_ms / 1000 * process_rate / process_block))
    min_utt_chunks = max(1, int(cfg.vad.min_utterance_ms / 1000 * process_rate / process_block))

    prebuffer: "List[np.ndarray]" = []
    utterance: "List[np.ndarray]" = []
    speech_started = False
    silence = 0

    logger.info({"msg": "voice-satellite.ready", "wake_phrases": cfg.wake.phrases})

    confirm_set = {normalize_for_match(s) for s in cfg.agent.confirm_phrases}
    cancel_set = {normalize_for_match(s) for s in cfg.agent.cancel_phrases}
    exit_set = {normalize_for_match(s) for s in cfg.agent.exit_phrases}

    try:
        while True:
            block = audio.read(timeout_s=1.0)
            now = time.monotonic()
            if block is None:
                # periodic housekeeping
                if state == "LISTEN" and last_turn_at and (now - last_turn_at) * 1000 > cfg.runtime.session_idle_timeout_ms:
                    logger.info({"msg": "session.timeout", "session_id": session_id})
                    state = "IDLE"
                    session_id = None
                    wake.reset()
                    awaiting_first_utterance = False
                continue

            block = _resample_block(block, resampler)

            if now < ignore_until:
                continue

            if state == "IDLE":
                if wake.process(block):
                    session_id = f"voice-{uuid.uuid4().hex[:8]}"
                    wake_started_at = now
                    last_turn_at = now
                    ignore_until = now + (cfg.wake.cooldown_ms / 1000.0)
                    awaiting_first_utterance = True
                    prebuffer = []
                    utterance = []
                    speech_started = False
                    silence = 0

                    try:
                        devices.refresh()
                    except Exception:
                        # best-effort
                        pass

                    play_beep(cfg, logger)
                    logger.info({"msg": "wake.detected", "session_id": session_id})
                    state = "LISTEN"
                continue

            if state == "LISTEN":
                # give up if user doesn't speak after wake
                if (
                    awaiting_first_utterance
                    and not speech_started
                    and wake_started_at
                    and (now - wake_started_at) * 1000 > cfg.wake.timeout_ms
                ):
                    logger.info({"msg": "wake.timeout", "session_id": session_id})
                    state = "IDLE"
                    session_id = None
                    wake.reset()
                    awaiting_first_utterance = False
                    continue

                # keep a short pre-roll buffer
                if pre_roll_chunks > 0:
                    prebuffer.append(block)
                    if len(prebuffer) > pre_roll_chunks:
                        prebuffer = prebuffer[-pre_roll_chunks:]
                else:
                    prebuffer = []

                prob = vad.probability(block)
                is_speech = prob >= cfg.vad.threshold

                if not speech_started:
                    if is_speech:
                        speech_started = True
                        if awaiting_first_utterance:
                            awaiting_first_utterance = False
                        utterance = [*prebuffer, block]
                        silence = 0
                        last_turn_at = now
                        logger.debug({"msg": "vad.start", "p": prob, "chunks_pre": len(prebuffer)})
                    continue

                # recording
                utterance.append(block)
                if is_speech:
                    silence = 0
                else:
                    silence += 1

                if len(utterance) >= max_utt_chunks:
                    logger.warn({"msg": "vad.max_utterance_reached", "chunks": len(utterance)})
                    silence = end_silence_chunks

                if silence < end_silence_chunks:
                    continue

                # end of utterance
                if len(utterance) < min_utt_chunks:
                    logger.debug({"msg": "vad.too_short", "chunks": len(utterance)})
                    prebuffer = []
                    utterance = []
                    speech_started = False
                    silence = 0
                    continue

                audio.clear()
                state = "SPEAK"

                pcm = np.concatenate(utterance).astype(np.float32) / 32768.0
                text_raw, _meta = stt.transcribe(pcm, sample_rate=process_rate)
                text_raw = clean_user_text(text_raw)
                logger.info({"msg": "stt.done", "text": text_raw})

                if not text_raw:
                    state = "LISTEN"
                    prebuffer = []
                    utterance = []
                    speech_started = False
                    silence = 0
                    continue

                match = normalize_for_match(text_raw)
                confirm = match in confirm_set
                cancel = match in cancel_set
                exit_requested = match_short_phrase(match, exit_set, max_extra_chars=4)
                if exit_requested:
                    logger.info({"msg": "session.exit", "session_id": session_id, "text": text_raw})
                    try:
                        tts.say("好的，再见。")
                    except Exception as e:
                        logger.error({"msg": "tts.failed", "error": str(e)})
                    state = "IDLE"
                    session_id = None
                    wake.reset()
                    awaiting_first_utterance = False
                    prebuffer = []
                    utterance = []
                    speech_started = False
                    silence = 0
                    continue
                if cancel:
                    # Explicit cancel; send as-is (agent has cancel heuristics too).
                    confirm = False

                out = agent.turn(session_id=session_id or "", text=text_raw, confirm=confirm)
                speech = compose_speech(out, devices.by_id)
                logger.info({"msg": "agent.reply", "type": out.get("type"), "speech": speech})

                try:
                    tts.say(speech)
                except Exception as e:
                    logger.error({"msg": "tts.failed", "error": str(e)})

                last_turn_at = time.monotonic()
                state = "LISTEN"
                prebuffer = []
                utterance = []
                speech_started = False
                silence = 0
                continue

    except KeyboardInterrupt:
        logger.info({"msg": "shutdown"})
        return 0
    finally:
        audio.stop()


_re_space = re.compile(r"\\s+")
_re_trim_punct = re.compile(r"^[\\s\\u3000\\.,!?，。！？、；;：:]+|[\\s\\u3000\\.,!?，。！？、；;：:]+$")
_re_punct_any = re.compile(r"[\\u3000\\.,!?，。！？、；;：:]+")


def clean_user_text(text: str) -> str:
    t = (text or "").strip()
    t = _re_trim_punct.sub("", t)
    # Keep internal spaces for non-Chinese; only collapse consecutive whitespace.
    t = _re_space.sub(" ", t).strip()
    return t


def normalize_for_match(text: str) -> str:
    # For comparing short control utterances like "确认/取消".
    t = (text or "").strip()
    t = _re_punct_any.sub("", t)
    t = _re_space.sub("", t)
    return t.lower()


def match_short_phrase(text_normalized: str, phrases_normalized: set[str], *, max_extra_chars: int = 4) -> bool:
    if not text_normalized:
        return False
    if text_normalized in phrases_normalized:
        return True
    for p in phrases_normalized:
        if not p:
            continue
        if p in text_normalized and len(text_normalized) <= len(p) + max(0, int(max_extra_chars)):
            return True
    return False
