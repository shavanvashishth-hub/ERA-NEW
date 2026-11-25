"""Local embedding backends and an in-process vector index. Nothing here touches the network.

Backends
- HashingEmbedder: zero-dependency feature hashing (words, bigrams, char trigrams). Deterministic and
  offline. It captures lexical / morphological similarity, NOT deep paraphrase semantics.
- SentenceTransformerEmbedder: true semantic vectors from a model directory that already exists on disk
  (never downloaded by this package; offline mode is forced).
"""
from __future__ import annotations

import math
import os
import threading
import zlib
from array import array
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from .memory_models import MemoryConfigError
from .memory_text import content_tokens

try:  # optional accelerator
    import numpy as _np
except Exception:  # pragma: no cover - numpy is optional
    _np = None


class Embedder:
    name: str = "base"
    dim: int = 0

    def embed(self, text: str) -> "array[float]":  # pragma: no cover - interface
        raise NotImplementedError


def _normalize(vec: List[float]) -> "array[float]":
    norm = math.sqrt(sum(v * v for v in vec))
    if norm == 0:
        return array("f", vec)
    return array("f", [v / norm for v in vec])


class HashingEmbedder(Embedder):
    def __init__(self, dim: int = 512):
        self.dim = dim
        self.name = f"hashing-v1-{dim}"

    def _add(self, vec: List[float], feat: str, w: float) -> None:
        b = feat.encode("utf-8")
        idx = zlib.crc32(b) % self.dim
        sign = 1.0 if (zlib.crc32(b"\x00" + b) & 1) else -1.0
        vec[idx] += sign * w

    def embed(self, text: str) -> "array[float]":
        toks = content_tokens(text)
        vec = [0.0] * self.dim
        tf: Dict[str, int] = {}
        for t in toks:
            tf[t] = tf.get(t, 0) + 1
        for t, c in tf.items():
            self._add(vec, "u:" + t, 1.0 + math.log(c))
            if len(t) >= 4:
                padded = f"^{t}$"
                for i in range(len(padded) - 2):
                    self._add(vec, "c:" + padded[i:i + 3], 0.2)
        for a, b in zip(toks, toks[1:]):
            self._add(vec, f"b:{a}_{b}", 0.6)
        return _normalize(vec)


class SentenceTransformerEmbedder(Embedder):
    def __init__(self, model_path: str):
        p = Path(model_path).expanduser()
        if not p.exists():
            raise MemoryConfigError(f"embedding model directory not found: {p} (models are never auto-downloaded)")
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        try:
            from sentence_transformers import SentenceTransformer  # lazy import
        except Exception as exc:
            raise MemoryConfigError("sentence-transformers is not installed (optional dependency)") from exc
        self._model = SentenceTransformer(str(p), device="cpu")
        self.dim = int(self._model.get_sentence_embedding_dimension())
        self.name = f"st:{p.name}:{self.dim}"
        self._lock = threading.Lock()

    def embed(self, text: str) -> "array[float]":
        with self._lock:
            v = self._model.encode(text, normalize_embeddings=True, show_progress_bar=False)
        return array("f", [float(x) for x in v])


def make_embedder(backend: str, dim: int, model_path: Optional[str]) -> Embedder:
    if backend == "sentence_transformers":
        return SentenceTransformerEmbedder(model_path or "")
    return HashingEmbedder(dim)


def to_blob(vec: "array[float]") -> bytes:
    return vec.tobytes()


def from_blob(blob: bytes) -> "array[float]":
    a = array("f")
    a.frombytes(blob)
    return a


class VectorIndex:
    """Exact cosine search over unit vectors. Fine to ~100k memories; swap in an ANN index beyond that."""

    def __init__(self, dim: int):
        self.dim = dim
        self._vecs: Dict[str, "array[float]"] = {}
        self._lock = threading.RLock()
        self._ids: List[str] = []
        self._mat = None
        self._dirty = True

    def __len__(self) -> int:
        return len(self._vecs)

    def add(self, mid: str, vec: "array[float]") -> None:
        with self._lock:
            self._vecs[mid] = vec
            self._dirty = True

    def remove(self, mid: str) -> None:
        with self._lock:
            if self._vecs.pop(mid, None) is not None:
                self._dirty = True

    def clear(self) -> None:
        with self._lock:
            self._vecs.clear()
            self._dirty = True

    def _rebuild(self) -> None:
        self._ids = list(self._vecs.keys())
        if _np is not None and self._ids:
            self._mat = _np.vstack([_np.frombuffer(self._vecs[i], dtype=_np.float32) for i in self._ids])
        else:
            self._mat = None
        self._dirty = False

    def search(self, vec: "array[float]", k: int = 20, min_sim: float = 0.0) -> List[Tuple[str, float]]:
        with self._lock:
            if not self._vecs:
                return []
            if self._dirty:
                self._rebuild()
            if self._mat is not None:
                sims = self._mat @ _np.frombuffer(vec, dtype=_np.float32)
                k = min(k, len(self._ids))
                idx = _np.argpartition(-sims, k - 1)[:k] if k < len(self._ids) else _np.arange(len(self._ids))
                pairs = [(self._ids[i], float(sims[i])) for i in idx]
            else:
                pairs = [(i, sum(a * b for a, b in zip(v, vec))) for i, v in self._vecs.items()]
        pairs = [p for p in pairs if p[1] >= min_sim]
        pairs.sort(key=lambda p: -p[1])
        return pairs[:k]

    def similarity(self, a: str, b: str) -> Optional[float]:
        with self._lock:
            va, vb = self._vecs.get(a), self._vecs.get(b)
        if va is None or vb is None:
            return None
        return sum(x * y for x, y in zip(va, vb))


class VectorStore:
    """Binds an embedder + in-memory index to the repository (lazy-loaded from SQLite BLOBs)."""

    def __init__(self, embedder: Embedder, repo) -> None:
        self.embedder = embedder
        self.repo = repo
        self.index = VectorIndex(embedder.dim)
        self._loaded = False
        self._lock = threading.Lock()

    @property
    def name(self) -> str:
        return self.embedder.name

    def ensure_loaded(self) -> None:
        if self._loaded:
            return
        with self._lock:
            if self._loaded:
                return
            for mid, blob in self.repo.embeddings(self.embedder.name):
                self.index.add(mid, from_blob(blob))
            self._loaded = True

    def embed(self, text: str) -> "array[float]":
        return self.embedder.embed(text)

    def add(self, mid: str, vec: "array[float]") -> None:
        self.index.add(mid, vec)

    def remove(self, mid: str) -> None:
        self.index.remove(mid)

    def search(self, vec: "array[float]", k: int = 20, min_sim: float = 0.0) -> List[Tuple[str, float]]:
        self.ensure_loaded()
        return self.index.search(vec, k, min_sim)

    def vector_of(self, mid: str) -> Optional["array[float]"]:
        self.ensure_loaded()
        return self.index._vecs.get(mid)

    def reindex(self) -> int:
        """Re-embed memories stored under a different embedder (e.g. after switching backends)."""
        n = 0
        for mid in self.repo.stale_embedding_ids(self.embedder.name):
            m = self.repo.get(mid, with_entities=False)
            if m is None:
                continue
            vec = self.embed(m.content)
            self.repo.update_memory(mid, {}, versioned=False, embedding=vec, embedder=self.embedder.name)
            self.index.add(mid, vec)
            n += 1
        return n
