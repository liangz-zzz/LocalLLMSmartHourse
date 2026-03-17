from __future__ import annotations

import re
from typing import Optional

import numpy as np

PROCESS_SAMPLE_RATE = 16000
PROCESS_BLOCK_SIZE = 512

_re_space = re.compile(r"\s+")
_re_trim_punct = re.compile(r"^[\s\u3000\.,!?，。！？、；;：:]+|[\s\u3000\.,!?，。！？、；;：:]+$")
_re_punct_any = re.compile(r"[\u3000\.,!?，。！？、；;：:]+")
_zh_translations = str.maketrans(
    {
        "開": "开",
        "關": "关",
        "燈": "灯",
        "廳": "厅",
        "臥": "卧",
        "書": "书",
        "廚": "厨",
        "門": "门",
        "臺": "台",
        "風": "风",
        "調": "调",
        "溫": "温",
        "濕": "湿",
        "聲": "声",
        "麥": "麦",
        "關": "关",
        "閉": "闭",
        "這": "这",
        "裡": "里",
        "個": "个",
        "請": "请",
        "說": "说",
        "時": "时",
        "間": "间",
        "氣": "气",
        "電": "电",
        "視": "视",
        "機": "机",
        "熱": "热",
        "爐": "炉",
        "燒": "烧",
        "水": "水",
    }
)


def build_resampler(in_len: int, out_len: int) -> Optional[tuple[np.ndarray, np.ndarray]]:
    if in_len == out_len:
        return None
    if in_len <= 1 or out_len <= 1:
        return None
    x_old = np.linspace(0.0, float(in_len - 1), num=in_len, dtype=np.float32)
    x_new = np.linspace(0.0, float(in_len - 1), num=out_len, dtype=np.float32)
    return (x_old, x_new)


def resample_block(block: np.ndarray, resampler: Optional[tuple[np.ndarray, np.ndarray]]) -> np.ndarray:
    if resampler is None:
        return block
    x_old, x_new = resampler
    y = np.interp(x_new, x_old, block.astype(np.float32))
    y = np.clip(y, -32768, 32767).astype(np.int16)
    return y


def split_pcm16le_blocks(buffer: bytearray, *, block_samples: int = PROCESS_BLOCK_SIZE) -> list[np.ndarray]:
    block_bytes = max(1, int(block_samples)) * 2
    blocks: list[np.ndarray] = []
    while len(buffer) >= block_bytes:
        frame = bytes(buffer[:block_bytes])
        del buffer[:block_bytes]
        blocks.append(np.frombuffer(frame, dtype=np.int16).copy())
    return blocks


def audio_stats(samples: np.ndarray) -> dict[str, float | int]:
    if samples.size == 0:
        return {"samples": 0, "rms": 0.0, "peak": 0.0, "dc": 0.0, "clip_fraction": 0.0}
    samples_f32 = samples.astype(np.float32, copy=False).reshape(-1)
    peak = float(np.max(np.abs(samples_f32)))
    return {
        "samples": int(samples_f32.size),
        "rms": float(np.sqrt(np.mean(np.square(samples_f32), dtype=np.float32))),
        "peak": peak,
        "dc": float(np.mean(samples_f32, dtype=np.float32)),
        "clip_fraction": float(np.mean(np.abs(samples_f32) >= 0.999)),
    }


def prepare_stt_audio(
    samples: np.ndarray,
    *,
    target_peak: float = 0.72,
    min_peak_for_boost: float = 0.08,
    max_gain: float = 3.0,
) -> tuple[np.ndarray, dict[str, float | int]]:
    pcm = samples.astype(np.float32, copy=False).reshape(-1)
    if pcm.size == 0:
        return pcm, {"gain": 1.0, **audio_stats(pcm)}

    dc = float(np.mean(pcm, dtype=np.float32))
    pcm = pcm - dc
    peak = float(np.max(np.abs(pcm)))
    gain = 1.0
    if peak > 0.98:
        gain = min(gain, 0.95 / peak)
    elif peak >= min_peak_for_boost:
        gain = min(max_gain, target_peak / peak)

    pcm = np.clip(pcm * gain, -1.0, 1.0).astype(np.float32, copy=False)
    return pcm, {"gain": float(gain), **audio_stats(pcm)}


def clean_user_text(text: str) -> str:
    t = (text or "").strip()
    t = _re_trim_punct.sub("", t)
    t = _re_space.sub(" ", t).strip()
    t = t.translate(_zh_translations)
    return t


def normalize_for_match(text: str) -> str:
    t = (text or "").strip()
    t = _re_punct_any.sub("", t)
    t = _re_space.sub("", t)
    return t.lower()


def match_short_phrase(text_normalized: str, phrases_normalized: set[str], *, max_extra_chars: int = 4) -> bool:
    if not text_normalized:
        return False
    if text_normalized in phrases_normalized:
        return True
    for phrase in phrases_normalized:
        if not phrase:
            continue
        if phrase in text_normalized and len(text_normalized) <= len(phrase) + max(0, int(max_extra_chars)):
            return True
    return False
