from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import List

import numpy as np
from vosk import KaldiRecognizer, Model

from .log import Logger


def _norm(s: str) -> str:
    return "".join(str(s or "").strip().split())


@dataclass
class VoskWakeWord:
    model_path: str
    phrases: List[str]
    sample_rate: int
    logger: Logger | None = None

    def __post_init__(self) -> None:
        if not os.path.isdir(self.model_path):
            raise SystemExit(f"Vosk model_path not found (dir expected): {self.model_path}")
        self._model = Model(self.model_path)
        self._grammar = json.dumps([p for p in self.phrases if str(p).strip()], ensure_ascii=False)
        self._phrases = [_norm(p) for p in self.phrases if _norm(p)]
        self._rec = KaldiRecognizer(self._model, float(self.sample_rate), self._grammar)
        self._rec.SetWords(False)

    def reset(self) -> None:
        self._rec = KaldiRecognizer(self._model, float(self.sample_rate), self._grammar)
        self._rec.SetWords(False)

    def process(self, pcm_i16: np.ndarray) -> bool:
        data = pcm_i16.tobytes()
        if self._rec.AcceptWaveform(data):
            try:
                obj = json.loads(self._rec.Result() or "{}")
                text = _norm(obj.get("text", ""))
                return self._match(text)
            except Exception:
                return False

        try:
            obj = json.loads(self._rec.PartialResult() or "{}")
            text = _norm(obj.get("partial", ""))
            return self._match(text)
        except Exception:
            return False

    def _match(self, text: str) -> bool:
        if not text:
            return False
        for p in self._phrases:
            if p and p in text:
                self.logger and self.logger.debug({"msg": "wake.matched", "text": text, "phrase": p})
                return True
        return False

