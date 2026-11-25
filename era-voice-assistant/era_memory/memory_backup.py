"""Consistent online backups (SQLite backup API), verified restores, JSONL export, corruption recovery."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sqlite3
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from .memory_config import MemoryConfig
from .memory_database import LATEST_VERSION, Database
from .memory_models import MemoryBackupError, iso, now_ts
from .memory_security import ensure_private_dir, restrict_file

_ROTATING = ("manual", "auto")


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _ro_uri(path: Path) -> str:
    return Path(path).resolve().as_uri() + "?mode=ro"


def _fsync_file(path: Path) -> None:
    mode = "r+b" if os.name == "nt" else "rb"
    with open(path, mode) as f:
        os.fsync(f.fileno())


class BackupManager:
    def __init__(self, db: Database, config: MemoryConfig):
        self.db, self.cfg = db, config
        self.dir = config.backup_dir

    # ------------------------------------------------------------------ create
    def create_backup(self, label: str = "manual") -> Dict[str, Any]:
        label = re.sub(r"[^A-Za-z0-9_\-]", "", label)[:24] or "manual"
        ensure_private_dir(self.dir)
        stamp = time.strftime("%Y%m%d_%H%M%S") + f"_{int((time.time() % 1) * 1000):03d}"
        dest = self.dir / f"era_memory_{stamp}_{label}.db"
        tmp = dest.with_suffix(".db.tmp")
        out = sqlite3.connect(str(tmp))
        try:
            self.db.conn().backup(out)   # consistent snapshot even while other threads write
        finally:
            out.close()
        try:
            chk = sqlite3.connect(_ro_uri(tmp), uri=True)
            try:
                ok = chk.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
                counts = {t: chk.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("memories", "entities", "links")}
                ver = chk.execute("PRAGMA user_version").fetchone()[0]
            finally:
                chk.close()
        except sqlite3.Error as exc:
            tmp.unlink(missing_ok=True)
            raise MemoryBackupError(f"backup verification failed: {exc.__class__.__name__}") from exc
        if not ok:
            tmp.unlink(missing_ok=True)
            raise MemoryBackupError("backup failed integrity check; it was discarded")
        _fsync_file(tmp)
        os.replace(tmp, dest)
        restrict_file(dest)
        info = {"id": dest.name, "path": str(dest), "bytes": dest.stat().st_size, "sha256": _sha256(dest),
                "created_at": iso(now_ts()), "schema_version": ver, "label": label, "counts": counts}
        dest.with_suffix(".json").write_text(json.dumps(info, indent=2), encoding="utf-8")
        self._rotate()
        return info

    def _rotate(self) -> None:
        keep = self.cfg.backup_keep
        backs = [b for b in self.list_backups() if b["label"] in _ROTATING]
        for old in backs[keep:]:
            Path(old["path"]).unlink(missing_ok=True)
            Path(old["path"]).with_suffix(".json").unlink(missing_ok=True)

    def list_backups(self) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        if not self.dir.exists():
            return out
        for p in sorted(self.dir.glob("*.db"), key=lambda x: x.stat().st_mtime, reverse=True):
            side = p.with_suffix(".json")
            meta: Dict[str, Any] = {}
            if side.exists():
                try:
                    meta = json.loads(side.read_text(encoding="utf-8"))
                except ValueError:
                    meta = {}
            label = meta.get("label") or ("pre_migration" if p.name.startswith("pre_migration") else "unknown")
            out.append({"id": p.name, "path": str(p), "bytes": p.stat().st_size, "label": label,
                        "created_at": meta.get("created_at"), "verified_manifest": bool(meta),
                        "counts": meta.get("counts")})
        return out

    # ------------------------------------------------------------------ verify + restore
    def _resolve(self, source: Union[str, Path], allow_external: bool) -> Path:
        p = Path(source)
        if not p.is_absolute() and len(p.parts) == 1:
            p = self.dir / p.name
            if not p.exists() and not p.name.endswith(".db"):
                p = self.dir / (p.name + ".db")
        p = p.expanduser().resolve()
        if not allow_external and self.dir.resolve() not in p.parents:
            raise MemoryBackupError("restore source must be inside the backup directory")
        if not p.is_file():
            raise MemoryBackupError("backup file not found")
        return p

    def verify(self, path: Path) -> Dict[str, Any]:
        side = path.with_suffix(".json")
        if side.exists():
            meta = json.loads(side.read_text(encoding="utf-8"))
            if meta.get("sha256") and meta["sha256"] != _sha256(path):
                raise MemoryBackupError("backup checksum mismatch (file changed or damaged)")
        try:
            c = sqlite3.connect(_ro_uri(path), uri=True)
            try:
                if c.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise MemoryBackupError("backup failed integrity check")
                ver = c.execute("PRAGMA user_version").fetchone()[0]
                c.execute("SELECT COUNT(*) FROM memories").fetchone()
            finally:
                c.close()
        except sqlite3.Error as exc:
            raise MemoryBackupError(f"not a valid memory backup: {exc.__class__.__name__}") from exc
        if ver > LATEST_VERSION:
            raise MemoryBackupError(f"backup schema v{ver} is newer than this engine (v{LATEST_VERSION})")
        return {"schema_version": ver}

    def restore_backup(self, source: Union[str, Path], allow_external: bool = False) -> Dict[str, Any]:
        src = self._resolve(source, allow_external)
        meta = self.verify(src)
        safety = self.create_backup("pre_restore")     # always keep a way back
        with self.db._write_lock:
            self.db.checkpoint()
            self.db.close_all()
            tmp = self.db.path.with_suffix(".restore.tmp")
            shutil.copyfile(src, tmp)
            _fsync_file(tmp)
            for suffix in ("-wal", "-shm"):
                Path(str(self.db.path) + suffix).unlink(missing_ok=True)
            os.replace(tmp, self.db.path)
            restrict_file(self.db.path)
            self.db._open_and_migrate()          # upgrades older backups automatically
        return {"restored_from": src.name, "schema_version": meta["schema_version"], "safety_backup": safety["id"]}

    def recover_latest(self) -> Optional[Dict[str, Any]]:
        """After a corruption error: restore the newest backup that verifies."""
        for b in self.list_backups():
            if b["label"] in ("pre_restore",):
                continue
            try:
                return self.restore_backup(b["path"], allow_external=True)
            except MemoryBackupError:
                continue
        return None

    # ------------------------------------------------------------------ export
    def export_jsonl(self, path: Union[str, Path]) -> Dict[str, int]:
        """Portable, human-inspectable export (embeddings omitted; they are rebuilt locally)."""
        p = Path(path)
        ensure_private_dir(p.parent)
        counts: Dict[str, int] = {}
        tables = {"memories": "SELECT rid,id,type,content,summary,source,source_ref,session_id,project_id,importance,"
                              "confidence,epistemic,status,state,created_at,updated_at,event_time,due_at,valid_from,"
                              "valid_to,mention_count,access_count,last_accessed,version,content_hash,fact_key,fact_value,"
                              "flags,topics,metadata FROM memories ORDER BY rid",
                  "memory_versions": "SELECT * FROM memory_versions ORDER BY vid", "entities": "SELECT * FROM entities",
                  "memory_entities": "SELECT * FROM memory_entities", "links": "SELECT * FROM links ORDER BY lid",
                  "entity_relations": "SELECT * FROM entity_relations"}
        tmp = p.with_suffix(p.suffix + ".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(json.dumps({"export": "era_memory", "schema_version": self.db.schema_version, "at": iso(now_ts())}) + "\n")
            for table, sql in tables.items():
                n = 0
                for row in self.db.conn().execute(sql):
                    f.write(json.dumps({"table": table, "row": dict(row)}, ensure_ascii=False) + "\n")
                    n += 1
                counts[table] = n
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, p)
        restrict_file(p)
        return counts
