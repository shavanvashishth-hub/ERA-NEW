"""MemoryEngine: the single, stable Python interface ERA integrates with.

Lifecycle: Capture → Normalize → Extract → Validate → Store (durable commit) → Connect → Consolidate →
Retrieve → Reason (ERA's own model) → Verify → Update.
"""
from __future__ import annotations

import shutil
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple, Union

from .associative_memory import AssociativeMemory
from .memory_backup import BackupManager
from .memory_config import MemoryConfig
from .memory_consolidator import MemoryConsolidator
from .memory_database import Database, MemoryRepository
from .memory_embeddings import Embedder, VectorStore, make_embedder
from .memory_extractor import Extraction, MemoryExtractor
from .memory_models import (ConsolidationReport, ContextPackage, Epistemic, EraMemoryError, Flag, IngestResult, Memory,
                            MemoryNotFound, MemoryStatus, MemoryType, MemoryValidationError, RetrievedMemory,
                            TaskState, clamp, iso, new_id, now_ts)
from .memory_retriever import MemoryRetriever
from .memory_security import get_logger, redact_secrets, wants_no_store
from .memory_text import canon, clip, content_hash, content_tokens, est_tokens, normalize_text
from .working_memory import WorkingMemory

_ROLES = {"user", "assistant", "system", "tool"}
_IDENTITY = ("name", "role", "location", "origin", "workplace", "studies")


class MemoryEngine:
    def __init__(self, config: Optional[MemoryConfig] = None, *, embedder: Optional[Embedder] = None,
                 llm_extractor: Optional[Callable[[str, str], Extraction]] = None):
        self.cfg = config or MemoryConfig.from_env()
        self.log = get_logger("era_memory", self.cfg.log_level)
        self.db = Database(self.cfg.db_path, self.cfg.synchronous, backup_dir=self.cfg.backup_dir)
        self.repo = MemoryRepository(self.db)
        emb = embedder or make_embedder(self.cfg.embedding_backend, self.cfg.embedding_dim, self.cfg.embedding_model_path)
        self.vstore = VectorStore(emb, self.repo)
        self.extractor = MemoryExtractor(llm_extractor)
        self.assoc = AssociativeMemory(self.repo, self.vstore, self.cfg)
        self.consolidator = MemoryConsolidator(self.repo, self.vstore, self.assoc, self.cfg)
        self.retriever = MemoryRetriever(self.repo, self.vstore, self.assoc, self.extractor, self.cfg)
        self.backups = BackupManager(self.db, self.cfg)
        self.working = WorkingMemory()
        self._proc_lock = threading.RLock()
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._worker: Optional[threading.Thread] = None
        self._last_pass = time.time()
        self._closed = False
        self._reconcile_embedder()
        self.repo.requeue_stale_jobs()          # jobs interrupted by a crash are resumed, never dropped
        if self.cfg.async_processing:
            self._worker = threading.Thread(target=self._worker_loop, name="era-memory-worker", daemon=True)
            self._worker.start()
            if self.repo.job_counts().get("pending"):
                self._wake.set()
        self.log.info("memory engine started (schema v%s, embedder=%s)", self.db.schema_version, self.vstore.name)

    # ------------------------------------------------------------------ context manager / lifecycle
    def __enter__(self) -> "MemoryEngine":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self.flush(timeout=5.0)
        except Exception:
            pass
        self._stop.set()
        self._wake.set()
        if self._worker and self._worker.is_alive():
            self._worker.join(timeout=5.0)
        self.db.checkpoint()
        self.db.close_all()

    def _reconcile_embedder(self) -> None:
        row = self.db.query_one("SELECT value FROM meta WHERE key='embedder'")
        name = self.vstore.name
        if row is None:
            self.db.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('embedder',?)", (name,))
        elif row["value"] != name:
            n = self.vstore.reindex()
            self.db.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('embedder',?)", (name,))
            self.log.info("embedder changed; re-embedded %d memories", n)

    # ------------------------------------------------------------------ ingestion pipeline
    def ingest(self, text: str, role: str = "user", session_id: Optional[str] = None, project_id: Optional[str] = None,
               channel: str = "chat", metadata: Optional[Dict[str, Any]] = None, idempotency_key: Optional[str] = None,
               occurred_at: Optional[float] = None, wait: bool = False) -> IngestResult:
        """Capture one interaction. `stored=True, persisted_verified=True` is returned only after the commit is read back."""
        role = (role or "user").lower()
        if role not in _ROLES:
            raise MemoryValidationError(f"role must be one of {sorted(_ROLES)}")
        raw = normalize_text(text, self.cfg.max_content_chars)
        if not raw:
            return IngestResult(False, False, skipped_reason="empty")
        if wants_no_store(raw):
            return IngestResult(False, False, skipped_reason="user_opted_out")
        if role == "assistant" and not self.cfg.store_assistant_turns:
            return IngestResult(False, False, skipped_reason="assistant_turns_disabled")
        redactions = 0
        if self.cfg.redact_secrets:
            raw, redactions = redact_secrets(raw)
        if idempotency_key:
            prior = self.repo.get_by_idem(idempotency_key)
            if prior:
                return IngestResult(True, True, episodic_id=prior.id, skipped_reason="duplicate_idempotency_key")

        ts = occurred_at or now_ts()
        ex = self.extractor.extract(raw, role, self.repo.known_entities(), ts)
        working = self.working.snapshot(session_id)
        if session_id:
            self.working.observe_turn(session_id, role, raw, [e.name for e in ex.entities],
                                      canon(ex.projects[0]) if ex.projects else project_id)
        if self.cfg.skip_trivial and ex.trivial and not ex.facts and not ex.tasks:
            return IngestResult(False, False, skipped_reason="trivial", redactions=redactions)

        project = project_id or (canon(ex.projects[0]) if ex.projects else working.get("active_project"))
        epi = Epistemic.CONFIRMED if role == "user" else Epistemic.ASSUMED
        meta = {"channel": channel, **(metadata or {})}
        ep = Memory(id=new_id(), type=MemoryType.EPISODIC, content=raw, summary=clip(raw, 140) if len(raw) > 200 else None,
                    source=role, session_id=session_id, project_id=project, importance=ex.importance,
                    confidence=ex.confidence, epistemic=epi, created_at=ts, updated_at=ts, event_time=ts,
                    content_hash=content_hash(raw), flags=list(ex.flags), topics=list(ex.topics), metadata=meta,
                    idem_key=idempotency_key)
        derived: List[Memory] = []
        seen_keys = set()
        for f in ex.facts:
            if f.confidence < 0.35:
                continue
            content = f.natural()
            key, val = f.fact_key, f.object
            if (key, canon(val), f.retract) in seen_keys:
                continue
            seen_keys.add((key, canon(val), f.retract))
            imp = clamp(max(0.4, ex.importance) + (0.1 if f.predicate in ("name", "goal", "role", "location") else 0))
            userfact = canon(f.subject) == "user" and f.predicate != "is_building"
            derived.append(Memory(
                id=new_id(), type=MemoryType.SEMANTIC, content=content, source=role, source_ref=ep.id, session_id=session_id,
                project_id=None if userfact else project, importance=imp, confidence=f.confidence,
                epistemic=Epistemic.CONFIRMED if f.epistemic == "confirmed" else Epistemic.ASSUMED, created_at=ts,
                updated_at=ts, valid_from=ts, content_hash=content_hash(content), fact_key=key, fact_value=val,
                flags=[x for x in ex.flags if x != Flag.TEMPORARY.value] if f.predicate in ("goal", "name") else [],
                topics=list(ex.topics), metadata={"predicate": f.predicate, "subject": f.subject, **({"retract": True} if f.retract else {})}))
        for t in ex.tasks:
            flags = [Flag.TIME_SENSITIVE.value] if t.due_at else []
            derived.append(Memory(
                id=new_id(), type=MemoryType.PROSPECTIVE, content=clip(t.text, 400), source=role, source_ref=ep.id,
                session_id=session_id, project_id=project, importance=clamp(ex.importance + 0.1), confidence=t.confidence,
                epistemic=epi, state=TaskState.PENDING.value, created_at=ts, updated_at=ts, due_at=t.due_at,
                content_hash=content_hash(t.text), flags=flags + [f for f in ex.flags if f not in flags], topics=list(ex.topics)))
        for n in ex.notes:
            if n.kind == "decision":
                mtype, flags, imp = MemoryType.EPISODIC, [Flag.DECISION.value], clamp(ex.importance + 0.2)
            else:
                mtype, imp = MemoryType.PROCEDURAL, clamp(ex.importance + 0.05)
                flags = [{"failure": Flag.FAILURE, "recovery": Flag.RECOVERY}.get(n.kind, Flag.RECOVERY).value] \
                    if n.kind in ("failure", "recovery") else []
            derived.append(Memory(
                id=new_id(), type=mtype, content=clip(n.text, 600), source=role, source_ref=ep.id, session_id=session_id,
                project_id=project, importance=imp, confidence=n.confidence, epistemic=epi, created_at=ts, updated_at=ts,
                event_time=ts, content_hash=content_hash(n.text), flags=flags, topics=list(ex.topics),
                metadata={"kind": n.kind, **({"outcome": "failure" if n.kind == "failure" else "success"} if mtype == MemoryType.PROCEDURAL else {})}))

        ents = [(e.name, e.kind) for e in ex.entities]
        vecs = {m.id: self.vstore.embed(m.content) for m in [ep, *derived]}   # computed before taking the write lock
        with self.db.transaction():
            self.repo.insert_memory(ep, vecs[ep.id], self.vstore.name)
            self.repo.link_entities(ep.id, ents)
            for d in derived:
                self.repo.insert_memory(d, vecs[d.id], self.vstore.name)
                padded = f" {canon(d.content)} "
                self.repo.link_entities(d.id, [(n, k) for n, k in ents if f" {canon(n)} " in padded])
                self.repo.add_link(d.id, ep.id, "derived_from", 1.0, "extracted")
            for a, rel, b in ex.relations:
                self.repo.add_entity_relation(a, rel, b, ep.id)
            job_id = self.repo.enqueue_job("process", {"ids": [*(d.id for d in derived), ep.id]})
            self.repo.audit("ingest", ep.id, f"role={role} derived={len(derived)}")
        # transaction committed here (WAL + synchronous=FULL): now read it back before claiming success
        ids = [ep.id, *[d.id for d in derived]]
        found = self.db.query(f"SELECT COUNT(*) c FROM memories WHERE id IN ({','.join('?' * len(ids))})", ids)[0]["c"]
        verified = found == len(ids)
        for mid, v in vecs.items():
            self.vstore.add(mid, v)
        self.log.debug("ingested %s derived=%d redactions=%d", ep.id, len(derived), redactions)
        self._kick(wait)
        return IngestResult(True, verified, ep.id, [d.id for d in derived], None, redactions,
                            [e.name for e in ex.entities], job_id)

    # ------------------------------------------------------------------ background processing
    def _kick(self, wait: bool = False) -> None:
        if self._worker:
            self._wake.set()
            if wait:
                self.flush()
        else:
            self.process_pending()

    def process_pending(self, max_jobs: int = 1000) -> int:
        done = 0
        with self._proc_lock:
            while done < max_jobs:
                jobs = self.repo.claim_jobs(20, self.cfg.job_max_attempts)
                if not jobs:
                    break
                for j in jobs:
                    try:
                        rep = ConsolidationReport()
                        for mid in j["payload"].get("ids", []):
                            self.consolidator.consolidate_new(mid, rep)
                        self.repo.finish_job(j["jid"], None, self.cfg.job_max_attempts)
                    except Exception as exc:    # keep the job; retry later; never log content
                        self.log.warning("job %s failed (%s)", j["jid"], exc.__class__.__name__)
                        self.repo.finish_job(j["jid"], exc.__class__.__name__, self.cfg.job_max_attempts)
                    done += 1
        return done

    def _worker_loop(self) -> None:
        while not self._stop.is_set():
            try:
                n = self.process_pending(100)
                if n == 0:
                    if self.cfg.consolidation_interval_s and time.time() - self._last_pass > self.cfg.consolidation_interval_s:
                        self._last_pass = time.time()
                        with self._proc_lock:
                            self.consolidator.run_pass()
                            self.repo.prune_jobs()
                    self._wake.wait(self.cfg.job_poll_interval)
                    self._wake.clear()
            except sqlite3.ProgrammingError:
                time.sleep(0.05)       # connection swapped during restore/close; retry
            except Exception as exc:
                self.log.warning("worker error (%s)", exc.__class__.__name__)
                time.sleep(0.5)

    def flush(self, timeout: float = 15.0) -> bool:
        """Block until all queued background jobs are finished. Returns False on timeout."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            c = self.repo.job_counts()
            if not c.get("pending") and not c.get("running"):
                return True
            if self._worker is None or not self._worker.is_alive():
                self.process_pending()
            else:
                self._wake.set()
                time.sleep(0.01)
        return False

    # ------------------------------------------------------------------ explicit memory API
    def add_memory(self, content: str, type: Union[str, MemoryType] = MemoryType.SEMANTIC, *, source: str = "user",
                   importance: Optional[float] = None, confidence: Optional[float] = None,
                   epistemic: Optional[Union[str, Epistemic]] = None, project_id: Optional[str] = None,
                   session_id: Optional[str] = None, entities: Optional[Sequence[str]] = None,
                   topics: Optional[Sequence[str]] = None, due_at: Optional[float] = None,
                   flags: Optional[Sequence[str]] = None, metadata: Optional[Dict[str, Any]] = None,
                   fact_key: Optional[str] = None, fact_value: Optional[str] = None,
                   idempotency_key: Optional[str] = None) -> Memory:
        """Directly store a memory (no extraction of facts). Durable before it returns."""
        content = normalize_text(content, self.cfg.max_content_chars)
        if not content:
            raise MemoryValidationError("content is empty")
        if self.cfg.redact_secrets:
            content, _ = redact_secrets(content)
        mtype = MemoryType(type)
        if idempotency_key:
            prior = self.repo.get_by_idem(idempotency_key)
            if prior:
                return prior
        h = content_hash(content)
        dup = [d for d in self.repo.find_by_hash(h, mtype.value) if d.project_id == project_id]
        if dup:
            self.repo.update_memory(dup[0].id, {"mention_count": dup[0].mention_count + 1}, versioned=False)
            return self.repo.require(dup[0].id)
        ts = now_ts()
        ex = self.extractor.extract(content, source if source in _ROLES else "user", self.repo.known_entities(), ts)
        ents = [(n, "thing") for n in entities] if entities is not None else [(e.name, e.kind) for e in ex.entities]
        m = Memory(id=new_id(), type=mtype, content=content, source=source, project_id=project_id, session_id=session_id,
                   importance=clamp(importance if importance is not None else ex.importance),
                   confidence=clamp(confidence if confidence is not None else 0.7),
                   epistemic=Epistemic(epistemic) if epistemic else (Epistemic.CONFIRMED if source == "user" else Epistemic.ASSUMED),
                   state=TaskState.PENDING.value if mtype == MemoryType.PROSPECTIVE else None, created_at=ts, updated_at=ts,
                   event_time=ts, due_at=due_at, valid_from=ts if mtype == MemoryType.SEMANTIC else None, content_hash=h,
                   fact_key=fact_key, fact_value=fact_value, flags=list(flags or ex.flags),
                   topics=list(topics or ex.topics), metadata=dict(metadata or {}), idem_key=idempotency_key)
        vec = self.vstore.embed(content)
        with self.db.transaction():
            self.repo.insert_memory(m, vec, self.vstore.name)
            self.repo.link_entities(m.id, ents)
            self.repo.enqueue_job("process", {"ids": [m.id]})
            self.repo.audit("add", m.id, mtype.value)
        self.vstore.add(m.id, vec)
        self._kick()
        return self.repo.require(m.id)

    def get_memory(self, memory_id: str) -> Memory:
        return self.repo.require(memory_id)

    def get_memory_versions(self, memory_id: str) -> List[Dict[str, Any]]:
        self.repo.require(memory_id)
        return self.repo.get_versions(memory_id)

    def update_memory(self, memory_id: str, *, content: Optional[str] = None, importance: Optional[float] = None,
                      confidence: Optional[float] = None, state: Optional[str] = None, due_at: Optional[float] = None,
                      metadata: Optional[Dict[str, Any]] = None, project_id: Optional[str] = None,
                      flags: Optional[Sequence[str]] = None, epistemic: Optional[Union[str, Epistemic]] = None,
                      reason: str = "manual update", actor: str = "user") -> Memory:
        old = self.repo.require(memory_id)
        ch: Dict[str, Any] = {}
        vec = None
        if content is not None:
            content = normalize_text(content, self.cfg.max_content_chars)
            if not content:
                raise MemoryValidationError("content is empty")
            if self.cfg.redact_secrets:
                content, _ = redact_secrets(content)
            ch.update(content=content, content_hash=content_hash(content),
                      topics=[w for w in dict.fromkeys(content_tokens(content)) if len(w) > 3][:6])
            vec = self.vstore.embed(content)
        if importance is not None:
            ch["importance"] = clamp(importance)
        if confidence is not None:
            ch["confidence"] = clamp(confidence)
        if state is not None:
            ch["state"] = TaskState(state).value
        if due_at is not None:
            ch["due_at"] = due_at
        if metadata is not None:
            ch["metadata"] = {**old.metadata, **metadata}
        if project_id is not None:
            ch["project_id"] = project_id
        if flags is not None:
            ch["flags"] = list(flags)
        if epistemic is not None:
            ch["epistemic"] = Epistemic(epistemic)
        if not ch:
            return old
        m = self.repo.update_memory(memory_id, ch, reason=reason, actor=actor, embedding=vec,
                                    embedder=self.vstore.name if vec is not None else None)
        if vec is not None:
            self.vstore.add(memory_id, vec)
            ents = self.extractor.extract(m.content, "user", self.repo.known_entities()).entities
            self.repo.link_entities(memory_id, [(e.name, e.kind) for e in ents])
        self.repo.audit("update", memory_id, reason)
        return self.repo.require(memory_id)

    def correct_memory(self, memory_id: str, new_content: str, reason: str = "user correction") -> Memory:
        """Fix a wrong memory. The previous text stays in version history; the corrected one becomes confirmed."""
        return self.update_memory(memory_id, content=new_content, epistemic=Epistemic.CONFIRMED, confidence=0.95,
                                  reason=reason, actor="user")

    def link_memories(self, a: str, b: str, relation: str = "related_to", weight: float = 0.7,
                      evidence: str = "manual") -> bool:
        self.repo.require(a), self.repo.require(b)
        rel = "".join(ch for ch in relation.lower() if ch.isalnum() or ch == "_")[:40] or "related_to"
        created = self.repo.add_link(a, b, rel, weight, evidence)
        self.repo.audit("link", a, f"{rel}->{b}")
        return created

    def archive_memory(self, memory_id: str, reason: str = "archived by request") -> Memory:
        m = self.repo.update_memory(memory_id, {"status": MemoryStatus.ARCHIVED}, reason=reason, actor="user")
        self.repo.audit("archive", memory_id)
        return m

    def unarchive_memory(self, memory_id: str) -> Memory:
        return self.repo.update_memory(memory_id, {"status": MemoryStatus.ACTIVE}, reason="unarchived", actor="user")

    def delete_memory(self, memory_id: str, purge: bool = False, cascade: bool = True) -> Dict[str, Any]:
        """Soft delete (recoverable via undelete_memory) or `purge=True` to erase content, versions, links and vectors."""
        self.repo.require(memory_id)
        if not purge:
            self.repo.update_memory(memory_id, {"status": MemoryStatus.DELETED}, reason="soft delete", actor="user")
            self.vstore.remove(memory_id)
            self.repo.audit("delete", memory_id)
            return {"deleted": [memory_id], "purged": False}
        targets = [memory_id]
        if cascade:
            targets += [r["id"] for r in self.db.query("SELECT id FROM memories WHERE source_ref=?", (memory_id,))]
        for t in targets:
            self.repo.purge_memory(t)
            self.vstore.remove(t)
        return {"deleted": targets, "purged": True}

    def undelete_memory(self, memory_id: str) -> Memory:
        m = self.repo.require(memory_id)
        if m.status != MemoryStatus.DELETED:
            return m
        out = self.repo.update_memory(memory_id, {"status": MemoryStatus.ACTIVE}, reason="undeleted", actor="user")
        vec = self.vstore.embed(out.content)
        self.repo.update_memory(memory_id, {}, versioned=False, embedding=vec, embedder=self.vstore.name)
        self.vstore.add(memory_id, vec)
        return out

    # ------------------------------------------------------------------ retrieval
    def search_memory(self, query: str, *, limit: Optional[int] = None, types: Optional[Sequence[str]] = None,
                      project_id: Optional[str] = None, strict_project: bool = False, include_history: Optional[bool] = None,
                      session_id: Optional[str] = None) -> List[RetrievedMemory]:
        return self.retriever.search(query, limit=limit, types=types, project_id=project_id, strict_project=strict_project,
                                     include_history=include_history, working=self.working.snapshot(session_id),
                                     record_access=True)

    def retrieve_context(self, query: str, *, session_id: Optional[str] = None, project_id: Optional[str] = None,
                         budget_tokens: Optional[int] = None, include_history: Optional[bool] = None) -> ContextPackage:
        work = self.working.snapshot(session_id)
        pkg = self.retriever.retrieve_context(query, project_id=project_id, budget_tokens=budget_tokens,
                                              include_history=include_history, working=work)
        if session_id:
            self.working.note_retrieved(session_id, [i.memory.id for i in pkg.items])
            self.working.observe_turn(session_id, "query", query, pkg.entities, None, pkg.intent)
            pkg.working_memory = self.working.snapshot(session_id)
        return pkg

    def before_response(self, user_message: str, session_id: str, project_id: Optional[str] = None,
                        budget_tokens: Optional[int] = None) -> ContextPackage:
        """Call BEFORE ERA's reasoning model answers. Inject `.rendered_text` into the prompt."""
        return self.retrieve_context(user_message, session_id=session_id, project_id=project_id, budget_tokens=budget_tokens)

    def after_response(self, user_message: str, assistant_message: str, session_id: str,
                       project_id: Optional[str] = None, channel: str = "chat") -> Dict[str, IngestResult]:
        """Call AFTER the turn completes. Stores both sides durably (assistant turns at low importance)."""
        out = {"user": self.ingest(user_message, "user", session_id, project_id, channel)}
        if assistant_message:
            out["assistant"] = self.ingest(assistant_message, "assistant", session_id, project_id, channel)
        return out

    # ------------------------------------------------------------------ consolidation
    def consolidate_memories(self, project_id: Optional[str] = None) -> Dict[str, int]:
        self.flush()
        with self._proc_lock:
            rep = self.consolidator.run_pass(project_id)
        self._last_pass = time.time()
        return rep.to_dict()

    # ------------------------------------------------------------------ views
    def get_user_profile(self) -> Dict[str, Any]:
        facts = self.repo.active_facts("user|", 500)
        groups: Dict[str, List[Dict[str, Any]]] = {"identity": [], "goals": [], "preferences": [], "tools": [],
                                                   "projects": [], "people": [], "other": []}
        for f in sorted(facts, key=lambda x: -(x.importance * x.confidence)):
            pred = f.metadata.get("predicate") or (f.fact_key or "").split("|")[1]
            item = {"id": f.id, "predicate": pred, "value": f.fact_value, "statement": f.content,
                    "confidence": round(f.confidence, 2), "epistemic": f.epistemic.value, "since": iso(f.valid_from or f.created_at),
                    "mentions": f.mention_count}
            if pred in _IDENTITY:
                groups["identity"].append(item)
            elif pred == "goal":
                groups["goals"].append(item)
            elif pred in ("likes", "dislikes") or pred.startswith("favorite_"):
                groups["preferences"].append(item)
            elif pred == "uses":
                groups["tools"].append(item)
            elif pred == "is_building":
                groups["projects"].append(item)
            elif pred in ("friend", "brother", "sister", "mom", "mother", "dad", "father", "teacher", "professor", "roommate",
                          "boss", "colleague", "mentor", "partner", "cousin"):
                groups["people"].append(item)
            elif pred != "no_longer":
                groups["other"].append(item)
        changed = self.db.query("SELECT COUNT(*) c FROM memories WHERE type='semantic' AND status='superseded' AND fact_key LIKE 'user|%'")[0]["c"]
        pending = self.db.query("SELECT COUNT(*) c FROM memories WHERE type='prospective' AND state='pending' AND status='active'")[0]["c"]
        return {**groups, "superseded_facts": changed, "pending_tasks": pending}

    def get_project_history(self, project_id: str, limit: int = 200) -> Dict[str, Any]:
        pid = canon(project_id)
        ids = {r["id"] for r in self.db.query("SELECT id FROM memories WHERE project_id IN (?,?) AND status<>'deleted'", (project_id, pid))}
        ent = self.repo.entity_ids_for_names([project_id]).get(pid)
        if ent:
            ids |= {r["memory_id"] for r in self.db.query("SELECT memory_id FROM memory_entities WHERE entity_id=?", (ent[0],))}
        mems = [m for m in self.repo.get_many(list(ids)) if m.status != MemoryStatus.DELETED]
        mems.sort(key=lambda m: m.created_at)
        mems = mems[-limit:]
        pick = lambda f: [m.to_dict() for m in mems if f(m)]
        return {"project": project_id, "count": len(mems),
                "timeline": pick(lambda m: m.type == MemoryType.EPISODIC and m.source != "assistant" and "decision" not in m.flags),
                "decisions": pick(lambda m: "decision" in m.flags),
                "knowledge": pick(lambda m: m.type == MemoryType.SEMANTIC and m.status == MemoryStatus.ACTIVE),
                "superseded": pick(lambda m: m.status == MemoryStatus.SUPERSEDED),
                "tasks": pick(lambda m: m.type == MemoryType.PROSPECTIVE),
                "procedures": pick(lambda m: m.type == MemoryType.PROCEDURAL),
                "relations": self.repo.entity_relations_for([project_id])}

    def get_task_history(self, project_id: Optional[str] = None, state: Optional[str] = None, limit: int = 100) -> Dict[str, Any]:
        tasks = self.repo.list_memories(types=["prospective"], statuses=("active", "archived"), project_id=project_id,
                                        state=state, limit=limit)
        procs = self.repo.list_memories(types=["procedural"], project_id=project_id, limit=limit)
        return {"tasks": [t.to_dict() for t in tasks], "procedures": [p.to_dict() for p in procs]}

    # ---- prospective & procedural helpers
    def add_task(self, text: str, due_at: Optional[float] = None, project_id: Optional[str] = None,
                 importance: float = 0.6, session_id: Optional[str] = None) -> Memory:
        return self.add_memory(text, MemoryType.PROSPECTIVE, importance=importance, due_at=due_at, project_id=project_id,
                               session_id=session_id)

    def complete_task(self, task_id: str, outcome: Optional[str] = None, cancelled: bool = False) -> Memory:
        t = self.repo.require(task_id)
        if t.type != MemoryType.PROSPECTIVE:
            raise MemoryValidationError("not a task")
        meta = {**t.metadata, "completed_at": now_ts(), **({"outcome": outcome} if outcome else {})}
        return self.repo.update_memory(task_id, {"state": (TaskState.CANCELLED if cancelled else TaskState.DONE).value,
                                                 "metadata": meta}, reason="task closed", actor="user")

    def get_pending_tasks(self, project_id: Optional[str] = None, limit: int = 50) -> List[Memory]:
        return self.repo.list_memories(types=["prospective"], state="pending", project_id=project_id,
                                       order="importance DESC", limit=limit)

    def record_procedure(self, task: str, steps: Sequence[str], outcome: str = "success", project_id: Optional[str] = None,
                         error: Optional[str] = None, recovery: Optional[str] = None) -> Memory:
        """Remember HOW something was done, whether it worked, and how a failure was fixed."""
        if outcome not in ("success", "failure", "partial"):
            raise MemoryValidationError("outcome must be success|failure|partial")
        text = f"Task: {task}. Steps: " + " → ".join(steps) + f". Outcome: {outcome}."
        if error:
            text += f" Error: {clip(error, 200)}."
        if recovery:
            text += f" Recovery: {clip(recovery, 300)}."
        flags = [Flag.FAILURE.value] if outcome == "failure" else ([Flag.RECOVERY.value] if recovery else [])
        return self.add_memory(text, MemoryType.PROCEDURAL, source="engine", importance=0.55 if outcome != "success" else 0.5,
                               confidence=0.8, epistemic=Epistemic.CONFIRMED, project_id=project_id, flags=flags,
                               metadata={"outcome": outcome, "task": task})

    def get_related_memories(self, memory_id: str, hops: int = 2, limit: int = 20) -> Dict[str, Any]:
        self.repo.require(memory_id)
        rel = self.assoc.related(memory_id, hops, limit)
        return {"id": memory_id, "direct_links": self.repo.links_of(memory_id),
                "related": [{"score": round(a, 3), "path": p, "memory": m.to_dict()} for m, a, p in rel]}

    def get_memory_timeline(self, start: Optional[float] = None, end: Optional[float] = None, project_id: Optional[str] = None,
                            session_id: Optional[str] = None, types: Optional[Sequence[str]] = None, limit: int = 200,
                            include_archived: bool = False) -> List[Memory]:
        statuses = ("active", "archived", "superseded") if include_archived else ("active", "superseded")
        return self.repo.list_memories(types=types, statuses=statuses, project_id=project_id, session_id=session_id,
                                       since=start, until=end, order="created_at ASC", limit=limit)

    # ------------------------------------------------------------------ backup / restore / export
    def backup_memory(self, label: str = "manual") -> Dict[str, Any]:
        self.flush(timeout=5.0)
        return self.backups.create_backup(label)

    def restore_memory(self, backup_id: Union[str, Path], allow_external: bool = False) -> Dict[str, Any]:
        with self._proc_lock:
            info = self.backups.restore_backup(backup_id, allow_external)
            self.vstore.index.clear()
            self.vstore._loaded = False
            self.repo.requeue_stale_jobs()
            self._reconcile_embedder()
        self._wake.set()
        return info

    def export_memory(self, path: Optional[Union[str, Path]] = None) -> Dict[str, Any]:
        dest = Path(path) if path else Path(self.cfg.storage_dir) / "exports" / f"era_memory_export_{time.strftime('%Y%m%d_%H%M%S')}.jsonl"
        counts = self.backups.export_jsonl(dest)
        return {"path": str(dest), "counts": counts}

    # ------------------------------------------------------------------ stats / health
    def get_memory_statistics(self) -> Dict[str, Any]:
        s = self.repo.statistics()
        s["embedder"] = self.vstore.name
        s["vector_index_size"] = len(self.vstore.index)
        return s

    def rebuild_fts(self) -> None:
        self.db.execute("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')")

    def health_check(self) -> Dict[str, Any]:
        checks: Dict[str, Any] = {}
        status = "ok"

        def mark(name: str, ok: bool, detail: Any = None, degrade: bool = False) -> None:
            nonlocal status
            checks[name] = {"ok": ok, **({"detail": detail} if detail is not None else {})}
            if not ok:
                status = "degraded" if degrade and status == "ok" else "error"

        try:
            mark("database_open", True, {"schema_version": self.db.schema_version})
            qc = self.db.query_one("PRAGMA quick_check")[0]
            mark("integrity_quick_check", qc == "ok")
            jm = self.db.query_one("PRAGMA journal_mode")[0]
            mark("wal_mode", jm.lower() == "wal", jm)
            try:
                self.db.execute("INSERT INTO memories_fts(memories_fts, rank) VALUES('integrity-check', 1)")
                mark("fts_consistent", True)
            except sqlite3.DatabaseError:
                mark("fts_consistent", False, "run rebuild_fts()")
            self.db.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('last_health_check',?)", (iso(now_ts()),))
            mark("writable", True)
        except Exception as exc:
            mark("database_open", False, exc.__class__.__name__)
        jobs = self.repo.job_counts() if status != "error" else {}
        mark("job_queue", not jobs.get("failed"), jobs, degrade=True)
        stale = len(self.repo.stale_embedding_ids(self.vstore.name, 1000)) if status != "error" else 0
        mark("embeddings_current", stale == 0, {"stale": stale, "embedder": self.vstore.name}, degrade=True)
        free = shutil.disk_usage(self.cfg.storage_dir).free
        mark("disk_space", free > 200 * 1024 * 1024, {"free_mb": free // (1024 * 1024)}, degrade=True)
        mark("background_worker", (self._worker is not None and self._worker.is_alive()) or not self.cfg.async_processing)
        backs = self.backups.list_backups()
        mark("backups", True, {"count": len(backs), "latest": backs[0]["created_at"] if backs else None})
        checks["local_only"] = {"ok": True, "detail": "no network access is performed by this engine"}
        return {"status": status, "checks": checks, "storage_dir": str(self.cfg.storage_dir)}
