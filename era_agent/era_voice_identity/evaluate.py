"""Measure FAR / FRR on REAL recordings. Never invents numbers: empty folders are reported as 'no data'.

Dataset layout (16 kHz-ish WAV files; any rate is resampled):
  <root>/enroll/                      owner enrollment recordings (>=3, ~6-10 s each)
  <root>/genuine/<condition>/*.wav    held-out owner recordings, e.g. clean, noisy, low_volume, mic_b
  <root>/impostor/<condition>/*.wav   non-owner / attack audio, e.g. different_speakers,
                                      similar_speakers, replay, ai_clone, noisy_others
FRR  = genuine clips rejected / genuine clips with enough speech
FAR  = impostor clips accepted / impostor clips with enough speech
Clips with too little speech are counted separately (they are rejected, but not scored in rates).
"""
from __future__ import annotations

import json
import math
import sys
import tempfile
from pathlib import Path

import numpy as np

from .config import Config, Status
from .engine import VoiceIdentityEngine


def wilson(k: int, n: int, z: float = 1.96):
    if n == 0:
        return (None, None)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def _files(d: Path):
    return sorted(p for p in d.glob("*") if p.suffix.lower() in (".wav", ".flac", ".ogg"))


def evaluate(root: str, threshold: float | None = None, engine: VoiceIdentityEngine | None = None) -> dict:
    root = Path(root)
    eng = engine or VoiceIdentityEngine(Config(data_dir=tempfile.mkdtemp(prefix="era_eval_")))
    init = eng.initialize()
    if not init["ok"]:
        return {"error": f"model failed to load: {init['error']}"}
    enroll = _files(root / "enroll")
    out = eng.enroll_owner([str(p) for p in enroll])
    if not out["ok"]:
        return {"error": f"enrollment failed: {out.get('error')}", "report": out.get("report")}
    if threshold is not None:
        eng.profile.threshold = threshold
    report = {"threshold": eng.profile.threshold, "enrollment": out["report"].get("stats"),
              "genuine": {}, "impostor": {}}
    all_g, all_i = [], []
    for kind in ("genuine", "impostor"):
        base = root / kind
        for cond in sorted(p for p in base.glob("*") if p.is_dir()) if base.exists() else []:
            files = _files(cond)
            scored = errors = unusable = hits = 0
            scores = []
            for f in files:
                r = eng.verify_speaker(str(f))
                if r["status"] in (Status.OWNER, Status.UNKNOWN):
                    scored += 1
                    hits += r["is_owner"]
                    scores.append(r["score"])
                elif r["status"] == Status.MODEL_ERROR:
                    errors += 1
                else:
                    unusable += 1
            rate = None if scored == 0 else (hits / scored if kind == "impostor" else 1 - hits / scored)
            k = hits if kind == "impostor" else scored - hits
            report[kind][cond.name] = {
                "files": len(files), "scored": scored, "unusable_audio": unusable, "model_errors": errors,
                ("FAR" if kind == "impostor" else "FRR"): rate, "ci95": wilson(k, scored),
                "score_mean": None if not scores else float(np.mean(scores))}
            (all_g if kind == "genuine" else all_i).extend(scores)
    if len(all_g) >= 10 and len(all_i) >= 10:
        g, i = np.array(all_g), np.array(all_i)
        ts = np.unique(np.r_[g, i])
        far = np.array([(i >= t).mean() for t in ts])
        frr = np.array([(g < t).mean() for t in ts])
        j = int(np.argmin(np.abs(far - frr)))
        report["EER_approx"] = float((far[j] + frr[j]) / 2)
        report["EER_threshold"] = float(ts[j])
    else:
        report["EER_approx"] = None
        report["note"] = "Not enough scored clips for an EER (need >=10 genuine and >=10 impostor)."
    return report


if __name__ == "__main__":
    print(json.dumps(evaluate(sys.argv[1]), indent=2))
