from __future__ import annotations

import os
import subprocess
import tempfile
import wave
from dataclasses import dataclass
from typing import Any, Optional

import numpy as np
import sounddevice as sd

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
        with tempfile.TemporaryDirectory(prefix="voice_satellite_") as td:
            wav_path = os.path.join(td, "tts.wav")
            self._synthesize(t, wav_path)
            self._play_wav(wav_path)

    def _synthesize(self, text: str, wav_path: str) -> None:
        cmd = [self.piper_bin, "--model", self.model_path, "--config", self.config_path, "--output_file", wav_path]
        if self.speaker is not None:
            cmd += ["--speaker", str(self.speaker)]
        self.logger and self.logger.debug({"msg": "piper.exec", "cmd": cmd})
        p = subprocess.run(cmd, input=(text + "\n").encode("utf-8"), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if p.returncode != 0:
            raise RuntimeError(f"piper_failed rc={p.returncode}: {(p.stderr or b'')[:300].decode('utf-8', 'ignore')}")

    def _play_wav(self, wav_path: str) -> None:
        if self.output_backend == "pulse":
            self._play_wav_pulse(wav_path)
            return

        with wave.open(wav_path, "rb") as wf:
            channels = wf.getnchannels()
            sr = wf.getframerate()
            sampwidth = wf.getsampwidth()
            frames = wf.getnframes()
            raw = wf.readframes(frames)

        if sampwidth != 2:
            raise RuntimeError(f"Unsupported wav sample width: {sampwidth}")
        audio = np.frombuffer(raw, dtype=np.int16)
        if channels > 1:
            audio = audio.reshape(-1, channels)
        device = None
        if self.output_device is not None:
            # reuse the same device resolution logic as in app.py, but keep it local here
            device = _resolve_output_device(self.output_device)
        sd.play(audio, sr, device=device, blocking=True)

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
    devices = sd.query_devices()
    for i, d in enumerate(devices):
        name = str(d.get("name", "")).lower()
        if key in name:
            return i
    return None
