"""FalkorDB connection management.

Uses a FalkorDB server when ``FALKORDB_HOST`` is set (Docker Compose / hosted), otherwise an
embedded FalkorDB instance via ``falkordblite`` so the project runs with no external services.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path

_lock = threading.Lock()
_db = None


class GraphUnavailableError(RuntimeError):
    """Raised when FalkorDB cannot be reached. Agents must halt rather than improvise."""


def get_db():
    global _db
    with _lock:
        if _db is not None:
            return _db
        host = os.environ.get("FALKORDB_HOST")
        try:
            if host:
                from falkordb import FalkorDB

                _db = FalkorDB(host=host, port=int(os.environ.get("FALKORDB_PORT", "6379")))
            else:
                from redislite.falkordb_client import FalkorDB as EmbeddedFalkorDB

                path = Path(os.environ.get("PARADOX_DB_PATH", Path(__file__).resolve().parents[2] / ".data" / "paradox.db"))
                path.parent.mkdir(parents=True, exist_ok=True)
                _db = EmbeddedFalkorDB(str(path))
        except Exception as exc:  # pragma: no cover - environment dependent
            raise GraphUnavailableError(f"cannot connect to FalkorDB: {exc}") from exc
        return _db


def graph_name(case_id: str) -> str:
    prefix = os.environ.get("PARADOX_GRAPH_PREFIX", "paradox")
    return f"{prefix}_{case_id}"
