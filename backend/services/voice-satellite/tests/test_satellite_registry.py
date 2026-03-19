from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from voice_satellite.satellite_registry import SatelliteRegistry  # noqa: E402


class SatelliteRegistryTest(unittest.TestCase):
    def test_resolve_registered_satellite(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "devices.config.json"
            path.write_text(
                json.dumps(
                    {
                        "voice_control": {
                            "mics": [
                                {
                                    "id": "bedroom-respeaker",
                                    "placement": {"room": "bedroom", "zone": "bedside", "floor": "2F"},
                                }
                            ]
                        }
                    }
                ),
                encoding="utf-8",
            )

            registry = SatelliteRegistry(path=str(path))
            registration, error_code, error_message = registry.resolve("bedroom-respeaker")

            self.assertIsNone(error_code)
            self.assertIsNone(error_message)
            self.assertIsNotNone(registration)
            self.assertEqual(registration.device_id, "bedroom-respeaker")
            self.assertEqual(registration.placement["room"], "bedroom")
            self.assertEqual(registration.placement["zone"], "bedside")

    def test_resolve_rejects_registration_without_room(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "devices.config.json"
            path.write_text(
                json.dumps(
                    {
                        "voice_control": {
                            "mics": [
                                {
                                    "id": "kitchen-respeaker",
                                    "placement": {"zone": "counter"},
                                }
                            ]
                        }
                    }
                ),
                encoding="utf-8",
            )

            registry = SatelliteRegistry(path=str(path))
            registration, error_code, _error_message = registry.resolve("kitchen-respeaker")

            self.assertIsNone(registration)
            self.assertEqual(error_code, "invalid_satellite_config")

    def test_registry_keeps_last_valid_entries_when_file_becomes_invalid(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "devices.config.json"
            path.write_text(
                json.dumps(
                    {
                        "voice_control": {
                            "mics": [
                                {
                                    "id": "living-room-respeaker",
                                    "placement": {"room": "living_room"},
                                }
                            ]
                        }
                    }
                ),
                encoding="utf-8",
            )

            registry = SatelliteRegistry(path=str(path))
            registration, error_code, _error_message = registry.resolve("living-room-respeaker")
            self.assertIsNone(error_code)
            self.assertEqual(registration.placement["room"], "living_room")

            path.write_text("{ invalid json", encoding="utf-8")

            registration, error_code, _error_message = registry.resolve("living-room-respeaker")
            self.assertIsNone(error_code)
            self.assertEqual(registration.placement["room"], "living_room")


if __name__ == "__main__":
    unittest.main()
