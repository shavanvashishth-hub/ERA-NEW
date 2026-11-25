"""SQLite persistence: WAL, FTS5, versioned migrations, crash-safe transactions, repository helpers."""
from __future__ import annotations

import json
import shutil
import sqlite3
import threading
import time
from array import array
from contextlib import contextmanager
from itertools import combinations
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional, Sequence, Tuple

from .memory_models import (Epistemic, Memory, MemoryCorruptionError, MemoryNotFound, MemoryStatus, MemoryType,
                            MemoryValidationError, new_id, now_ts)
from .memory_security import ensure_private_dir, restrict_file
from .memory_text import canon

# --------------------------------------------------------------------------- schema + migrations
SCHEMA_V1 = """
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE memories(
  rid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT,
  source TEXT NOT NULL DEFAULT 'unknown',
  source_ref TEXT,
  session_id TEXT,
  project_id TEXT,
  importance REAL NOT NULL DEFAULT 0.3,
  confidence REAL NOT NULL DEFAULT 0.5,
  epistemic TEXT NOT NULL DEFAULT 'assumed',
  status TEXT NOT NULL DEFAULT 'active',
  state TEXT,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  event_time REAL,
  due_at REAL,
  valid_from REAL,
  valid_to REAL,
  mention_count INTEGER NOT NULL DEFAULT 1,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed REAL,
  version INTEGER NOT NULL DEFAULT 1,
  content_hash TEXT NOT NULL,
  fact_key TEXT,
  fact_value TEXT,
  flags TEXT NOT NULL DEFAULT '[]',
  topics TEXT NOT NULL DEFAULT '[]',
  metadata TEXT NOT NULL DEFAULT '{}',
  idem_key TEXT,
  embedding BLOB,
  embedder TEXT
);
CREATE INDEX idx_mem_type_status ON memories(type, status);
CREATE INDEX idx_mem_project ON memories(project_id, status);
CREATE INDEX idx_mem_session ON memories(session_id, created_at);
CREATE INDEX idx_mem_created ON memories(created_at);
CREATE INDEX idx_mem_hash ON memories(content_hash);
CREATE INDEX idx_mem_fact ON memories(fact_key, status);
CREATE INDEX idx_mem_due ON memories(due_at);
CREATE UNIQUE INDEX idx_mem_idem ON memories(idem_key) WHERE idem_key IS NOT NULL;
CREATE TABLE memory_versions(
  vid INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  reason TEXT,
  actor TEXT,
  changed_at REAL NOT NULL
);
CREATE INDEX idx_ver_mem ON memory_versions(memory_id, version);
CREATE TABLE entities(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  canonical TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'thing',
  first_seen REAL NOT NULL,
  last_seen REAL NOT NULL,
  mention_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE memory_entities(
  memory_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  PRIMARY KEY(memory_id, entity_id)
);
CREATE INDEX idx_me_entity ON memory_entities(entity_id);
CREATE TABLE links(
  lid INTEGER PRIMARY KEY AUTOINCREMENT,
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  relation TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 0.5,
  evidence TEXT,
  created_at REAL NOT NULL,
  UNIQUE(src, dst, relation)
);
CREATE INDEX idx_links_dst ON links(dst);
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, summary, topics, content='memories', content_rowid='rid', tokenize='porter unicode61'
);
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, summary, topics) VALUES (new.rid, new.content, coalesce(new.summary,''), new.topics);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, summary, topics) VALUES ('delete', old.rid, old.content, coalesce(old.summary,''), old.topics);
END;
CREATE TRIGGER memories_au AFTER UPDATE OF content, summary, topics ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, summary, topics) VALUES ('delete', old.rid, old.content, coalesce(old.summary,''), old.topics);
  INSERT INTO memories_fts(rowid, content, summary, topics) VALUES (new.rid, new.content, coalesce(new.summary,''), new.topics);
END;
"""

SCHEMA_V2 = """
CREATE TABLE jobs(
  jid INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);
CREATE INDEX idx_jobs_status ON jobs(status, jid);
CREATE TABLE audit_log(
  aid INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL,
  action TEXT NOT NULL,
  memory_id TEXT,
  detail TEXT
);
CREATE TABLE entity_relations(
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  relation TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 0.5,
  count INTEGER NOT NULL DEFAULT 1,
  last_seen REAL NOT NULL,
  memory_id TEXT,
  PRIMARY KEY(a, b, relation)
);
CREATE INDEX idx_er_b ON entity_relations(b);
"""

MIGRATIONS: Dict[int, str] = {1: SCHEMA_V1, 2: SCHEMA_V2}
LATEST_VERSION = max(MIGRATIONS)

_UPDATABLE = {"content", "summary", "importance", "confidence", "epistemic", "status", "state", "event_time", "due_at",
              "valid_from", "valid_to", "mention_count", "fact_key", "fact_value", "flags", "topics", "metadata",
              "project_id", "content_hash", "source_ref"}
_ENTITY_RANK = {"project": 4, "technology": 3, "person": 3, "place": 2, "thing": 1}


class Database:
    """Thread-safe SQLite access: one connection per thread, one serialized writer, WAL for concurrent readers."""

    def __init__(self, path: Path, synchronous: str = "FULL", target_version: Optional[int] = None,
                 backup_dir: Optional[Path] = None, busy_timeout_ms: int = 10000):
        self.path = Path(path)
        self.synchronous = synchronous
        self.backup_dir = Path(backup_dir) if backup_dir else self.path.parent / "backups"
        self.busy_timeout_ms = busy_timeout_ms
        self.target_version = target_version or LATEST_VERSION
        self._local = threading.local()
        self._conns: List[sqlite3.Connection] = []
        self._conns_lock = threading.Lock()
        self._write_lock = threading.RLock()
        self._generation = 0
        ensure_private_dir(self.path.parent)
        self._open_and_migrate()
        restrict_file(self.path)

    # ---- connections
    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.path), timeout=self.busy_timeout_ms / 1000, isolation_level=None,
                               check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(f"PRAGMA synchronous={self.synchronous}")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute(f"PRAGMA busy_timeout={int(self.busy_timeout_ms)}")
        conn.execute("PRAGMA secure_delete=ON")
        with self._conns_lock:
            self._conns.append(conn)
        return conn

    def conn(self) -> sqlite3.Connection:
        c = getattr(self._local, "conn", None)
        if c is None or getattr(self._local, "gen", -1) != self._generation:
            c = self._connect()
            self._local.conn, self._local.gen, self._local.depth = c, self._generation, 0
        return c

    def close_all(self) -> None:
        with self._write_lock:
            with self._conns_lock:
                for c in self._conns:
                    try:
                        c.close()
                    except sqlite3.Error:
                        pass
                self._conns.clear()
            self._generation += 1

    close = close_all

    # ---- migrations
    def _open_and_migrate(self) -> None:
        try:
            c = self.conn()
            try:
                ver = c.execute("PRAGMA user_version").fetchone()[0]
                if ver > LATEST_VERSION:
                    raise MemoryCorruptionError(
                        f"database schema v{ver} is newer than this software (v{LATEST_VERSION}); upgrade the engine")
                if ver and self.path.exists():
                    chk = c.execute("PRAGMA quick_check").fetchone()[0]
                    if chk != "ok":
                        raise MemoryCorruptionError(
                            "database failed integrity check; restore the newest backup (see INTEGRATION_GUIDE.md)")
            except sqlite3.DatabaseError as exc:
                raise MemoryCorruptionError(f"cannot open database: {exc.__class__.__name__}") from exc
            if ver < self.target_version:
                if ver > 0:
                    self._pre_migration_backup(c, ver)
                for v in range(ver + 1, self.target_version + 1):
                    self._apply_migration(c, v)
        except Exception:
            self.close_all()
            raise

    def _pre_migration_backup(self, conn: sqlite3.Connection, ver: int) -> None:
        ensure_private_dir(self.backup_dir)
        dest = self.backup_dir / f"pre_migration_v{ver}_{int(time.time())}.db"
        out = sqlite3.connect(str(dest))
        try:
            conn.backup(out)
        finally:
            out.close()
        restrict_file(dest)

    def _apply_migration(self, conn: sqlite3.Connection, version: int) -> None:
        script = f"BEGIN IMMEDIATE;\n{MIGRATIONS[version]}\nPRAGMA user_version={version};\nCOMMIT;"
        try:
            conn.executescript(script)
        except Exception:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise

    @property
    def schema_version(self) -> int:
        return self.conn().execute("PRAGMA user_version").fetchone()[0]

    # ---- transactions
    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        c = self.conn()
        if self._local.depth > 0:  # nested: join the outer transaction
            self._local.depth += 1
            try:
                yield c
            finally:
                self._local.depth -= 1
            return
        with self._write_lock:
            c = self.conn()
            c.execute("BEGIN IMMEDIATE")
            self._local.depth = 1
            try:
                yield c
                c.execute("COMMIT")
            except BaseException:
                if c.in_transaction:
                    c.execute("ROLLBACK")
                raise
            finally:
                self._local.depth = 0

    def query(self, sql: str, params: Sequence[Any] = ()) -> List[sqlite3.Row]:
        return self.conn().execute(sql, params).fetchall()

    def query_one(self, sql: str, params: Sequence[Any] = ()) -> Optional[sqlite3.Row]:
        return self.conn().execute(sql, params).fetchone()

    def execute(self, sql: str, params: Sequence[Any] = ()) -> int:
        with self.transaction() as c:
            return c.execute(sql, params).rowcount

    def integrity_check(self) -> List[str]:
        return [r[0] for r in self.conn().execute("PRAGMA integrity_check").fetchall()]

    def checkpoint(self, mode: str = "TRUNCATE") -> None:
        try:
            self.conn().execute(f"PRAGMA wal_checkpoint({mode})")
        except sqlite3.Error:
            pass

    def file_size(self) -> int:
        return self.path.stat().st_size if self.path.exists() else 0


def _ph(n: int) -> str:
    return ",".join("?" * n)


def _j(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


class MemoryRepository:
    """All SQL for memories, entities, links, versions, jobs and audit lives here."""

    def __init__(self, db: Database):
        self.db = db

    # ------------------------------------------------------------------ row mapping
    @staticmethod
    def _to_memory(r: sqlite3.Row) -> Memory:
        return Memory(
            id=r["id"], type=MemoryType(r["type"]), content=r["content"], summary=r["summary"], source=r["source"],
            source_ref=r["source_ref"], session_id=r["session_id"], project_id=r["project_id"],
            importance=r["importance"], confidence=r["confidence"], epistemic=Epistemic(r["epistemic"]),
            status=MemoryStatus(r["status"]), state=r["state"], created_at=r["created_at"],
            updated_at=r["updated_at"], event_time=r["event_time"], due_at=r["due_at"], valid_from=r["valid_from"],
            valid_to=r["valid_to"], mention_count=r["mention_count"], access_count=r["access_count"],
            last_accessed=r["last_accessed"], version=r["version"], content_hash=r["content_hash"],
            fact_key=r["fact_key"], fact_value=r["fact_value"], flags=json.loads(r["flags"] or "[]"),
            topics=json.loads(r["topics"] or "[]"), metadata=json.loads(r["metadata"] or "{}"),
            idem_key=r["idem_key"])

    _COLS = ("id,type,content,summary,source,source_ref,session_id,project_id,importance,confidence,epistemic,status,"
             "state,created_at,updated_at,event_time,due_at,valid_from,valid_to,mention_count,access_count,"
             "last_accessed,version,content_hash,fact_key,fact_value,flags,topics,metadata,idem_key")

    def _attach_entities(self, mems: List[Memory]) -> List[Memory]:
        if not mems:
            return mems
        ids = [m.id for m in mems]
        rows = self.db.query(
            f"SELECT me.memory_id, e.name FROM memory_entities me JOIN entities e ON e.id=me.entity_id "
            f"WHERE me.memory_id IN ({_ph(len(ids))}) ORDER BY e.mention_count DESC", ids)
        by: Dict[str, List[str]] = {}
        for r in rows:
            by.setdefault(r["memory_id"], []).append(r["name"])
        for m in mems:
            m.entities = by.get(m.id, [])
        return mems

    # ------------------------------------------------------------------ create / read
    def insert_memory(self, m: Memory, embedding: Optional["array[float]"] = None, embedder: Optional[str] = None) -> None:
        with self.db.transaction() as c:
            c.execute(
                f"INSERT INTO memories({self._COLS},embedding,embedder) VALUES ({_ph(32)})",
                (m.id, m.type.value, m.content, m.summary, m.source, m.source_ref, m.session_id, m.project_id,
                 m.importance, m.confidence, m.epistemic.value, m.status.value, m.state, m.created_at, m.updated_at,
                 m.event_time, m.due_at, m.valid_from, m.valid_to, m.mention_count, m.access_count, m.last_accessed,
                 m.version, m.content_hash, m.fact_key, m.fact_value, _j(m.flags), _j(m.topics), _j(m.metadata),
                 m.idem_key, embedding.tobytes() if embedding is not None else None, embedder))

    def get(self, memory_id: str, with_entities: bool = True) -> Optional[Memory]:
        r = self.db.query_one(f"SELECT {self._COLS} FROM memories WHERE id=?", (memory_id,))
        if not r:
            return None
        m = self._to_memory(r)
        return self._attach_entities([m])[0] if with_entities else m

    def require(self, memory_id: str) -> Memory:
        m = self.get(memory_id)
        if m is None:
            raise MemoryNotFound(memory_id)
        return m

    def get_many(self, ids: Sequence[str]) -> List[Memory]:
        if not ids:
            return []
        rows = self.db.query(f"SELECT {self._COLS} FROM memories WHERE id IN ({_ph(len(ids))})", list(ids))
        by = {r["id"]: self._to_memory(r) for r in rows}
        return self._attach_entities([by[i] for i in ids if i in by])

    def get_by_idem(self, key: str) -> Optional[Memory]:
        r = self.db.query_one(f"SELECT {self._COLS} FROM memories WHERE idem_key=?", (key,))
        return self._attach_entities([self._to_memory(r)])[0] if r else None

    def list_memories(self, *, types: Optional[Sequence[str]] = None, statuses: Optional[Sequence[str]] = ("active",),
                      project_id: Optional[str] = None, session_id: Optional[str] = None,
                      since: Optional[float] = None, until: Optional[float] = None, state: Optional[str] = None,
                      source: Optional[str] = None, order: str = "created_at DESC", limit: int = 100,
                      offset: int = 0) -> List[Memory]:
        where, p = [], []
        if types:
            where.append(f"type IN ({_ph(len(types))})"); p += list(types)
        if statuses:
            where.append(f"status IN ({_ph(len(statuses))})"); p += list(statuses)
        for col, val in (("project_id", project_id), ("session_id", session_id), ("state", state), ("source", source)):
            if val is not None:
                where.append(f"{col}=?"); p.append(val)
        if since is not None:
            where.append("created_at>=?"); p.append(since)
        if until is not None:
            where.append("created_at<?"); p.append(until)
        if order not in {"created_at DESC", "created_at ASC", "importance DESC", "due_at ASC", "updated_at DESC"}:
            raise MemoryValidationError("unsupported order")
        sql = f"SELECT {self._COLS} FROM memories" + (" WHERE " + " AND ".join(where) if where else "")
        sql += f" ORDER BY {order} LIMIT ? OFFSET ?"
        rows = self.db.query(sql, p + [limit, offset])
        return self._attach_entities([self._to_memory(r) for r in rows])

    def find_by_fact_key(self, fact_key: str, statuses: Sequence[str] = ("active",), exclude_id: Optional[str] = None) -> List[Memory]:
        sql = f"SELECT {self._COLS} FROM memories WHERE fact_key=? AND status IN ({_ph(len(statuses))})"
        p: List[Any] = [fact_key, *statuses]
        if exclude_id:
            sql += " AND id<>?"; p.append(exclude_id)
        return [self._to_memory(r) for r in self.db.query(sql + " ORDER BY created_at", p)]

    def active_facts(self, predicate_prefix: Optional[str] = None, limit: int = 500) -> List[Memory]:
        sql = f"SELECT {self._COLS} FROM memories WHERE type='semantic' AND status='active' AND fact_key IS NOT NULL"
        p: List[Any] = []
        if predicate_prefix:
            sql += " AND fact_key LIKE ?"; p.append(predicate_prefix + "%")
        rows = self.db.query(sql + " ORDER BY importance DESC LIMIT ?", p + [limit])
        return [self._to_memory(r) for r in rows]

    def find_by_hash(self, h: str, mtype: Optional[str] = None, exclude_id: Optional[str] = None) -> List[Memory]:
        sql, p = f"SELECT {self._COLS} FROM memories WHERE content_hash=? AND status='active'", [h]
        if mtype:
            sql += " AND type=?"; p.append(mtype)
        if exclude_id:
            sql += " AND id<>?"; p.append(exclude_id)
        return [self._to_memory(r) for r in self.db.query(sql + " ORDER BY created_at", p)]

    def previous_in_session(self, session_id: str, before: float, exclude_id: str) -> Optional[str]:
        r = self.db.query_one(
            "SELECT id FROM memories WHERE session_id=? AND type='episodic' AND created_at<=? AND id<>? AND status='active' "
            "ORDER BY created_at DESC, rid DESC LIMIT 1", (session_id, before, exclude_id))
        return r["id"] if r else None

    # ------------------------------------------------------------------ update (versioned)
    def update_memory(self, memory_id: str, changes: Dict[str, Any], reason: str = "update", actor: str = "engine",
                      versioned: bool = True, embedding: Optional["array[float]"] = None,
                      embedder: Optional[str] = None) -> Memory:
        bad = set(changes) - _UPDATABLE
        if bad:
            raise MemoryValidationError(f"fields not updatable: {sorted(bad)}")
        with self.db.transaction() as c:
            row = c.execute(f"SELECT {self._COLS} FROM memories WHERE id=?", (memory_id,)).fetchone()
            if row is None:
                raise MemoryNotFound(memory_id)
            old = self._to_memory(row)
            sets, params = [], []
            for k, v in changes.items():
                if k in ("flags", "topics", "metadata"):
                    v = _j(v)
                elif hasattr(v, "value"):
                    v = v.value
                sets.append(f"{k}=?"); params.append(v)
            new_version = old.version
            if versioned:
                snap = old.to_dict()
                snap["raw_content"] = old.content
                c.execute("INSERT INTO memory_versions(memory_id,version,content,snapshot,reason,actor,changed_at) "
                          "VALUES (?,?,?,?,?,?,?)",
                          (memory_id, old.version, old.content, _j(snap), reason, actor, now_ts()))
                new_version = old.version + 1
                sets.append("version=?"); params.append(new_version)
            sets.append("updated_at=?"); params.append(now_ts())
            if embedding is not None:
                sets += ["embedding=?", "embedder=?"]; params += [embedding.tobytes(), embedder]
            c.execute(f"UPDATE memories SET {','.join(sets)} WHERE id=?", params + [memory_id])
        return self.require(memory_id)

    def touch(self, ids: Sequence[str]) -> None:
        if ids:
            with self.db.transaction() as c:
                c.execute(f"UPDATE memories SET access_count=access_count+1,last_accessed=? WHERE id IN ({_ph(len(ids))})",
                          [now_ts(), *ids])

    def get_versions(self, memory_id: str) -> List[Dict[str, Any]]:
        rows = self.db.query("SELECT version,content,snapshot,reason,actor,changed_at FROM memory_versions "
                             "WHERE memory_id=? ORDER BY version", (memory_id,))
        return [{"version": r["version"], "content": r["content"], "reason": r["reason"], "actor": r["actor"],
                 "changed_at": r["changed_at"], "snapshot": json.loads(r["snapshot"])} for r in rows]

    def purge_memory(self, memory_id: str) -> bool:
        with self.db.transaction() as c:
            n = c.execute("DELETE FROM memories WHERE id=?", (memory_id,)).rowcount
            c.execute("DELETE FROM memory_versions WHERE memory_id=?", (memory_id,))
            c.execute("DELETE FROM memory_entities WHERE memory_id=?", (memory_id,))
            c.execute("DELETE FROM links WHERE src=? OR dst=?", (memory_id, memory_id))
            c.execute("DELETE FROM entity_relations WHERE memory_id=?", (memory_id,))
            c.execute("INSERT INTO audit_log(ts,action,memory_id,detail) VALUES (?,?,?,?)",
                      (now_ts(), "purge", memory_id, ""))
        self.db.checkpoint()
        return n > 0

    # ------------------------------------------------------------------ entities & graph
    def upsert_entity(self, name: str, kind: str = "thing") -> str:
        cn = canon(name)
        if not cn:
            raise MemoryValidationError("empty entity name")
        with self.db.transaction() as c:
            r = c.execute("SELECT id,kind FROM entities WHERE canonical=?", (cn,)).fetchone()
            ts = now_ts()
            if r:
                if _ENTITY_RANK.get(kind, 1) > _ENTITY_RANK.get(r["kind"], 1):
                    c.execute("UPDATE entities SET kind=?,last_seen=? WHERE id=?", (kind, ts, r["id"]))
                else:
                    c.execute("UPDATE entities SET last_seen=? WHERE id=?", (ts, r["id"]))
                return r["id"]
            eid = new_id("ent")
            c.execute("INSERT INTO entities(id,name,canonical,kind,first_seen,last_seen,mention_count) VALUES (?,?,?,?,?,?,0)",
                      (eid, name.strip(), cn, kind, ts, ts))
            return eid

    def link_entities(self, memory_id: str, entities: Sequence[Tuple[str, str]]) -> List[str]:
        """Attach entities to a memory and update entity co-occurrence edges. Returns entity ids."""
        ids: List[str] = []
        with self.db.transaction() as c:
            for name, kind in entities:
                eid = self.upsert_entity(name, kind)
                ids.append(eid)
                if c.execute("INSERT OR IGNORE INTO memory_entities(memory_id,entity_id) VALUES (?,?)",
                             (memory_id, eid)).rowcount:
                    c.execute("UPDATE entities SET mention_count=mention_count+1,last_seen=? WHERE id=?", (now_ts(), eid))
            for a, b in combinations(sorted(set(ids))[:10], 2):
                self._bump_relation(c, a, b, "co_occurs", 0.3, memory_id)
        return ids

    def _bump_relation(self, c: sqlite3.Connection, a: str, b: str, rel: str, weight: float, mid: Optional[str]) -> None:
        c.execute(
            "INSERT INTO entity_relations(a,b,relation,weight,count,last_seen,memory_id) VALUES (?,?,?,?,1,?,?) "
            "ON CONFLICT(a,b,relation) DO UPDATE SET count=count+1,last_seen=excluded.last_seen,"
            "weight=min(1.0,weight+0.05)", (a, b, rel, weight, now_ts(), mid))

    def add_entity_relation(self, a_name: str, rel: str, b_name: str, memory_id: Optional[str], weight: float = 0.7) -> None:
        with self.db.transaction() as c:
            a, b = self.upsert_entity(a_name), self.upsert_entity(b_name)
            self._bump_relation(c, a, b, rel, weight, memory_id)

    def entity_ids_for_names(self, names: Iterable[str]) -> Dict[str, Tuple[str, str]]:
        """canonical -> (entity_id, display name)."""
        cn = [canon(n) for n in names if canon(n)]
        if not cn:
            return {}
        rows = self.db.query(f"SELECT canonical,id,name FROM entities WHERE canonical IN ({_ph(len(cn))})", cn)
        return {r["canonical"]: (r["id"], r["name"]) for r in rows}

    def known_entities(self, limit: int = 5000) -> Dict[str, Tuple[str, str]]:
        rows = self.db.query("SELECT canonical,id,name,kind FROM entities ORDER BY mention_count DESC LIMIT ?", (limit,))
        return {r["canonical"]: (r["id"], r["kind"]) for r in rows}

    def memories_for_entities(self, entity_ids: Sequence[str], statuses: Sequence[str] = ("active",),
                              limit_per: int = 25) -> Dict[str, List[Tuple[str, int]]]:
        out: Dict[str, List[Tuple[str, int]]] = {}
        for eid in entity_ids:
            rows = self.db.query(
                f"SELECT m.id, m.rid FROM memory_entities me JOIN memories m ON m.id=me.memory_id "
                f"WHERE me.entity_id=? AND m.status IN ({_ph(len(statuses))}) "
                f"ORDER BY m.importance DESC, m.created_at DESC LIMIT ?", [eid, *statuses, limit_per])
            out[eid] = [(r["id"], r["rid"]) for r in rows]
        return out

    def related_entities(self, entity_id: str, limit: int = 5) -> List[Tuple[str, float]]:
        rows = self.db.query(
            "SELECT CASE WHEN a=? THEN b ELSE a END AS other, weight, count FROM entity_relations "
            "WHERE a=? OR b=? ORDER BY count DESC, weight DESC LIMIT ?", (entity_id, entity_id, entity_id, limit))
        return [(r["other"], min(1.0, r["weight"] * (0.6 + 0.1 * min(r["count"], 4)))) for r in rows]

    def entity_name(self, entity_id: str) -> str:
        r = self.db.query_one("SELECT name FROM entities WHERE id=?", (entity_id,))
        return r["name"] if r else entity_id

    def entity_relations_for(self, entity_names: Sequence[str]) -> List[Dict[str, Any]]:
        ids = [v[0] for v in self.entity_ids_for_names(entity_names).values()]
        out = []
        for eid in ids:
            for r in self.db.query(
                    "SELECT a,b,relation,count FROM entity_relations WHERE (a=? OR b=?) AND relation<>'co_occurs' "
                    "ORDER BY count DESC LIMIT 10", (eid, eid)):
                out.append({"a": self.entity_name(r["a"]), "relation": r["relation"], "b": self.entity_name(r["b"])})
        return out

    # ------------------------------------------------------------------ memory links
    _SYMMETRIC = {"similar_to", "shares_entity", "same_topic", "same_project", "near_in_time", "related_to"}

    def add_link(self, src: str, dst: str, relation: str, weight: float = 0.5, evidence: Optional[str] = None) -> bool:
        if src == dst:
            return False
        if relation in self._SYMMETRIC and src > dst:
            src, dst = dst, src
        with self.db.transaction() as c:
            before = c.execute("SELECT 1 FROM links WHERE src=? AND dst=? AND relation=?", (src, dst, relation)).fetchone()
            c.execute("INSERT INTO links(src,dst,relation,weight,evidence,created_at) VALUES (?,?,?,?,?,?) "
                      "ON CONFLICT(src,dst,relation) DO UPDATE SET weight=max(weight,excluded.weight)",
                      (src, dst, relation, max(0.0, min(1.0, weight)), evidence, now_ts()))
            return before is None

    def links_of(self, memory_id: str, limit: int = 50) -> List[Dict[str, Any]]:
        rows = self.db.query(
            "SELECT src,dst,relation,weight,evidence FROM links WHERE src=? OR dst=? ORDER BY weight DESC LIMIT ?",
            (memory_id, memory_id, limit))
        return [{"other": r["dst"] if r["src"] == memory_id else r["src"], "relation": r["relation"],
                 "weight": r["weight"], "outgoing": r["src"] == memory_id, "evidence": r["evidence"]} for r in rows]

    def neighbors(self, ids: Sequence[str], per_node: int = 8) -> Dict[str, List[Tuple[str, str, float]]]:
        out: Dict[str, List[Tuple[str, str, float]]] = {}
        for mid in ids:
            rows = self.db.query(
                "SELECT src,dst,relation,weight FROM links WHERE src=? OR dst=? ORDER BY weight DESC LIMIT ?",
                (mid, mid, per_node))
            out[mid] = [((r["dst"] if r["src"] == mid else r["src"]), r["relation"], r["weight"]) for r in rows]
        return out

    # ------------------------------------------------------------------ full-text search
    def fts_search(self, match_expr: str, limit: int, statuses: Sequence[str] = ("active",),
                   project_id: Optional[str] = None) -> List[Tuple[str, float]]:
        if not match_expr:
            return []
        sql = ("SELECT m.id AS id, bm25(memories_fts, 1.0, 0.6, 0.4) AS r FROM memories_fts "
               "JOIN memories m ON m.rid = memories_fts.rowid WHERE memories_fts MATCH ? "
               f"AND m.status IN ({_ph(len(statuses))})")
        p: List[Any] = [match_expr, *statuses]
        if project_id:
            sql += " AND m.project_id=?"; p.append(project_id)
        sql += " ORDER BY r LIMIT ?"
        p.append(limit)
        try:
            return [(r["id"], -float(r["r"])) for r in self.db.query(sql, p)]
        except sqlite3.OperationalError:
            return []  # malformed MATCH expression: degrade gracefully, other retrievers still run

    def embeddings(self, embedder: str) -> Iterator[Tuple[str, bytes]]:
        cur = self.db.conn().execute(
            "SELECT id, embedding FROM memories WHERE embedding IS NOT NULL AND embedder=? AND status<>'deleted'", (embedder,))
        for r in cur:
            yield r["id"], r["embedding"]

    def stale_embedding_ids(self, embedder: str, limit: int = 100000) -> List[str]:
        rows = self.db.query("SELECT id FROM memories WHERE status<>'deleted' AND (embedder IS NULL OR embedder<>?) LIMIT ?",
                             (embedder, limit))
        return [r["id"] for r in rows]

    # ------------------------------------------------------------------ jobs (durable outbox) & audit
    def enqueue_job(self, kind: str, payload: Dict[str, Any]) -> int:
        with self.db.transaction() as c:
            ts = now_ts()
            return c.execute("INSERT INTO jobs(kind,payload,status,created_at,updated_at) VALUES (?,?, 'pending',?,?)",
                             (kind, _j(payload), ts, ts)).lastrowid

    def claim_jobs(self, limit: int, max_attempts: int) -> List[Dict[str, Any]]:
        with self.db.transaction() as c:
            rows = c.execute("SELECT jid,kind,payload,attempts FROM jobs WHERE status='pending' AND attempts<? "
                             "ORDER BY jid LIMIT ?", (max_attempts, limit)).fetchall()
            for r in rows:
                c.execute("UPDATE jobs SET status='running',attempts=attempts+1,updated_at=? WHERE jid=?", (now_ts(), r["jid"]))
            return [{"jid": r["jid"], "kind": r["kind"], "payload": json.loads(r["payload"]), "attempts": r["attempts"] + 1}
                    for r in rows]

    def finish_job(self, jid: int, error: Optional[str], max_attempts: int) -> None:
        with self.db.transaction() as c:
            if error is None:
                c.execute("UPDATE jobs SET status='done',error=NULL,updated_at=? WHERE jid=?", (now_ts(), jid))
            else:
                att = c.execute("SELECT attempts FROM jobs WHERE jid=?", (jid,)).fetchone()["attempts"]
                c.execute("UPDATE jobs SET status=?,error=?,updated_at=? WHERE jid=?",
                          ("failed" if att >= max_attempts else "pending", error[:200], now_ts(), jid))

    def requeue_stale_jobs(self) -> int:
        return self.db.execute("UPDATE jobs SET status='pending' WHERE status='running'")

    def job_counts(self) -> Dict[str, int]:
        return {r["status"]: r["n"] for r in self.db.query("SELECT status,COUNT(*) n FROM jobs GROUP BY status")}

    def prune_jobs(self, keep_days: float = 7.0) -> None:
        self.db.execute("DELETE FROM jobs WHERE status='done' AND updated_at<?", (now_ts() - keep_days * 86400,))

    def audit(self, action: str, memory_id: Optional[str] = None, detail: str = "") -> None:
        self.db.execute("INSERT INTO audit_log(ts,action,memory_id,detail) VALUES (?,?,?,?)",
                        (now_ts(), action, memory_id, detail[:200]))

    # ------------------------------------------------------------------ stats
    def statistics(self) -> Dict[str, Any]:
        q = self.db.query
        by_type = {f"{r['type']}:{r['status']}": r["n"] for r in q("SELECT type,status,COUNT(*) n FROM memories GROUP BY type,status")}
        one = lambda sql: q(sql)[0][0]
        span = self.db.query_one("SELECT MIN(created_at) lo, MAX(created_at) hi FROM memories")
        return {
            "memories_by_type_status": by_type,
            "total_memories": one("SELECT COUNT(*) FROM memories"),
            "entities": one("SELECT COUNT(*) FROM entities"),
            "links": one("SELECT COUNT(*) FROM links"),
            "entity_relations": one("SELECT COUNT(*) FROM entity_relations"),
            "versions": one("SELECT COUNT(*) FROM memory_versions"),
            "jobs": self.job_counts(),
            "oldest": span["lo"], "newest": span["hi"],
            "db_bytes": self.db.file_size(),
            "schema_version": self.db.schema_version,
        }
