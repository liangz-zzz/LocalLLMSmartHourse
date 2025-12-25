from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass
from typing import Any, Dict


@dataclass
class Logger:
    level: str = "info"

    def _enabled(self, lvl: str) -> bool:
        order = ["error", "warn", "info", "debug"]
        lvl = lvl if lvl in order else "info"
        cur = self.level if self.level in order else "info"
        return order.index(lvl) <= order.index(cur)

    def _log(self, lvl: str, payload: Dict[str, Any]) -> None:
        if not self._enabled(lvl):
            return
        line = json.dumps({"level": lvl, "ts": int(time.time() * 1000), **payload}, ensure_ascii=False)
        stream = sys.stderr if lvl in ("error", "warn") else sys.stdout
        stream.write(line + "\n")
        stream.flush()

    def debug(self, payload: Dict[str, Any]) -> None:
        self._log("debug", payload)

    def info(self, payload: Dict[str, Any]) -> None:
        self._log("info", payload)

    def warn(self, payload: Dict[str, Any]) -> None:
        self._log("warn", payload)

    def error(self, payload: Dict[str, Any]) -> None:
        self._log("error", payload)

