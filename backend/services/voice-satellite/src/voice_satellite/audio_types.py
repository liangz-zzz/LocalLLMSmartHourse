from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SynthesizedAudio:
    sample_rate: int
    channels: int
    sample_width: int
    pcm_s16le: bytes
