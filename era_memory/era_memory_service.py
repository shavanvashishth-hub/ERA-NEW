"""Local loopback HTTP service hosting ERA's Persistent Memory Engine.

Binds strictly to 127.0.0.1:8765 (configurable via ERA_MEMORY_API_PORT), requires
the per-user bearer token stored in <storage_dir>/api_token, and exposes all
standard MemoryAPI routes plus adapter helpers (/context-for, /startup-brief,
/turn, /procedure).
"""
from __future__ import annotations

import logging
import signal
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional

_HERE = str(Path(__file__).resolve().parent)
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from era_memory.memory_api import MemoryAPI, MemoryServer, Response
from era_memory.memory_models import MemoryValidationError
import era_memory_adapter as adapter

logger = logging.getLogger("era.memory_service")


class EraMemoryAPI(MemoryAPI):
    """Extends MemoryAPI with ERA-specific adapter routes while keeping core routes untouched."""

    def dispatch(
        self,
        method: str,
        path: str,
        query: Optional[Dict[str, str]] = None,
        body: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
    ) -> Response:
        method_u = method.upper()
        query = query or {}
        body = body or {}
        headers = headers or {}
        if path.startswith(self.prefix + "/") and self._authorized(headers):
            route = path[len(self.prefix):].rstrip("/") or "/"
            try:
                if method_u == "POST" and route == "/context-for":
                    t0 = time.perf_counter()
                    user_text = body.get("query") or body.get("user_text") or ""
                    if not isinstance(user_text, str):
                        raise MemoryValidationError("'query' must be str")
                    rendered = adapter.context_for(
                        user_text,
                        session_id=str(body.get("session_id") or "default"),
                        project_id=body.get("project_id"),
                        budget_tokens=body.get("budget_tokens"),
                        include_history=body.get("include_history"),
                        timeout_ms=float(body.get("timeout_ms") or 250.0),
                    )
                    return 200, {
                        "rendered_text": rendered,
                        "elapsed_ms": round((time.perf_counter() - t0) * 1000.0, 2),
                    }
                if method_u == "POST" and route == "/startup-brief":
                    t0 = time.perf_counter()
                    rendered = adapter.startup_brief(
                        session_id=body.get("session_id"),
                        budget_tokens=int(body.get("budget_tokens") or 900),
                    )
                    return 200, {
                        "rendered_text": rendered,
                        "elapsed_ms": round((time.perf_counter() - t0) * 1000.0, 2),
                    }
                if method_u == "POST" and route == "/turn":
                    user_text = str(body.get("user_text") or "")
                    assistant_text = str(body.get("assistant_text") or "")
                    out = adapter.remember_turn(
                        user_text=user_text,
                        assistant_text=assistant_text,
                        session_id=str(body.get("session_id") or "default"),
                        project_id=body.get("project_id"),
                        channel=str(body.get("channel") or "chat"),
                        idempotency_key=body.get("idempotency_key"),
                        wait=bool(body.get("wait", False)),
                    )
                    return 200, out
                if method_u == "POST" and route == "/procedure":
                    task = str(body.get("task") or "").strip()
                    if not task:
                        raise MemoryValidationError("'task' is required")
                    steps = body.get("steps") or []
                    if not isinstance(steps, list):
                        raise MemoryValidationError("'steps' must be list")
                    mid = adapter.record_mission_procedure(
                        task=task,
                        steps=[str(s) for s in steps],
                        outcome=str(body.get("outcome") or "success"),
                        project_id=body.get("project_id"),
                        error=body.get("error"),
                        recovery=body.get("recovery"),
                    )
                    return 200, {"recorded": mid is not None, "id": mid}
            except MemoryValidationError as exc:
                return 400, {"error": "bad_request", "detail": str(exc)[:200]}
            except Exception as exc:  # noqa: BLE001
                logger.error("adapter route error (%s)", exc.__class__.__name__)
                return 500, {"error": "internal_error"}
        return super().dispatch(method, path, query, body, headers)


class EraMemoryServer(MemoryServer):
    def __init__(self, engine):
        super().__init__(engine)
        self.api = EraMemoryAPI(engine, engine.cfg)
        # Rebind handler class to use the extended EraMemoryAPI instance
        self.httpd.RequestHandlerClass.api = self.api


def main() -> int:
    engine = adapter.get_engine()
    if engine is None:
        logger.error("Failed to initialize MemoryEngine; exiting.")
        return 1

    server = EraMemoryServer(engine)
    logger.info(
        "ERA Memory Service listening on http://%s:%d%s",
        engine.cfg.api_host,
        server.port,
        engine.cfg.api_prefix,
    )

    # Ensure at least one verified backup exists on startup if none exists yet
    try:
        if not engine.backups.list_backups():
            engine.backup_memory("auto")
    except Exception as exc:  # noqa: BLE001
        logger.warning("startup auto-backup skipped (%s)", exc.__class__.__name__)

    def _shutdown(_signum=None, _frame=None):
        try:
            server.httpd.shutdown()
        except Exception:
            pass

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, _shutdown)
        except Exception:
            pass

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            server.httpd.server_close()
        except Exception:
            pass
        adapter.close_engine()
    return 0


if __name__ == "__main__":
    sys.exit(main())
