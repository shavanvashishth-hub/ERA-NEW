"""Associative memory: automatic linking (semantic, entity, temporal, topic, project) and multi-hop traversal."""
from __future__ import annotations

from typing import Dict, List, Optional, Sequence, Tuple

from .memory_config import MemoryConfig
from .memory_database import MemoryRepository
from .memory_embeddings import VectorStore
from .memory_models import Memory, MemoryStatus


class AssociativeMemory:
    def __init__(self, repo: MemoryRepository, vstore: VectorStore, config: MemoryConfig):
        self.repo, self.vstore, self.cfg = repo, vstore, config

    # ------------------------------------------------------------------ linking
    def connect(self, memory_id: str) -> int:
        """Create association links for one memory. Idempotent; returns the number of NEW links."""
        m = self.repo.get(memory_id)
        if m is None or m.status != MemoryStatus.ACTIVE:
            return 0
        created = 0
        k = self.cfg.link_top_k
        cand: Dict[str, Dict[str, object]] = {}

        # entity relationships (hub-safe: only the most important few per entity)
        ent_ids = [v[0] for v in self.repo.entity_ids_for_names(m.entities).values()]
        shared: Dict[str, List[str]] = {}
        for eid, rows in self.repo.memories_for_entities(ent_ids, limit_per=12).items():
            for oid, _rid in rows:
                if oid != m.id:
                    shared.setdefault(oid, []).append(self.repo.entity_name(eid))
        for oid, names in sorted(shared.items(), key=lambda kv: -len(kv[1]))[:k]:
            cand.setdefault(oid, {})["entity"] = names

        # semantic similarity
        vec = self.vstore.vector_of(m.id)
        if vec is not None:
            for oid, sim in self.vstore.search(vec, k + 1, self.cfg.similarity_link_threshold):
                if oid != m.id:
                    cand.setdefault(oid, {})["sim"] = sim

        # project membership (recent items only; the project itself is also an entity hub)
        if m.project_id:
            for o in self.repo.list_memories(project_id=m.project_id, limit=4):
                if o.id != m.id:
                    cand.setdefault(o.id, {})["project"] = m.project_id

        others = {o.id: o for o in self.repo.get_many(list(cand))}
        for oid, info in cand.items():
            o = others.get(oid)
            if o is None or o.status != MemoryStatus.ACTIVE:
                continue
            if "entity" in info:
                names = info["entity"]  # type: ignore[assignment]
                created += self.repo.add_link(m.id, oid, "shares_entity", min(0.9, 0.4 + 0.15 * len(names)),  # type: ignore[arg-type]
                                              "entity:" + ",".join(names[:3])) is True  # type: ignore[index]
            if "sim" in info:
                created += self.repo.add_link(m.id, oid, "similar_to", float(info["sim"]), "vector") is True  # type: ignore[arg-type]
            if "project" in info:
                created += self.repo.add_link(m.id, oid, "same_project", 0.3, f"project:{m.project_id}") is True
            ta, tb = set(m.topics), set(o.topics)
            if len(ta & tb) >= 2:
                j = len(ta & tb) / len(ta | tb)
                if j >= 0.3:
                    created += self.repo.add_link(m.id, oid, "same_topic", min(0.8, j + 0.2), "topics:" + ",".join(sorted(ta & tb)[:3])) is True

        # temporal chain inside a session
        if m.session_id and m.type.value == "episodic":
            prev = self.repo.previous_in_session(m.session_id, m.created_at, m.id)
            if prev:
                created += self.repo.add_link(prev, m.id, "follows", 0.6, "session-order") is True
        return created

    # ------------------------------------------------------------------ traversal
    def expand(self, seeds: Dict[str, float], hops: Optional[int] = None, decay: float = 0.55,
               fanout: Optional[int] = None, max_nodes: int = 250) -> Dict[str, Tuple[float, List[str]]]:
        """Spreading activation over memory links. Returns id -> (activation, relation path)."""
        hops = self.cfg.graph_hops if hops is None else hops
        fanout = fanout or self.cfg.graph_fanout
        act: Dict[str, float] = dict(seeds)
        path: Dict[str, List[str]] = {k: [] for k in seeds}
        frontier = dict(seeds)
        for _ in range(hops):
            nb = self.repo.neighbors(list(frontier), per_node=fanout)
            nxt: Dict[str, float] = {}
            for node, a in frontier.items():
                for other, rel, w in nb.get(node, []):
                    na = a * w * decay
                    if na > act.get(other, 0.0) and other not in seeds:
                        act[other], path[other] = na, path[node] + [rel]
                        nxt[other] = na
            frontier = nxt
            if not frontier or len(act) > max_nodes:
                break
        return {k: (v, path[k]) for k, v in act.items() if k not in seeds}

    def entity_expand(self, entity_ids: Sequence[str], decay: float = 0.5,
                      per_entity: int = 3) -> Dict[str, Tuple[float, str]]:
        """Knowledge-graph hop: entity -> related entities (co-occurrence / typed relations) -> their memories."""
        out: Dict[str, Tuple[float, str]] = {}
        for eid in entity_ids:
            src = self.repo.entity_name(eid)
            for other, w in self.repo.related_entities(eid, per_entity):
                if other in entity_ids:
                    continue
                oname = self.repo.entity_name(other)
                for oid, _ in self.repo.memories_for_entities([other], limit_per=6).get(other, []):
                    s = w * decay
                    if s > out.get(oid, (0.0, ""))[0]:
                        out[oid] = (s, f"{src} → {oname}")
        return out

    def related(self, memory_id: str, hops: int = 2, limit: int = 20) -> List[Tuple[Memory, float, List[str]]]:
        res = self.expand({memory_id: 1.0}, hops=hops)
        ranked = sorted(res.items(), key=lambda kv: -kv[1][0])[: limit * 2]
        mems = {m.id: m for m in self.repo.get_many([i for i, _ in ranked])}
        out = [(mems[i], a, p) for i, (a, p) in ranked if i in mems and mems[i].status != MemoryStatus.DELETED]
        return out[:limit]
