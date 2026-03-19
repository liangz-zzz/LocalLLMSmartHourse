from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Dict

import requests

from .log import Logger


DEFAULT_CACHE_TTL_S = 30.0


@dataclass
class DeviceCatalog:
    base_url: str
    api_key: str = ""
    logger: Logger | None = None
    cache_ttl_s: float = DEFAULT_CACHE_TTL_S
    by_id: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    _last_refresh_at: float = field(default=0.0, init=False, repr=False)
    _refresh_lock: threading.Lock = field(default_factory=threading.Lock, init=False, repr=False)

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
        self._last_refresh_at = time.monotonic()
        self.logger and self.logger.debug({"msg": "devices.refresh", "count": len(out)})

    def refresh_in_background(self, *, force: bool = False) -> bool:
        now = time.monotonic()
        if not force and self.by_id and self._last_refresh_at and (now - self._last_refresh_at) < max(1.0, float(self.cache_ttl_s)):
            return False
        if not self._refresh_lock.acquire(blocking=False):
            return False

        thread = threading.Thread(target=self._refresh_worker, daemon=True)
        thread.start()
        return True

    def _refresh_worker(self) -> None:
        try:
            self.refresh()
        except Exception as exc:
            self.logger and self.logger.warn({"msg": "devices.refresh.failed", "error": str(exc)})
        finally:
            self._refresh_lock.release()
