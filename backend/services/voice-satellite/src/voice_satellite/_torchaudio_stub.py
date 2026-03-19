"""Minimal torchaudio stub for silero-vad ONNX mode.

The service only uses ``silero_vad.load_silero_vad(onnx=True)``, which imports
``torchaudio`` but does not call into it. This stub keeps the import path
working inside the NVIDIA PyTorch image, which ships torch but not torchaudio.
"""

__version__ = "0.0"


def __getattr__(name: str):  # pragma: no cover - defensive fallback
    raise RuntimeError(
        "torchaudio is not installed in this image. "
        "The voice-satellite service only supports the Silero ONNX VAD path."
    )
