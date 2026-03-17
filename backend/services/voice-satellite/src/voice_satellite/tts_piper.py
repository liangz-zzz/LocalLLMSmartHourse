from __future__ import annotations

import os
import subprocess
import tempfile
import wave
from dataclasses import dataclass
from typing import Any, Optional

import numpy as np

try:
    import sounddevice as sd
except ImportError:  # pragma: no cover - exercised only in environments without local audio deps
    sd = None

from .audio_types import SynthesizedAudio
from .log import Logger


@dataclass
class PiperTts:
    piper_bin: str
    model_path: str
    config_path: str
    speaker: Optional[int]
    output_device: Optional[Any]
    output_backend: str = "sounddevice"
    logger: Logger | None = None

    def say(self, text: str) -> None:
        t = (text or "").strip()
        if not t:
            return
        audio = self.synthesize(t)
        self.play(audio)

    def synthesize(self, text: str) -> SynthesizedAudio:
        t = (text or "").strip()
        if not t:
            return SynthesizedAudio(sample_rate=16000, channels=1, sample_width=2, pcm_s16le=b"")
        with tempfile.TemporaryDirectory(prefix="voice_satellite_") as td:
            wav_path = os.path.join(td, "tts.wav")
            self._synthesize(t, wav_path)
            return self._read_wav(wav_path)

    def play(self, audio: SynthesizedAudio) -> None:
        if not audio.pcm_s16le:
            return
        if self.output_backend == "pulse":
            self._play_pcm_pulse(audio)
            return
        if sd is None:
            raise RuntimeError("sounddevice is required for local audio playback")

        if audio.sample_width != 2:
            raise RuntimeError(f"Unsupported wav sample width: {audio.sample_width}")
        buffer = np.frombuffer(audio.pcm_s16le, dtype=np.int16)
        payload = buffer.reshape(-1, audio.channels) if audio.channels > 1 else buffer
        device = None
        if self.output_device is not None:
            device = _resolve_output_device(self.output_device)
        sd.play(payload, audio.sample_rate, device=device, blocking=True)

    def _synthesize(self, text: str, wav_path: str) -> None:
        cmd = [self.piper_bin, "--model", self.model_path, "--config", self.config_path, "--output_file", wav_path]
        if self.speaker is not None:
            cmd += ["--speaker", str(self.speaker)]
        self.logger and self.logger.debug({"msg": "piper.exec", "cmd": cmd})
        p = subprocess.run(cmd, input=(text + "\n").encode("utf-8"), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if p.returncode != 0:
            raise RuntimeError(f"piper_failed rc={p.returncode}: {(p.stderr or b'')[:300].decode('utf-8', 'ignore')}")

    def _read_wav(self, wav_path: str) -> SynthesizedAudio:
        with wave.open(wav_path, "rb") as wf:
            channels = wf.getnchannels()
            sr = wf.getframerate()
            sampwidth = wf.getsampwidth()
            frames = wf.getnframes()
            raw = wf.readframes(frames)
        return SynthesizedAudio(sample_rate=sr, channels=channels, sample_width=sampwidth, pcm_s16le=raw)

    def _play_pcm_pulse(self, audio: SynthesizedAudio) -> None:
        if audio.sample_width != 2:
            raise RuntimeError(f"Unsupported wav sample width: {audio.sample_width}")
        with tempfile.TemporaryDirectory(prefix="voice_satellite_pulse_") as td:
            wav_path = os.path.join(td, "tts.wav")
            with wave.open(wav_path, "wb") as wf:
                wf.setnchannels(audio.channels)
                wf.setsampwidth(audio.sample_width)
                wf.setframerate(audio.sample_rate)
                wf.writeframes(audio.pcm_s16le)
            self._play_wav_pulse(wav_path)

    def _play_wav_pulse(self, wav_path: str) -> None:
        cmd = ["ffplay", "-nodisp", "-autoexit", "-loglevel", "error", wav_path]
        self.logger and self.logger.debug({"msg": "ffplay.exec", "cmd": cmd})
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if p.returncode != 0:
            err = (p.stderr or b"")[:300].decode("utf-8", "ignore")
            raise RuntimeError(f"ffplay_failed rc={p.returncode}: {err}")


def _resolve_output_device(selector: Any) -> Optional[int]:
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
    if sd is None:
        return None
    devices = sd.query_devices()
    for i, d in enumerate(devices):
        name = str(d.get("name", "")).lower()
        if key in name:
            return i
    return None
