from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from voice_satellite.stt_whisper import WhisperStt  # noqa: E402


class _FakeCuda:
    def __init__(self, available: bool):
        self._available = available

    def is_available(self) -> bool:
        return self._available

    def current_device(self) -> int:
        return 0

    def get_device_name(self, _index: int) -> str:
        return "Fake GPU"


def _fake_modules(*, cuda_available: bool):
    fake_torch = SimpleNamespace(cuda=_FakeCuda(cuda_available))
    fake_whisper = SimpleNamespace(load_model=lambda ref, device=None: {"ref": ref, "device": device})
    return {"torch": fake_torch, "whisper": fake_whisper}


class WhisperSttConfigTest(unittest.TestCase):
    def test_requires_cuda_device(self) -> None:
        with patch.dict(sys.modules, _fake_modules(cuda_available=True), clear=False):
            with self.assertRaisesRegex(RuntimeError, "stt.device=cuda"):
                WhisperStt(model_ref="/models/whisper-small.pt", device="cpu", language="zh")

    def test_requires_cuda_runtime(self) -> None:
        with patch.dict(sys.modules, _fake_modules(cuda_available=False), clear=False):
            with self.assertRaisesRegex(RuntimeError, "requires CUDA"):
                WhisperStt(model_ref="/models/whisper-small.pt", device="cuda", language="zh")


if __name__ == "__main__":
    unittest.main()
