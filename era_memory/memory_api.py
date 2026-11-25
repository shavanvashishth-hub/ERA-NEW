"""Local-only HTTP API for the memory engine (stdlib http.server; no web-framework dependency).

`MemoryAPI.dispatch(method, path, query, body, headers)` is framework independent: ERA can either run the
bundled server or mount `dispatch` inside its existing FastAPI/Flask app under any prefix.
"""
from __future__ import annotations

import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional, Tuple
from urllib.parse import parse_qs, urlparse

from .memory_config import MemoryConfig
from .memory_engine import MemoryEngine
from .memory_models import EraMemoryError, MemoryBackupError, MemoryNotFound, MemoryValidationError
from .memory_security import constant_time_equal, get_logger, load_or_create_token, validate_bind_host

MAX_BODY = 1_000_000
Response = Tuple[int, Dict[str, Any]]


def _f(body: Dict[str, Any], key: str, typ: type, default: Any = None, required: bool = False) -> Any:
    if key not in body or body[key] is None:
        if required:
            raise MemoryValidationError(f"'{key}' is required")
        return default
    v = body[key]
    if typ is float and isinstance(v, int) and not isinstance(v, bool):
        v = float(v)
    if not isinstance(v, typ) or (typ is int and isinstance(v, bool)):
        raise MemoryValidationError(f"'{key}' must be {typ.__name__}")
    return v


class MemoryAPI:
    def __init__(self, engine: MemoryEngine, config: Optional[MemoryConfig] = None):
        self.engine = engine
        self.cfg = config or engine.cfg
        self.prefix = self.cfg.api_prefix.rstrip("/")
        self.token = self.cfg.api_token or (load_or_create_token(self.cfg.token_path) if self.cfg.require_auth else None)
        self.log = get_logger("era_memory.api", self.cfg.log_level)

    # ------------------------------------------------------------------ auth
    def _authorized(self, headers: Dict[str, str]) -> bool:
        if not self.cfg.require_auth:
            return True
        h = {k.lower(): v for k, v in headers.items()}
        auth = h.get("authorization", "")
        supplied = auth[7:] if auth.lower().startswith("bearer ") else h.get("x-era-memory-token", "")
        return bool(self.token) and bool(supplied) and constant_time_equal(supplied, self.token)

    # ------------------------------------------------------------------ dispatch
    def dispatch(self, method: str, path: str, query: Optional[Dict[str, str]] = None,
                 body: Optional[Dict[str, Any]] = None, headers: Optional[Dict[str, str]] = None) -> Response:
        method, query, body, headers = method.upper(), query or {}, body or {}, headers or {}
        if not path.startswith(self.prefix + "/") and path != self.prefix:
            return 404, {"error": "not_found"}
        route = path[len(self.prefix):].rstrip("/") or "/"
        authed = self._authorized(headers)
        if method == "GET" and route == "/health":
            report = self.engine.health_check() if authed else {"status": "ok"}
            return (200 if report["status"] != "error" else 503), report
        if not authed:
            return 401, {"error": "unauthorized"}
        try:
            return self._route(method, route, query, body)
        except MemoryNotFound:
            return 404, {"error": "memory_not_found"}
        except (MemoryValidationError, ValueError, KeyError) as exc:
            return 400, {"error": "bad_request", "detail": str(exc)[:200]}
        except MemoryBackupError as exc:
            return 409, {"error": "backup_error", "detail": str(exc)[:200]}
        except EraMemoryError as exc:
            return 500, {"error": "memory_error", "detail": exc.__class__.__name__}
        except Exception as exc:                                    # never leak internals or content
            self.log.error("unhandled API error (%s)", exc.__class__.__name__)
            return 500, {"error": "internal_error"}

    def _route(self, method: str, route: str, q: Dict[str, str], b: Dict[str, Any]) -> Response:
        e = self.engine
        if method == "POST" and route == "/ingest":
            res = e.ingest(_f(b, "text", str, required=True), _f(b, "role", str, "user"), _f(b, "session_id", str),
                           _f(b, "project_id", str), _f(b, "channel", str, "api"), _f(b, "metadata", dict),
                           _f(b, "idempotency_key", str), _f(b, "occurred_at", float))
            return 200, res.to_dict()
        if method == "POST" and route == "/retrieve":
            pkg = e.retrieve_context(_f(b, "query", str, required=True), session_id=_f(b, "session_id", str),
                                     project_id=_f(b, "project_id", str), budget_tokens=_f(b, "budget_tokens", int),
                                     include_history=_f(b, "include_history", bool))
            return 200, pkg.to_dict()
        if method == "POST" and route == "/search":
            res = e.search_memory(_f(b, "query", str, required=True), limit=_f(b, "limit", int), types=_f(b, "types", list),
                                  project_id=_f(b, "project_id", str), strict_project=_f(b, "strict_project", bool, False),
                                  include_history=_f(b, "include_history", bool), session_id=_f(b, "session_id", str))
            return 200, {"results": [r.to_dict() for r in res]}
        if method == "POST" and route == "/consolidate":
            e.flush(timeout=10)
            return 200, e.consolidate_memories(_f(b, "project_id", str))
        if method == "GET" and route == "/profile":
            return 200, e.get_user_profile()
        m = re.fullmatch(r"/projects/([^/]+)", route)
        if method == "GET" and m:
            return 200, e.get_project_history(m.group(1))
        if method == "GET" and route == "/timeline":
            mems = e.get_memory_timeline(float(q["start"]) if "start" in q else None, float(q["end"]) if "end" in q else None,
                                         q.get("project_id"), q.get("session_id"), None, min(int(q.get("limit", 200)), 1000),
                                         q.get("include_archived") == "true")
            return 200, {"timeline": [x.to_dict() for x in mems]}
        if method == "POST" and route == "/backup":
            return 200, e.backup_memory(_f(b, "label", str, "manual"))
        if method == "POST" and route == "/restore":
            if b.get("confirm") is not True:
                raise MemoryValidationError("restore replaces the live database; send {\"confirm\": true}")
            return 200, e.restore_memory(_f(b, "backup_id", str, required=True), allow_external=False)
        if method == "GET" and route == "/backups":
            return 200, {"backups": e.backups.list_backups()}
        if method == "GET" and route == "/stats":
            return 200, e.get_memory_statistics()
        if method == "GET" and route == "/tasks":
            return 200, e.get_task_history(q.get("project_id"), q.get("state"))
        if method == "POST" and route == "/tasks":
            t = e.add_task(_f(b, "text", str, required=True), _f(b, "due_at", float), _f(b, "project_id", str))
            return 200, t.to_dict()
        m = re.fullmatch(r"/tasks/([^/]+)/complete", route)
        if method == "POST" and m:
            return 200, e.complete_task(m.group(1), _f(b, "outcome", str), _f(b, "cancelled", bool, False)).to_dict()
        if method == "POST" and route == "/link":
            ok = e.link_memories(_f(b, "a", str, required=True), _f(b, "b", str, required=True),
                                 _f(b, "relation", str, "related_to"), _f(b, "weight", float, 0.7))
            return 200, {"created": ok}
        m = re.fullmatch(r"/memories/([^/]+)(?:/(related|archive|versions))?", route)
        if m:
            mid, sub = m.group(1), m.group(2)
            if method == "GET" and sub is None:
                return 200, e.get_memory(mid).to_dict()
            if method == "GET" and sub == "related":
                return 200, e.get_related_memories(mid, int(q.get("hops", 2)), int(q.get("limit", 20)))
            if method == "GET" and sub == "versions":
                return 200, {"versions": e.get_memory_versions(mid)}
            if method == "POST" and sub == "archive":
                return 200, e.archive_memory(mid).to_dict()
            if method == "PATCH" and sub is None:
                return 200, e.update_memory(mid, content=_f(b, "content", str), importance=_f(b, "importance", float),
                                            confidence=_f(b, "confidence", float), state=_f(b, "state", str),
                                            reason=_f(b, "reason", str, "api update"), actor="api").to_dict()
            if method == "DELETE" and sub is None:
                return 200, e.delete_memory(mid, purge=q.get("purge") == "true")
        return 404, {"error": "not_found"}


class _Handler(BaseHTTPRequestHandler):
    api: MemoryAPI
    server_version = "ERAMemory/1"

    def log_message(self, fmt: str, *args: Any) -> None:       # request lines may contain ids only; keep quiet by default
        return

    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").split(":")[0].strip("[]").lower()
        return self.api.cfg.allow_remote or host in ("127.0.0.1", "localhost", "::1")   # blocks DNS-rebinding

    def _handle(self) -> None:
        if not self._host_ok():
            return self._send(403, {"error": "forbidden_host"})
        u = urlparse(self.path)
        query = {k: v[0] for k, v in parse_qs(u.query).items()}
        body: Dict[str, Any] = {}
        if self.command in ("POST", "PATCH", "PUT"):
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_BODY:
                return self._send(413, {"error": "payload_too_large"})
            raw = self.rfile.read(n) if n else b""
            try:
                body = json.loads(raw.decode("utf-8")) if raw else {}
                if not isinstance(body, dict):
                    raise ValueError
            except ValueError:
                return self._send(400, {"error": "invalid_json"})
        status, payload = self.api.dispatch(self.command, u.path, query, body, dict(self.headers))
        self._send(status, payload)

    def _send(self, status: int, payload: Dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_PATCH = do_DELETE = _handle


class MemoryServer:
    """Runs the API on 127.0.0.1 in a background thread (or in the foreground with serve_forever)."""

    def __init__(self, engine: MemoryEngine, config: Optional[MemoryConfig] = None):
        self.api = MemoryAPI(engine, config)
        cfg = self.api.cfg
        validate_bind_host(cfg.api_host, cfg.allow_remote)
        handler = type("BoundHandler", (_Handler,), {"api": self.api})
        self.httpd = ThreadingHTTPServer((cfg.api_host, cfg.api_port), handler)
        self.httpd.daemon_threads = True
        self._thread: Optional[threading.Thread] = None

    @property
    def port(self) -> int:
        return self.httpd.server_address[1]

    @property
    def token(self) -> Optional[str]:
        return self.api.token

    def start(self) -> "MemoryServer":
        self._thread = threading.Thread(target=self.httpd.serve_forever, name="era-memory-api", daemon=True)
        self._thread.start()
        return self

    def serve_forever(self) -> None:
        self.httpd.serve_forever()

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
