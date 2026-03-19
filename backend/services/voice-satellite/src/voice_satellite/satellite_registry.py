from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict

from .log import Logger


@dataclass(frozen=True)
class SatelliteRegistration:
    device_id: str
    placement: Dict[str, Any]


@dataclass
class SatelliteRegistry:
    path: str = ""
    logger: Logger | None = None
    _by_id: Dict[str, SatelliteRegistration] = field(default_factory=dict, init=False, repr=False)
    _last_reload_token: str = field(default="", init=False, repr=False)
    _resolved_path: str = field(default="", init=False, repr=False)

    def resolve(self, device_id: str) -> tuple[SatelliteRegistration | None, str | None, str | None]:
        normalized_id = str(device_id or "").strip()
        if not normalized_id:
            return None, "missing_device_id", "hello.deviceId is required"

        self.refresh_if_needed()

        registration = self._by_id.get(normalized_id)
        if not registration:
            return None, "unknown_satellite", f"satellite {normalized_id} is not registered in voice_control.mics[]"

        room = str(registration.placement.get("room") or "").strip()
        if not room:
            return None, "invalid_satellite_config", f"satellite {normalized_id} is missing placement.room in voice_control.mics[]"

        return registration, None, None

    def refresh_if_needed(self) -> bool:
        resolved = self._resolve_path()
        if not resolved:
            if self._last_reload_token != "unconfigured":
                self._last_reload_token = "unconfigured"
                self.logger and self.logger.warn({"msg": "satellite.registry.unconfigured"})
            return False

        try:
            stat = Path(resolved).stat()
        except FileNotFoundError:
            token = "missing"
            if token != self._last_reload_token:
                self._last_reload_token = token
                self.logger and self.logger.warn(
                    {
                        "msg": "satellite.registry.missing",
                        "path": resolved,
                        "registered": len(self._by_id),
                    }
                )
            return False

        token = f"mtime:{stat.st_mtime_ns}"
        if token == self._last_reload_token:
            return False

        try:
            data = json.loads(Path(resolved).read_text(encoding="utf-8"))
            entries = load_satellite_registrations(data)
        except Exception as exc:
            self._last_reload_token = f"invalid:{stat.st_mtime_ns}"
            self.logger and self.logger.warn(
                {
                    "msg": "satellite.registry.invalid",
                    "path": resolved,
                    "error": str(exc),
                    "registered": len(self._by_id),
                }
            )
            return False

        self._by_id = entries
        self._last_reload_token = token
        self.logger and self.logger.info({"msg": "satellite.registry.loaded", "path": resolved, "registered": len(entries)})
        return True

    def _resolve_path(self) -> str:
        if self._resolved_path:
            return self._resolved_path
        raw = str(self.path or "").strip()
        if not raw:
            return ""
        self._resolved_path = str(Path(raw).expanduser().resolve())
        return self._resolved_path


def load_satellite_registrations(data: Any) -> Dict[str, SatelliteRegistration]:
    if not isinstance(data, dict):
        return {}

    raw_voice = data.get("voice_control") or data.get("voice") or {}
    if not isinstance(raw_voice, dict):
        return {}

    raw_mics = raw_voice.get("mics") or []
    if not isinstance(raw_mics, list):
        return {}

    out: Dict[str, SatelliteRegistration] = {}
    for item in raw_mics:
        if not isinstance(item, dict):
            continue
        device_id = str(item.get("id") or "").strip()
        if not device_id:
            continue
        out[device_id] = SatelliteRegistration(device_id=device_id, placement=normalize_placement(item.get("placement")))
    return out


def normalize_placement(raw: Any) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        return {}

    out: Dict[str, Any] = {}
    for key in ("room", "zone", "floor", "mount", "description"):
        value = str(raw.get(key) or "").strip()
        if value:
            out[key] = value

    coordinates = raw.get("coordinates")
    if isinstance(coordinates, dict):
        sanitized = {}
        for key, value in coordinates.items():
            if value is None:
                continue
            sanitized[str(key)] = value
        if sanitized:
            out["coordinates"] = sanitized

    return out
