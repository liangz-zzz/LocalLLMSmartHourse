from __future__ import annotations

import json
import os
import re
import unicodedata
from dataclasses import dataclass
from typing import List

import numpy as np
from vosk import KaldiRecognizer, Model

from .log import Logger


_re_grammar_split = re.compile(r"[\s\u3000\.,!?，。！？、；;：:]+")


def _norm(s: str) -> str:
    s = str(s or "").strip()
    out: list[str] = []
    for ch in s:
        if ch.isspace():
            continue
        if unicodedata.category(ch).startswith("P"):
            continue
        out.append(ch)
    return "".join(out)


def _to_grammar_phrase(s: str) -> str:
    # Vosk grammar phrases are space-delimited "words". For Chinese, punctuation like "，"
    # should become a separator so "你好，米奇" can match "你好 米奇".
    parts = [p for p in _re_grammar_split.split(str(s or "").strip()) if p]
    return " ".join(parts)


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
        grammar_phrases: list[str] = []
        seen_grammar: set[str] = set()
        for p in self.phrases:
            g = _to_grammar_phrase(p)
            if g and g not in seen_grammar:
                grammar_phrases.append(g)
                seen_grammar.add(g)
        self._grammar = json.dumps(grammar_phrases, ensure_ascii=False)

        seen_phrases: set[str] = set()
        self._phrases = []
        for p in self.phrases:
            n = _norm(p)
            if n and n not in seen_phrases:
                self._phrases.append(n)
                seen_phrases.add(n)
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
