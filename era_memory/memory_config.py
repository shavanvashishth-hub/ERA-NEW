"""Configuration for the ERA memory engine. No absolute paths are hardcoded."""
from __future__ import annotations

import os
import sys
from dataclasses import MISSING, dataclass, field, fields
from pathlib import Path
from typing import Dict, Optional, Union

from .memory_models import MemoryConfigError


def default_storage_dir() -> Path:
    """Per-user, OS-appropriate data directory (override with ERA_MEMORY_DIR)."""
    env = os.environ.get("ERA_MEMORY_DIR")
    if env:
        return Path(env).expanduser()
    if sys.platform.startswith("win"):
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "ERA" / "memory"
    xdg = os.environ.get("XDG_DATA_HOME")
    return (Path(xdg) if xdg else Path.home() / ".local" / "share") / "era" / "memory"


DEFAULT_WEIGHTS: Dict[str, float] = {
    "fts": 0.22,        # BM25 keyword relevance
    "vector": 0.26,     # semantic similarity
    "entity": 0.16,     # shared entities with the query / working memory
    "graph": 0.12,      # multi-hop association activation
    "temporal": 0.05,   # inside an explicitly requested time window
    "importance": 0.10,
    "recency": 0.05,
    "confidence": 0.04,
}


@dataclass
class MemoryConfig:
    storage_dir: Union[str, Path] = field(default_factory=default_storage_dir)
    db_filename: str = "era_memory.db"
    synchronous: str = "FULL"              # FULL = durable commit even on power loss (WAL mode)

    # embeddings (local only)
    embedding_backend: str = "hashing"     # "hashing" (zero-dependency) | "sentence_transformers" (local model dir)
    embedding_dim: int = 512
    embedding_model_path: Optional[str] = None

    # retrieval
    context_token_budget: int = 1200
    default_result_limit: int = 12
    candidate_pool: int = 60
    recency_half_life_days: float = 45.0
    weights: Dict[str, float] = field(default_factory=lambda: dict(DEFAULT_WEIGHTS))
    graph_hops: int = 2
    graph_fanout: int = 8
    record_access: bool = True

    # associative / consolidation
    link_top_k: int = 8
    similarity_link_threshold: float = 0.45
    duplicate_similarity_threshold: float = 0.93
    digest_min_mentions: int = 3
    temporary_ttl_days: float = 21.0
    consolidation_interval_s: float = 3600.0   # periodic background pass when idle (0 = disabled)
    assistant_turn_ttl_days: float = 45.0

    # ingestion
    async_processing: bool = True
    job_poll_interval: float = 0.5
    job_max_attempts: int = 5
    skip_trivial: bool = True
    store_assistant_turns: bool = True
    redact_secrets: bool = True
    max_content_chars: int = 8000

    # backup
    backup_keep: int = 10

    # local API
    api_host: str = "127.0.0.1"
    api_port: int = 8765
    api_prefix: str = "/memory"
    api_token: Optional[str] = None
    require_auth: bool = True
    allow_remote: bool = False

    log_level: str = "INFO"

    def __post_init__(self) -> None:
        self.storage_dir = Path(self.storage_dir).expanduser()
        self.validate()

    # -- derived paths
    @property
    def db_path(self) -> Path:
        return Path(self.storage_dir) / self.db_filename

    @property
    def backup_dir(self) -> Path:
        return Path(self.storage_dir) / "backups"

    @property
    def token_path(self) -> Path:
        return Path(self.storage_dir) / "api_token"

    def validate(self) -> None:
        if self.synchronous.upper() not in {"FULL", "NORMAL", "EXTRA"}:
            raise MemoryConfigError("synchronous must be FULL, NORMAL or EXTRA")
        if self.embedding_backend not in {"hashing", "sentence_transformers"}:
            raise MemoryConfigError("embedding_backend must be 'hashing' or 'sentence_transformers'")
        if self.embedding_backend == "sentence_transformers" and not self.embedding_model_path:
            raise MemoryConfigError("sentence_transformers needs embedding_model_path (a LOCAL model directory)")
        if self.embedding_dim < 64:
            raise MemoryConfigError("embedding_dim must be >= 64")
        if self.context_token_budget < 100:
            raise MemoryConfigError("context_token_budget must be >= 100")
        if not self.api_prefix.startswith("/"):
            raise MemoryConfigError("api_prefix must start with '/'")
        unknown = set(self.weights) - set(DEFAULT_WEIGHTS)
        if unknown:
            raise MemoryConfigError(f"unknown ranking weights: {sorted(unknown)}")

    @classmethod
    def from_env(cls, **overrides) -> "MemoryConfig":
        """Environment variables: ERA_MEMORY_<FIELD_NAME_UPPERCASE> (e.g. ERA_MEMORY_API_PORT)."""
        kwargs = {}
        for f in fields(cls):
            if f.name in ("weights",):
                continue
            raw = os.environ.get("ERA_MEMORY_" + f.name.upper())
            if raw is None:
                continue
            default = f.default if f.default is not MISSING else None
            if isinstance(default, bool):
                kwargs[f.name] = raw.strip().lower() in {"1", "true", "yes", "on"}
            elif isinstance(default, int):
                kwargs[f.name] = int(raw)
            elif isinstance(default, float):
                kwargs[f.name] = float(raw)
            else:
                kwargs[f.name] = raw
        kwargs.update(overrides)
        return cls(**kwargs)
