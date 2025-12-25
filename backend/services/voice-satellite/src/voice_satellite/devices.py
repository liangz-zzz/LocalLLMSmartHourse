from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict

import requests

from .log import Logger


@dataclass
class DeviceCatalog:
    base_url: str
    api_key: str = ""
    logger: Logger | None = None
    by_id: Dict[str, Dict[str, Any]] = field(default_factory=dict)

    def refresh(self) -> None:
        url = self.base_url.rstrip("/") + "/devices"
        headers = {"X-API-Key": self.api_key} if self.api_key else {}
        r = requests.get(url, headers=headers, timeout=10)
        if not r.ok:
            raise RuntimeError(f"api_gateway_http_{r.status_code}: {(r.text or '')[:200]}")
        body = r.json() or {}
        items = body.get("items") or []
        out: Dict[str, Dict[str, Any]] = {}
        for d in items:
            if not isinstance(d, dict):
                continue
            did = str(d.get("id") or "").strip()
            if not did:
                continue
            out[did] = d
        self.by_id = out
        self.logger and self.logger.debug({"msg": "devices.refresh", "count": len(out)})

