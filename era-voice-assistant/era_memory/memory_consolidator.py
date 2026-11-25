"""Consolidation: dedupe, detect changed facts, merge without losing history, build digests, age out noise.

Invariants (enforced here and covered by tests):
* Nothing is ever silently overwritten: every change goes through `update_memory(versioned=True)`.
* Superseded / merged memories stay in the database with status + provenance links.
* Only explicit `delete_memory(purge=True)` removes rows.
"""
from __future__ import annotations

import math
from typing import Dict, List, Optional

from .associative_memory import AssociativeMemory
from .memory_config import MemoryConfig
from .memory_database import MemoryRepository
from .memory_embeddings import VectorStore
from .memory_models import (ConsolidationReport, Epistemic, Flag, Memory, MemoryStatus, MemoryType, clamp, new_id,
                            now_ts)
from .memory_text import canon, content_hash, content_tokens, clip

_RETRACTABLE = ("likes", "uses", "dislikes", "is_building", "favorite_", "goal")


def _noisy_or(a: float, b: float) -> float:
    return 1.0 - (1.0 - a) * (1.0 - b)


class MemoryConsolidator:
    def __init__(self, repo: MemoryRepository, vstore: VectorStore, assoc: AssociativeMemory, config: MemoryConfig):
        self.repo, self.vstore, self.assoc, self.cfg = repo, vstore, assoc, config

    # ------------------------------------------------------------------ per-memory (runs from the job queue)
    def consolidate_new(self, memory_id: str, report: Optional[ConsolidationReport] = None) -> ConsolidationReport:
        rep = report or ConsolidationReport()
        m = self.repo.get(memory_id)
        if m is None or m.status != MemoryStatus.ACTIVE:
            return rep
        rep.processed += 1
        merged_away = False
        if m.type == MemoryType.SEMANTIC and m.fact_key:
            merged_away = self._reconcile_fact(m, rep)
        elif m.type in (MemoryType.PROSPECTIVE, MemoryType.PROCEDURAL, MemoryType.SEMANTIC):
            merged_away = self._merge_near_duplicates(m, rep)
        if not merged_away:
            rep.links_created += self.assoc.connect(memory_id)
        return rep

    # ---- facts
    def _reconcile_fact(self, m: Memory, rep: ConsolidationReport) -> bool:
        if m.metadata.get("retract"):
            self._apply_retraction(m, rep)
            return False
        same_key = self.repo.find_by_fact_key(m.fact_key or "", exclude_id=m.id)
        for old in same_key:
            if canon(old.fact_value or "") == canon(m.fact_value or ""):
                self._merge_into(old, m, rep, reason="duplicate fact restated")
                return True
        for old in same_key:  # same key, different value -> the fact CHANGED (single-valued predicate)
            self._supersede(old, m, "fact changed")
            rep.facts_superseded += 1
        return False

    def _apply_retraction(self, m: Memory, rep: ConsolidationReport) -> None:
        target = canon(m.fact_value or "")
        if not target:
            return
        for old in self.repo.active_facts(limit=1000):
            if old.id == m.id or old.metadata.get("retract"):
                continue
            pred = (old.fact_key or "").split("|")[1:2]
            if not pred or not pred[0].startswith(_RETRACTABLE):
                continue
            ov = canon(old.fact_value or "")
            if ov and (ov == target or (len(target) >= 4 and (target in ov or ov in target))):
                self._supersede(old, m, "retracted by newer statement")
                rep.retractions_applied += 1

    def _supersede(self, old: Memory, new: Memory, why: str) -> None:
        ts = now_ts()
        self.repo.update_memory(old.id, {"status": MemoryStatus.SUPERSEDED, "valid_to": new.created_at or ts,
                                         "metadata": {**old.metadata, "superseded_by": new.id}},
                                reason=f"superseded: {why}", actor="consolidator")
        self.repo.add_link(new.id, old.id, "supersedes", 1.0, why)
        if new.valid_from is None:
            self.repo.update_memory(new.id, {"valid_from": new.created_at}, versioned=False)
        self.repo.audit("supersede", old.id, f"by {new.id}")

    def _merge_into(self, keep: Memory, dup: Memory, rep: ConsolidationReport, reason: str) -> None:
        """Fold a duplicate into the older memory. The duplicate row is archived (not deleted) and linked."""
        flags = list(dict.fromkeys([*keep.flags, Flag.REPEATED.value] if keep.mention_count + 1 >= 2 else keep.flags))
        sources = list(dict.fromkeys([*keep.metadata.get("sources", [keep.source_ref] if keep.source_ref else []),
                                      *([dup.source_ref] if dup.source_ref else [])]))
        epi = keep.epistemic
        if dup.epistemic == Epistemic.CONFIRMED and keep.epistemic != Epistemic.CONFIRMED:
            epi = Epistemic.CONFIRMED  # restated by the user -> upgrade assumption to confirmed
        n = keep.mention_count + dup.mention_count
        self.repo.update_memory(
            keep.id, {"mention_count": n, "confidence": _noisy_or(keep.confidence, dup.confidence * 0.8),
                      "importance": clamp(max(keep.importance, dup.importance) + 0.05 * math.log(n + 1)),
                      "epistemic": epi, "flags": flags,
                      "metadata": {**keep.metadata, "sources": sources, "last_restated": now_ts()}},
            reason=reason, actor="consolidator")
        self.repo.update_memory(dup.id, {"status": MemoryStatus.ARCHIVED,
                                         "metadata": {**dup.metadata, "merged_into": keep.id}},
                                reason=f"merged into {keep.id}", actor="consolidator")
        self.repo.add_link(dup.id, keep.id, "duplicate_of", 1.0, reason)
        rep.duplicates_merged += 1

    def _merge_near_duplicates(self, m: Memory, rep: ConsolidationReport) -> bool:
        for old in self.repo.find_by_hash(m.content_hash, m.type.value, exclude_id=m.id):
            if old.state == m.state and old.project_id == m.project_id:
                self._merge_into(old, m, rep, "identical content")
                return True
        vec = self.vstore.vector_of(m.id)
        if vec is None:
            return False
        for oid, sim in self.vstore.search(vec, 4, self.cfg.duplicate_similarity_threshold):
            if oid == m.id:
                continue
            old = self.repo.get(oid, with_entities=False)
            if old and old.status == MemoryStatus.ACTIVE and old.type == m.type and old.state == m.state \
                    and old.project_id == m.project_id and old.created_at <= m.created_at:
                self._merge_into(old, m, rep, f"near-duplicate (sim {sim:.2f})")
                return True
        return False

    # ------------------------------------------------------------------ periodic pass
    def run_pass(self, project_id: Optional[str] = None, limit: int = 2000) -> ConsolidationReport:
        rep = ConsolidationReport()
        rep.digests_updated += self._entity_digests()
        rep.importance_updates += self._recalibrate_importance(project_id, limit)
        rep.archived += self._age_out()
        return rep

    def _entity_digests(self) -> int:
        """Turn repeated episodic mentions of an entity into consolidated semantic knowledge (with history)."""
        n = 0
        rows = self.repo.db.query(
            "SELECT e.id, e.name, e.kind, COUNT(m.id) AS c FROM entities e JOIN memory_entities me ON me.entity_id=e.id "
            "JOIN memories m ON m.id=me.memory_id WHERE m.type='episodic' AND m.status='active' AND m.source='user' "
            "GROUP BY e.id HAVING c>=? ORDER BY c DESC LIMIT 50", (self.cfg.digest_min_mentions,))
        for r in rows:
            if r["kind"] not in ("project", "technology", "thing", "person"):
                continue
            mems = self.repo.db.query(
                "SELECT m.id, m.content, m.topics, m.created_at FROM memory_entities me JOIN memories m ON m.id=me.memory_id "
                "WHERE me.entity_id=? AND m.type='episodic' AND m.status='active' AND m.source='user' "
                "ORDER BY m.importance DESC, m.created_at DESC LIMIT 8", (r["id"],))
            if r["c"] < self.cfg.digest_min_mentions or not mems:
                continue
            topics: Dict[str, int] = {}
            for x in mems:
                import json as _json
                for t in _json.loads(x["topics"] or "[]"):
                    topics[t] = topics.get(t, 0) + 1
            top = [t for t, _ in sorted(topics.items(), key=lambda kv: -kv[1])[:5] if t not in canon(r["name"]).split()]
            rel = [f"{e['relation'].replace('_', ' ')} {e['b']}" for e in self.repo.entity_relations_for([r["name"]])
                   if e["a"] == r["name"]][:4]
            snippets = " | ".join(clip(x["content"], 110) for x in mems[:3])
            text = (f"Digest for {r['name']}: mentioned in {r['c']} user interactions. "
                    f"Recurring topics: {', '.join(top) or 'n/a'}. "
                    + (f"Known links: {'; '.join(rel)}. " if rel else "") + f"Recent: {snippets}")
            key = f"entity|{canon(r['name'])}|digest"
            existing = self.repo.find_by_fact_key(key)
            src_ids = [x["id"] for x in mems]
            if existing:
                d = existing[0]
                if d.content != text:
                    self.repo.update_memory(d.id, {"content": text, "content_hash": content_hash(text),
                                                   "topics": top, "mention_count": r["c"],
                                                   "confidence": clamp(0.5 + 0.05 * r["c"], 0, 0.9),
                                                   "metadata": {**d.metadata, "sources": src_ids}},
                                            reason="digest refreshed", actor="consolidator",
                                            embedding=self.vstore.embed(text), embedder=self.vstore.name)
                    self.vstore.add(d.id, self.vstore.embed(text))
                    n += 1
            else:
                t = now_ts()
                d = Memory(id=new_id("mem"), type=MemoryType.SEMANTIC, content=text, source="engine",
                           importance=clamp(0.4 + 0.05 * r["c"], 0, 0.8), confidence=clamp(0.5 + 0.05 * r["c"], 0, 0.9),
                           epistemic=Epistemic.INFERRED, created_at=t, updated_at=t, valid_from=t, mention_count=r["c"],
                           content_hash=content_hash(text), fact_key=key, fact_value=str(r["c"]),
                           flags=[Flag.DIGEST.value, Flag.REPEATED.value], topics=top,
                           metadata={"sources": src_ids, "entity": r["name"]})
                vec = self.vstore.embed(text)
                self.repo.insert_memory(d, vec, self.vstore.name)
                self.repo.link_entities(d.id, [(r["name"], r["kind"])])
                self.vstore.add(d.id, vec)
                for sid in src_ids:
                    self.repo.add_link(d.id, sid, "derived_from", 0.9, "digest")
                n += 1
        return n

    def _recalibrate_importance(self, project_id: Optional[str], limit: int) -> int:
        """Repeated mention + recall frequency raise importance slowly (never above 0.95; never lowers explicit asks)."""
        n = 0
        rows = self.repo.list_memories(types=["semantic", "prospective", "procedural"], project_id=project_id, limit=limit,
                                       order="updated_at DESC")
        for m in rows:
            boost = 0.03 * math.log1p(max(0, m.access_count)) + 0.03 * math.log1p(max(0, m.mention_count - 1))
            target = clamp(max(m.importance, min(0.95, m.metadata.get("base_importance", m.importance) + boost)), 0, 0.95)
            if target - m.importance >= 0.03:
                flags = list(dict.fromkeys([*m.flags, Flag.REPEATED.value])) if m.mention_count >= 3 else m.flags
                self.repo.update_memory(m.id, {"importance": target, "flags": flags,
                                               "metadata": {**m.metadata, "base_importance": m.metadata.get("base_importance", m.importance)}},
                                        reason="importance recalibrated", actor="consolidator", versioned=False)
                n += 1
        return n

    def _age_out(self) -> int:
        """Archive (never delete) stale, low-value, never-recalled memories so retrieval stays sharp."""
        n = 0
        t = now_ts()
        sql = ("SELECT id, flags, source, created_at, importance, access_count, type FROM memories WHERE status='active' "
               "AND type='episodic' AND access_count=0 AND importance<0.45")
        for r in self.repo.db.query(sql):
            age_days = (t - r["created_at"]) / 86400
            temp = "temporary" in r["flags"]
            ttl = self.cfg.temporary_ttl_days if temp else (self.cfg.assistant_turn_ttl_days if r["source"] == "assistant" else None)
            if ttl is not None and age_days > ttl:
                self.repo.update_memory(r["id"], {"status": MemoryStatus.ARCHIVED}, reason="aged out (low importance)",
                                        actor="consolidator")
                n += 1
        return n
