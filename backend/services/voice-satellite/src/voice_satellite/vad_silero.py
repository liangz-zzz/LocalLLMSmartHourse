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
        # Use ONNX backend for speed/portability; weights are packaged (offline).
        self._model = load_silero_vad(onnx=True, opset_version=15)
        self._model.reset_states()

    def probability(self, chunk_i16: np.ndarray) -> float:
        # Expect exactly 512 samples at 16k for streaming.
        x = chunk_i16.astype(np.float32) / 32768.0
        t = self._torch.from_numpy(x).unsqueeze(0)
        return float(self._model(t, self.sample_rate).item())

