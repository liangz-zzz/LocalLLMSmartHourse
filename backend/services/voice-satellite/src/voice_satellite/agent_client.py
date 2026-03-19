from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict

import requests

from .log import Logger


@dataclass(frozen=True)
class AgentClient:
    base_url: str
    timeout_s: int = 30
    logger: Logger | None = None

    def turn(self, *, session_id: str, text: str, confirm: bool, wake_source: Dict[str, Any] | None = None) -> Dict[str, Any]:
        url = self.base_url.rstrip("/") + "/v1/agent/turn"
        payload = {"input": text, "sessionId": session_id, "confirm": bool(confirm)}
        if isinstance(wake_source, dict) and wake_source:
            payload["context"] = {"wakeSource": wake_source}
        self.logger and self.logger.debug({"msg": "agent.request", "url": url, "payload": payload})
        r = requests.post(url, json=payload, timeout=self.timeout_s)
        if not r.ok:
            body = (r.text or "")[:300]
            raise RuntimeError(f"agent_http_{r.status_code}: {body}")
        return r.json()
