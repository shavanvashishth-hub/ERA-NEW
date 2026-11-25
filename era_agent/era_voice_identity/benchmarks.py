"""Latency / memory benchmark. Run on YOUR machine with the real model:  python -m era_voice_identity benchmark"""
from __future__ import annotations

import os
import statistics
import time

import numpy as np

from .audio import SpeechDetector
from .config import Config
from .verification import SpeechBrainEmbedder


def _rss_mb():
    try:
        import psutil
        return psutil.Process(os.getpid()).memory_info().rss / 1e6
    except ImportError:
        return None


def run(cfg: Config | None = None, runs: int = 20, embedder=None) -> dict:
    cfg = cfg or Config()
    det = SpeechDetector(cfg)
    rng = np.random.default_rng(0)
    clip = (rng.standard_normal(cfg.sample_rate * 3) * 0.05).astype(np.float32)
    t = []
    for _ in range(runs):
        s = time.perf_counter(); det.extract(clip); t.append((time.perf_counter() - s) * 1000)
    out = {"vad_ms_per_3s_clip_median": statistics.median(t)}
    emb = embedder or SpeechBrainEmbedder(cfg)
    before = _rss_mb()
    s = time.perf_counter(); emb.load(); out["model_load_s"] = time.perf_counter() - s
    out["device"] = getattr(emb, "device", "?")
    t = []
    for _ in range(runs):
        s = time.perf_counter(); emb.embed(clip); t.append((time.perf_counter() - s) * 1000)
    out["embed_ms_3s_median"] = statistics.median(t)
    out["embed_ms_3s_p95"] = float(np.percentile(t, 95))
    after = _rss_mb()
    out["rss_mb_after_load"] = after
    out["rss_mb_delta_from_load"] = None if before is None or after is None else after - before
    return out
