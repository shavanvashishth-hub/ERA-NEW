"""Typed models and exceptions for the ERA memory engine."""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional


# --------------------------------------------------------------------------- exceptions
class EraMemoryError(Exception):
    """Base class for all engine errors."""


class MemoryConfigError(EraMemoryError):
    pass


class MemoryValidationError(EraMemoryError):
    pass


class MemoryNotFound(EraMemoryError):
    pass


class MemoryCorruptionError(EraMemoryError):
    pass


class MemoryBackupError(EraMemoryError):
    pass


# --------------------------------------------------------------------------- enums
class MemoryType(str, Enum):
    EPISODIC = "episodic"        # what happened (interactions, decisions, outcomes)
    SEMANTIC = "semantic"        # consolidated facts, preferences, project knowledge
    PROCEDURAL = "procedural"    # how things were done, what worked / failed
    PROSPECTIVE = "prospective"  # things to do later


class MemoryStatus(str, Enum):
    ACTIVE = "active"
    ARCHIVED = "archived"        # kept, but no longer retrieved by default
    SUPERSEDED = "superseded"    # replaced by a newer fact; history preserved
    DELETED = "deleted"          # soft-deleted (recoverable until purged)


class Epistemic(str, Enum):
    CONFIRMED = "confirmed"      # stated directly by the user (or verified)
    INFERRED = "inferred"        # derived by the engine from repeated evidence
    ASSUMED = "assumed"          # said by the assistant/tool, or low-confidence extraction


class TaskState(str, Enum):
    PENDING = "pending"
    DONE = "done"
    CANCELLED = "cancelled"


class Flag(str, Enum):
    """Lightweight contextual-importance signals (heuristic, never claimed as true emotion detection)."""
    HIGHLY_IMPORTANT = "highly_important"
    PERSONALLY_MEANINGFUL = "personally_meaningful"
    REPEATED = "repeated"
    TEMPORARY = "temporary"
    PROJECT_CRITICAL = "project_critical"
    TIME_SENSITIVE = "time_sensitive"
    DECISION = "decision"
    FAILURE = "failure"
    RECOVERY = "recovery"
    DIGEST = "digest"


# --------------------------------------------------------------------------- helpers
def new_id(prefix: str = "mem") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:20]}"


def now_ts() -> float:
    return time.time()


def iso(ts: Optional[float]) -> Optional[str]:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="seconds")


def clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


# --------------------------------------------------------------------------- core record
@dataclass
class Memory:
    id: str
    type: MemoryType
    content: str
    summary: Optional[str] = None
    source: str = "unknown"              # user | assistant | tool | system | engine | import
    source_ref: Optional[str] = None     # provenance: originating memory / interaction id
    session_id: Optional[str] = None
    project_id: Optional[str] = None
    importance: float = 0.3
    confidence: float = 0.5
    epistemic: Epistemic = Epistemic.ASSUMED
    status: MemoryStatus = MemoryStatus.ACTIVE
    state: Optional[str] = None          # prospective: pending/done/cancelled
    created_at: float = field(default_factory=now_ts)
    updated_at: float = field(default_factory=now_ts)
    event_time: Optional[float] = None
    due_at: Optional[float] = None
    valid_from: Optional[float] = None
    valid_to: Optional[float] = None
    mention_count: int = 1
    access_count: int = 0
    last_accessed: Optional[float] = None
    version: int = 1
    content_hash: str = ""
    fact_key: Optional[str] = None       # subject|predicate[|object] for semantic facts
    fact_value: Optional[str] = None
    flags: List[str] = field(default_factory=list)
    topics: List[str] = field(default_factory=list)
    entities: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)
    idem_key: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id, "type": self.type.value, "content": self.content, "summary": self.summary,
            "source": self.source, "source_ref": self.source_ref, "session_id": self.session_id,
            "project_id": self.project_id, "importance": round(self.importance, 3),
            "confidence": round(self.confidence, 3), "epistemic": self.epistemic.value,
            "status": self.status.value, "state": self.state,
            "created_at": iso(self.created_at), "updated_at": iso(self.updated_at),
            "event_time": iso(self.event_time), "due_at": iso(self.due_at),
            "valid_from": iso(self.valid_from), "valid_to": iso(self.valid_to),
            "mention_count": self.mention_count, "access_count": self.access_count,
            "last_accessed": iso(self.last_accessed), "version": self.version,
            "fact_key": self.fact_key, "fact_value": self.fact_value, "flags": list(self.flags),
            "topics": list(self.topics), "entities": list(self.entities), "metadata": dict(self.metadata),
        }


@dataclass
class RetrievedMemory:
    memory: Memory
    score: float
    breakdown: Dict[str, float] = field(default_factory=dict)
    reasons: List[str] = field(default_factory=list)   # e.g. "keyword match", "via entity ERA (2 hops)"

    def to_dict(self) -> Dict[str, Any]:
        return {"score": round(self.score, 4), "breakdown": {k: round(v, 4) for k, v in self.breakdown.items()},
                "reasons": self.reasons, "memory": self.memory.to_dict()}


@dataclass
class ContextPackage:
    query: str
    intent: str
    entities: List[str]
    topics: List[str]
    items: List[RetrievedMemory]
    rendered_text: str
    tokens_estimate: int
    budget_tokens: int
    truncated: bool
    candidates_considered: int
    elapsed_ms: float
    sections: Dict[str, List[str]] = field(default_factory=dict)   # section -> memory ids
    working_memory: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "query": self.query, "intent": self.intent, "entities": self.entities, "topics": self.topics,
            "rendered_text": self.rendered_text, "tokens_estimate": self.tokens_estimate,
            "budget_tokens": self.budget_tokens, "truncated": self.truncated,
            "candidates_considered": self.candidates_considered, "elapsed_ms": round(self.elapsed_ms, 2),
            "sections": self.sections, "working_memory": self.working_memory,
            "items": [i.to_dict() for i in self.items],
        }


@dataclass
class IngestResult:
    stored: bool
    persisted_verified: bool              # True only after the commit was read back
    episodic_id: Optional[str] = None
    derived_ids: List[str] = field(default_factory=list)
    skipped_reason: Optional[str] = None
    redactions: int = 0
    entities: List[str] = field(default_factory=list)
    job_id: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        return {"stored": self.stored, "persisted_verified": self.persisted_verified,
                "episodic_id": self.episodic_id, "derived_ids": self.derived_ids,
                "skipped_reason": self.skipped_reason, "redactions": self.redactions,
                "entities": self.entities, "job_id": self.job_id}


@dataclass
class ConsolidationReport:
    processed: int = 0
    duplicates_merged: int = 0
    facts_superseded: int = 0
    retractions_applied: int = 0
    digests_updated: int = 0
    archived: int = 0
    links_created: int = 0
    importance_updates: int = 0

    def to_dict(self) -> Dict[str, int]:
        return dict(self.__dict__)
