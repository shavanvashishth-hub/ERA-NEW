"""Local owner-profile storage (atomic writes, integrity hash, Windows DPAPI at rest)."""
from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np

log = logging.getLogger("era_voice_identity.profile")

_MAGIC_DPAPI = b"ERAVP1D"
_MAGIC_PLAIN = b"ERAVP1P"


class ProfileError(Exception):
    pass


@dataclass
class OwnerProfile:
    centroid: np.ndarray                     # (d,) L2-normalised
    sample_embeddings: np.ndarray            # (n, d) one per enrollment recording
    threshold: float
    model_id: str
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    stats: dict = field(default_factory=dict)
    calibration: dict = field(default_factory=dict)

    @property
    def dim(self) -> int:
        return int(self.centroid.shape[0])


def _digest(centroid, samples, threshold, model_id) -> str:
    h = hashlib.sha256()
    h.update(np.ascontiguousarray(centroid, np.float32).tobytes())
    h.update(np.ascontiguousarray(samples, np.float32).tobytes())
    h.update(f"{threshold:.6f}|{model_id}".encode())
    return h.hexdigest()


def _dpapi(data: bytes, protect: bool) -> bytes:
    import ctypes
    from ctypes import wintypes

    class BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    buf = ctypes.create_string_buffer(data, len(data))
    blob_in = BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    blob_out = BLOB()
    fn = ctypes.windll.crypt32.CryptProtectData if protect else ctypes.windll.crypt32.CryptUnprotectData
    if not fn(ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)):
        raise ProfileError("DPAPI call failed")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)


class ProfileManager:
    def __init__(self, data_dir: Path):
        self.dir = Path(data_dir)
        self.path = self.dir / "owner_profile.bin"

    def exists(self) -> bool:
        return self.path.is_file()

    def save(self, p: OwnerProfile) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        p.updated_at = time.time()
        meta = {
            "threshold": float(p.threshold), "model_id": p.model_id,
            "created_at": p.created_at, "updated_at": p.updated_at,
            "stats": p.stats, "calibration": p.calibration,
            "digest": _digest(p.centroid, p.sample_embeddings, p.threshold, p.model_id),
        }
        bio = io.BytesIO()
        np.savez(bio, centroid=p.centroid.astype(np.float32),
                 samples=p.sample_embeddings.astype(np.float32), meta=np.array(json.dumps(meta)))
        raw = bio.getvalue()
        blob = _MAGIC_PLAIN + raw
        if sys.platform == "win32":
            try:
                blob = _MAGIC_DPAPI + _dpapi(raw, True)
            except Exception as exc:  # fall back, but say so
                log.warning("DPAPI unavailable, storing profile unencrypted: %s", exc)
        tmp = self.path.with_suffix(".tmp")
        with open(tmp, "wb") as f:
            f.write(blob)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.path)
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass

    def load(self) -> OwnerProfile:
        if not self.exists():
            raise ProfileError("No owner profile enrolled")
        try:
            blob = self.path.read_bytes()
            magic, body = blob[:7], blob[7:]
            if magic == _MAGIC_DPAPI:
                body = _dpapi(body, False)
            elif magic != _MAGIC_PLAIN:
                raise ProfileError("Unrecognised profile format")
            with np.load(io.BytesIO(body), allow_pickle=False) as z:
                centroid, samples = z["centroid"], z["samples"]
                meta = json.loads(str(z["meta"]))
        except ProfileError:
            raise
        except Exception as exc:
            raise ProfileError(f"Profile unreadable: {exc}") from exc
        if _digest(centroid, samples, meta["threshold"], meta["model_id"]) != meta["digest"]:
            raise ProfileError("Profile integrity check failed (corrupt or modified)")
        if not np.all(np.isfinite(centroid)):
            raise ProfileError("Profile contains invalid values")
        return OwnerProfile(centroid=centroid, sample_embeddings=samples,
                            threshold=float(meta["threshold"]), model_id=meta["model_id"],
                            created_at=meta["created_at"], updated_at=meta["updated_at"],
                            stats=meta.get("stats", {}), calibration=meta.get("calibration", {}))

    def reset(self) -> bool:
        """Overwrite then delete the profile. Returns True if one existed."""
        if not self.exists():
            return False
        try:
            size = self.path.stat().st_size
            with open(self.path, "r+b") as f:
                f.write(os.urandom(size))
                f.flush()
                os.fsync(f.fileno())
        except OSError:
            pass
        self.path.unlink()
        return True
