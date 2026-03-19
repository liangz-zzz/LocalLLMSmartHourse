from __future__ import annotations

import tempfile
import textwrap
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from voice_satellite.config import load_config  # noqa: E402


class LoadConfigTest(unittest.TestCase):
    def _write(self, body: str) -> str:
        with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False, encoding="utf-8") as f:
            f.write(textwrap.dedent(body))
            return f.name

    def test_ws_server_mode_allows_missing_local_wake_model(self) -> None:
        path = self._write(
            """
            mode: "ws_server"
            wake:
              phrases: ["你好，米奇"]
            stt:
              whisper_model: "/models/whisper-small.pt"
            tts:
              model_path: "/models/piper.onnx"
              config_path: "/models/piper.onnx.json"
            """
        )
        cfg = load_config(path)
        self.assertEqual(cfg.mode, "ws_server")
        self.assertEqual(cfg.satellite_server.port, 8765)
        self.assertEqual(cfg.stt.device, "cuda")
        self.assertEqual(cfg.device_config_path, "")

    def test_local_mode_requires_vosk_model(self) -> None:
        path = self._write(
            """
            mode: "local"
            wake:
              phrases: ["你好，米奇"]
            stt:
              whisper_model: "/models/whisper-small.pt"
            tts:
              model_path: "/models/piper.onnx"
              config_path: "/models/piper.onnx.json"
            """
        )
        with self.assertRaises(SystemExit):
            load_config(path)


if __name__ == "__main__":
    unittest.main()
