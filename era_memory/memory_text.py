"""Text and time helpers shared by every memory module (stdlib only, fully offline)."""
from __future__ import annotations

import hashlib
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Tuple

_IST = timezone(timedelta(hours=5, minutes=30))

STOPWORDS = frozenset(
    """a an the and or but if then else of to in on at by for with from into over under about as is are was
    were be been being am do does did done have has had having i me my mine we us our ours you your yours he
    him his she her hers it its they them their theirs this that these those there here what which who whom
    whose when where why how can could should would will shall may might must not no nor so than too very
    just also again further once only own same some such any each few more most other both all let lets
    please ok okay yes hey hi hello thanks thank really get got make made going gonna s t re ve ll d m
    """.split()
)

_WORD = re.compile(r"\w+", re.UNICODE)
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_SENT = re.compile(r"(?<=[.!?\u0964])\s+|\n+")


def normalize_text(text: str, max_chars: Optional[int] = None) -> str:
    t = unicodedata.normalize("NFC", text or "")
    t = _CTRL.sub("", t).replace("\r\n", "\n").replace("\r", "\n")
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n{3,}", "\n\n", t).strip()
    if max_chars and len(t) > max_chars:
        t = t[:max_chars].rstrip()
    return t


def tokens(text: str) -> List[str]:
    return [w for w in _WORD.findall((text or "").lower()) if len(w) > 1 or w.isdigit()]


def stem(w: str) -> str:
    """Tiny deterministic stemmer; only needs to be *consistent*, not linguistically perfect."""
    if len(w) <= 3 or not w.isascii():
        return w
    if w.endswith("ies") and len(w) > 4:
        w = w[:-3] + "y"
    elif w.endswith("sses"):
        w = w[:-2]
    elif w.endswith("ing") and len(w) > 5:
        s = w[:-3]
        if len(s) > 2 and s[-1] == s[-2] and s[-1] not in "lsz":
            s = s[:-1]
        w = s
    elif w.endswith("ed") and len(w) > 4:
        w = w[:-2]
    elif w.endswith("s") and not w.endswith(("ss", "us", "is")):
        w = w[:-1]
    if w.endswith("e") and len(w) > 4:
        w = w[:-1]
    return w


def content_words(text: str) -> List[str]:
    """Lowercased, stop-word-free surface words (used for FTS queries; FTS does its own stemming)."""
    return [w for w in tokens(text) if w not in STOPWORDS]


def content_tokens(text: str) -> List[str]:
    return [stem(w) for w in content_words(text)]


def canon(name: str) -> str:
    c = re.sub(r"[^\w]+", " ", (name or "").lower()).strip()
    return re.sub(r"^(the|a|an|my|our)\s+", "", c)


def content_hash(text: str) -> str:
    return hashlib.sha256(" ".join(tokens(text)).encode("utf-8")).hexdigest()[:32]


def est_tokens(text: str) -> int:
    return int(len(text) / 3.5) + 1


def split_sentences(text: str) -> List[str]:
    return [s.strip() for s in _SENT.split(text or "") if s and s.strip()]


def clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    cut = text[:limit]
    for sep in (". ", "! ", "? ", "\n", "; ", ", ", " "):
        i = cut.rfind(sep)
        if i > limit * 0.5:
            cut = cut[: i + (1 if sep.strip() else 0)]
            break
    return cut.rstrip() + "…"


# --------------------------------------------------------------------------- time parsing
_WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september",
           "october", "november", "december"]
_UNIT = {"minute": 60, "hour": 3600, "day": 86400, "week": 7 * 86400, "month": 30 * 86400}


def _eod(d: datetime) -> datetime:
    return d.replace(hour=23, minute=59, second=0, microsecond=0)


def _sod(d: datetime) -> datetime:
    return d.replace(hour=0, minute=0, second=0, microsecond=0)


def parse_due(text: str, now: float) -> Optional[float]:
    """Best-effort deadline extraction (IST / Asia/Kolkata). Returns an epoch timestamp or None."""
    t = text.lower()
    base = datetime.fromtimestamp(now, _IST)
    m = re.search(r"\b(\d{4})-(\d{2})-(\d{2})\b", t)
    if m:
        try:
            return _eod(datetime(int(m[1]), int(m[2]), int(m[3]), tzinfo=_IST)).timestamp()
        except ValueError:
            pass
    m = re.search(r"\bin (\d+|an?|one|two|three|a few) (minute|hour|day|week|month)s?\b", t)
    if m:
        n = {"a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "a few": 3}.get(m[1]) or int(m[1])
        return now + n * _UNIT[m[2]]
    if "day after tomorrow" in t:
        return _eod(base + timedelta(days=2)).timestamp()
    if "tomorrow" in t:
        return _eod(base + timedelta(days=1)).timestamp()
    if re.search(r"\b(today|tonight|this evening)\b", t):
        return _eod(base).timestamp()
    if "next week" in t:
        return _eod(base + timedelta(days=7)).timestamp()
    if "next month" in t:
        return _eod(base + timedelta(days=30)).timestamp()
    if "this weekend" in t:
        return _eod(base + timedelta(days=(5 - base.weekday()) % 7 or 7)).timestamp()
    m = re.search(r"\b(?:next|on|by|this|before)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b", t)
    if m:
        delta = (_WEEKDAYS.index(m[1]) - base.weekday()) % 7 or 7
        return _eod(base + timedelta(days=delta)).timestamp()
    m = re.search(r"\b(?:on |by )?(\d{1,2})(?:st|nd|rd|th)? (" + "|".join(_MONTHS) + r")\b", t) or \
        re.search(r"\b(?:on |by )?(" + "|".join(_MONTHS) + r") (\d{1,2})(?:st|nd|rd|th)?\b", t)
    if m:
        a, b = m.group(1), m.group(2)
        day, mon = (int(a), b) if a.isdigit() else (int(b), a)
        try:
            d = datetime(base.year, _MONTHS.index(mon) + 1, day, tzinfo=_IST)
            if d < _sod(base):
                d = d.replace(year=base.year + 1)
            return _eod(d).timestamp()
        except ValueError:
            return None
    return None


def parse_range(query: str, now: float) -> Optional[Tuple[float, float]]:
    """Resolve relative time phrases in a query ('yesterday', 'last week', '3 days ago') in IST."""
    t = query.lower()
    base = datetime.fromtimestamp(now, _IST)
    today = _sod(base)
    if "yesterday" in t:
        return ((today - timedelta(days=1)).timestamp(), today.timestamp())
    if "last night" in t:
        return ((today - timedelta(hours=6)).timestamp(), (today + timedelta(hours=6)).timestamp())
    if re.search(r"\b(today|earlier today|this morning)\b", t):
        return (today.timestamp(), now)
    if "last week" in t:
        monday = today - timedelta(days=today.weekday())
        return ((monday - timedelta(days=7)).timestamp(), monday.timestamp())
    if "this week" in t:
        return ((today - timedelta(days=today.weekday())).timestamp(), now)
    if "last month" in t:
        first = today.replace(day=1)
        prev = (first - timedelta(days=1)).replace(day=1)
        return (prev.timestamp(), first.timestamp())
    m = re.search(r"\b(\d+|a few|few|couple of|two|three) days? ago\b", t)
    if m:
        n = {"a few": 3, "few": 3, "couple of": 2, "two": 2, "three": 3}.get(m[1]) or int(m[1])
        return ((today - timedelta(days=n + 1)).timestamp(), (today - timedelta(days=max(n - 1, 0))).timestamp() + 86400)
    if re.search(r"\b(recently|lately|the other day)\b", t):
        return (now - 7 * 86400, now)
    return None
