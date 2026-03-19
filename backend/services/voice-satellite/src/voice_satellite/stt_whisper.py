from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Dict, Tuple

import numpy as np

from .log import Logger


@dataclass
class WhisperStt:
    model_ref: str
    device: str
    language: str
    logger: Logger | None = None

    def __post_init__(self) -> None:
        if str(self.device or "").strip().lower() != "cuda":
            raise RuntimeError("voice-satellite requires stt.device=cuda")

        import torch
        import whisper

        if not torch.cuda.is_available():
            raise RuntimeError("voice-satellite requires CUDA, but torch.cuda.is_available() is false")

        gpu_name = "unknown"
        with_device = getattr(torch.cuda, "current_device", None)
        get_name = getattr(torch.cuda, "get_device_name", None)
        if callable(with_device) and callable(get_name):
            try:
                gpu_name = str(get_name(with_device()))
            except Exception:
                gpu_name = "unknown"

        ref = self.model_ref
        if os.path.exists(ref):
            self.logger and self.logger.info({"msg": "whisper.load", "path": ref, "device": self.device, "gpu": gpu_name})
        else:
            # If a model name is used, whisper will download weights (not offline).
            self.logger and self.logger.warn({"msg": "whisper.model_not_found_path", "ref": ref, "hint": "Use a local .pt path for offline runtime."})
        self._whisper = whisper
        self._model = whisper.load_model(ref, device=self.device)

    def transcribe(self, audio: np.ndarray, *, sample_rate: int) -> Tuple[str, Dict[str, Any]]:
        # whisper expects 16k float32 mono
        if audio.dtype != np.float32:
            audio = audio.astype(np.float32)
        # best-effort: ensure mono 1D
        audio = audio.reshape(-1)
        fp16 = self.device != "cpu"
        result: Dict[str, Any] = self._model.transcribe(
            audio,
            language=self.language or None,
            task="transcribe",
            fp16=fp16,
            verbose=False,
            temperature=0.0,
            condition_on_previous_text=False,
            initial_prompt="以下是中文智能家居语音指令转写。",
        )
        text = str(result.get("text") or "").strip()
        return text, result
