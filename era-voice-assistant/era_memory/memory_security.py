"""Privacy and security helpers: secret redaction, safe logging, token auth, offline guard."""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import logging
import os
import re
import secrets
import socket
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Tuple

from .memory_models import MemoryConfigError

# --------------------------------------------------------------------------- secret redaction
_SECRET_PATTERNS = [
    ("api_key", re.compile(r"\b(?:sk|pk|rk)-[A-Za-z0-9_\-]{20,}\b")),
    ("api_key", re.compile(r"\bAIza[0-9A-Za-z_\-]{30,}\b")),
    ("api_key", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b")),
    ("api_key", re.compile(r"\bxox[abprs]-[A-Za-z0-9\-]{10,}\b")),
    ("api_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("bearer", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-]{20,}")),
    ("credential", re.compile(r"(?i)\b(password|passwd|pwd|passcode|secret|api[ _\-]?key|access[ _\-]?token)\b\s*(?:is|=|:)\s*\S+")),
    ("private_key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
]
_CARD = re.compile(r"\b(?:\d[ \-]?){13,19}\b")


def _luhn(digits: str) -> bool:
    total, alt = 0, False
    for ch in reversed(digits):
        d = int(ch)
        if alt:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        alt = not alt
    return total % 10 == 0


def redact_secrets(text: str) -> Tuple[str, int]:
    """Replace likely credentials / card numbers before anything is written to disk."""
    count = 0

    def sub_cred(m: "re.Match[str]") -> str:
        nonlocal count
        count += 1
        return f"{m.group(1)} [REDACTED]"

    for kind, pat in _SECRET_PATTERNS:
        if kind == "credential":
            text = pat.sub(sub_cred, text)
        else:
            text, n = pat.subn(f"[REDACTED:{kind}]", text)
            count += n

    def sub_card(m: "re.Match[str]") -> str:
        nonlocal count
        digits = re.sub(r"\D", "", m.group(0))
        if 13 <= len(digits) <= 19 and _luhn(digits):
            count += 1
            return "[REDACTED:card]"
        return m.group(0)

    return _CARD.sub(sub_card, text), count


_NO_STORE = re.compile(
    r"(?i)\b(?:(?:don'?t|do not|never)\s+(?:remember|save|store|keep|log)\s+(?:this|that|it)|off the record|"
    r"not for memory|(?:dont|don't) put this in memory)\b"
)


def wants_no_store(text: str) -> bool:
    return bool(_NO_STORE.search(text))


# --------------------------------------------------------------------------- prompt-injection hardening
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def sanitize_for_prompt(text: str) -> str:
    """Retrieved memories are DATA. Strip control chars and anything that mimics our context delimiters."""
    text = _CTRL.sub("", text)
    return text.replace("<<<", "‹‹‹").replace(">>>", "›››").replace("[[MEMORY", "[ MEMORY")


# --------------------------------------------------------------------------- logging that never carries content
def fingerprint(text: str) -> str:
    """Short non-reversible tag for correlating log lines without leaking content."""
    return "len=%d sha=%s" % (len(text), hashlib.sha256(text.encode("utf-8", "ignore")).hexdigest()[:8])


class _TruncatingFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        s = super().format(record)
        return s if len(s) <= 400 else s[:400] + "…[truncated]"


def get_logger(name: str = "era_memory", level: str = "INFO") -> logging.Logger:
    """Library logger. Engine code only logs ids, counts and fingerprints, never memory text."""
    log = logging.getLogger(name)
    log.setLevel(getattr(logging, level.upper(), logging.INFO))
    if not log.handlers and not logging.getLogger().handlers:
        h = logging.StreamHandler(sys.stderr)
        h.setFormatter(_TruncatingFormatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
        log.addHandler(h)
    return log


# --------------------------------------------------------------------------- filesystem + auth
def ensure_private_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    if os.name == "posix":
        try:
            os.chmod(path, 0o700)
        except OSError:
            pass
    return path


def restrict_file(path: Path) -> None:
    if os.name == "posix" and path.exists():
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass


def load_or_create_token(token_path: Path) -> str:
    """Local API bearer token, stored beside the database with owner-only permissions."""
    if token_path.exists():
        tok = token_path.read_text(encoding="utf-8").strip()
        if tok:
            return tok
    ensure_private_dir(token_path.parent)
    tok = secrets.token_urlsafe(32)
    token_path.write_text(tok, encoding="utf-8")
    restrict_file(token_path)
    return tok


def constant_time_equal(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def validate_bind_host(host: str, allow_remote: bool) -> None:
    """Refuse to expose personal memory beyond this machine unless explicitly allowed."""
    if allow_remote:
        return
    if host == "localhost":
        return
    try:
        if ipaddress.ip_address(host).is_loopback:
            return
    except ValueError:
        pass
    raise MemoryConfigError(f"refusing to bind memory API to non-loopback host {host!r} (allow_remote=False)")


# --------------------------------------------------------------------------- offline proof (used by tests / health)
class NetworkAccessAttempted(RuntimeError):
    pass


@contextmanager
def offline_guard() -> Iterator[None]:
    """Fail loudly if anything inside the block tries to open a non-loopback network connection."""
    real_connect = socket.socket.connect
    real_connect_ex = socket.socket.connect_ex
    real_gai = socket.getaddrinfo
    attempts = []

    def _is_local(addr) -> bool:
        if isinstance(addr, tuple) and addr:
            host = addr[0]
            if isinstance(host, str):
                if host in ("localhost", ""):
                    return True
                try:
                    return ipaddress.ip_address(host).is_loopback
                except ValueError:
                    return False
        return isinstance(addr, (str, bytes))  # AF_UNIX

    def guarded_connect(self, addr):
        if not _is_local(addr):
            attempts.append(addr)
            raise NetworkAccessAttempted(f"network access blocked: {addr!r}")
        return real_connect(self, addr)

    def guarded_connect_ex(self, addr):
        if not _is_local(addr):
            attempts.append(addr)
            raise NetworkAccessAttempted(f"network access blocked: {addr!r}")
        return real_connect_ex(self, addr)

    def guarded_gai(host, *a, **k):
        if host not in (None, "localhost", "127.0.0.1", "::1", ""):
            attempts.append(host)
            raise NetworkAccessAttempted(f"DNS lookup blocked: {host!r}")
        return real_gai(host, *a, **k)

    socket.socket.connect = guarded_connect  # type: ignore[assignment]
    socket.socket.connect_ex = guarded_connect_ex  # type: ignore[assignment]
    socket.getaddrinfo = guarded_gai  # type: ignore[assignment]
    try:
        yield
    finally:
        socket.socket.connect = real_connect  # type: ignore[assignment]
        socket.socket.connect_ex = real_connect_ex  # type: ignore[assignment]
        socket.getaddrinfo = real_gai  # type: ignore[assignment]
    if attempts:
        raise NetworkAccessAttempted(f"network access attempted: {attempts}")
