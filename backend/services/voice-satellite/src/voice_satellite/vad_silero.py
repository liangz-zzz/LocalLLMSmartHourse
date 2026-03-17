from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class SileroVad:
    threshold: float = 0.55
    sample_rate: int = 16000

    def __post_init__(self) -> None:
        import torch
        from silero_vad import load_silero_vad

        torch.set_num_threads(1)
        self._torch = torch
        # Prefer the ONNX runtime path, but keep a torch fallback so the
        # service can still start in dev containers before that dependency is installed.
        try:
            self._model = load_silero_vad(onnx=True, opset_version=15)
        except ModuleNotFoundError as exc:
            if exc.name != "onnxruntime":
                raise
            self._model = load_silero_vad(onnx=False)
        self._model.reset_states()

    def probability(self, chunk_i16: np.ndarray) -> float:
        # Expect exactly 512 samples at 16k for streaming.
        x = chunk_i16.astype(np.float32) / 32768.0
        t = self._torch.from_numpy(x).unsqueeze(0)
        return float(self._model(t, self.sample_rate).item())
