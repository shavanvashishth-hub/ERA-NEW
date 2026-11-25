"""Owner enrollment: validate recordings, embed, reject outliers, build the profile."""
from __future__ import annotations

import logging
from typing import List, Optional

import numpy as np

from .audio import SpeechDetector, assess_quality, load_audio
from .config import Config
from .profile_manager import OwnerProfile
from .verification import Embedder, _unit

log = logging.getLogger("era_voice_identity.enroll")

ENROLLMENT_PROMPTS = [
    "Please say: the quick brown fox jumps over the lazy dog, and then tell me about your day.",
    "Please read aloud: my voice is my password, and nobody else should be able to use it.",
    "Please describe what you had for your last meal, in a natural speaking voice.",
    "Please say: today I want to check my messages, open my files, and plan my schedule.",
    "Please count from twenty-one to forty, then name five cities you know.",
    "Please speak freely about a hobby you enjoy, as if talking to a friend.",
]


class EnrollmentError(Exception):
    def __init__(self, message: str, report: Optional[dict] = None):
        super().__init__(message)
        self.report = report or {}


def _sample_embedding(speech: np.ndarray, cfg: Config, embedder: Embedder) -> np.ndarray:
    win = int(cfg.enroll_window_s * cfg.sample_rate)
    min_tail = int(2.0 * cfg.sample_rate)
    chunks = [speech[i:i + win] for i in range(0, len(speech), win)]
    if len(chunks) > 1 and len(chunks[-1]) < min_tail:
        chunks.pop()
    embs = [embedder.embed(c) for c in chunks]
    return _unit(np.mean(embs, axis=0))


def build_profile(samples: list, cfg: Config, embedder: Embedder, detector: SpeechDetector,
                  sample_rate: Optional[int] = None,
                  existing: Optional[OwnerProfile] = None) -> tuple:
    """Return (OwnerProfile, report). Raises EnrollmentError if the recordings are unusable."""
    report = {"accepted": [], "rejected": []}
    kept: List[np.ndarray] = []
    for i, raw in enumerate(samples):
        try:
            wave = load_audio(raw, sample_rate, cfg.sample_rate)
            speech, speech_s, noise = detector.extract(wave)
            q = assess_quality(wave, speech, noise)
            problems = []
            if speech_s < cfg.enroll_min_speech_s:
                problems.append(f"only {speech_s:.1f}s of speech (need {cfg.enroll_min_speech_s:.0f}s)")
            if q["clipping_ratio"] > cfg.enroll_max_clipping:
                problems.append("audio is clipped (lower the mic gain)")
            if q["snr_db"] is not None and q["snr_db"] < cfg.enroll_min_snr_db:
                problems.append(f"too noisy (SNR {q['snr_db']:.0f} dB)")
            if problems:
                report["rejected"].append({"index": i, "reasons": problems})
                continue
            kept.append(_sample_embedding(speech, cfg, embedder))
            report["accepted"].append({"index": i, "speech_s": round(speech_s, 1),
                                       "snr_db": None if q["snr_db"] is None else round(q["snr_db"], 1)})
        except Exception as exc:
            report["rejected"].append({"index": i, "reasons": [f"processing error: {exc}"]})

    # consistency: an outlier is probably someone else's voice or a bad recording
    if len(kept) >= 3:
        E = np.stack(kept)
        sims = E @ E.T
        mean_other = (sims.sum(axis=1) - 1.0) / (len(kept) - 1)
        ok = mean_other >= cfg.enroll_consistency_min
        acc_idx = [a["index"] for a in report["accepted"]]
        for j in np.flatnonzero(~ok):
            report["rejected"].append({"index": acc_idx[j], "reasons": [
                f"inconsistent with other samples (mean similarity {mean_other[j]:.2f}); different speaker?"]})
        report["accepted"] = [a for a, k in zip(report["accepted"], ok) if k]
        kept = [e for e, k in zip(kept, ok) if k]

    prior = [] if existing is None else list(existing.sample_embeddings)
    all_embs = prior + kept
    if len(kept) < 1 or len(all_embs) < cfg.enroll_min_samples:
        raise EnrollmentError(
            f"Need at least {cfg.enroll_min_samples} good recordings; got {len(all_embs)}.", report)

    E = np.stack(all_embs).astype(np.float32)
    centroid = _unit(E.mean(axis=0))
    loo = []
    for j in range(len(E)):
        others = np.delete(E, j, axis=0)
        loo.append(float(np.dot(E[j], _unit(others.mean(axis=0)))))
    stats = {"n_samples": len(E), "loo_mean": float(np.mean(loo)), "loo_min": float(np.min(loo)),
             "loo_std": float(np.std(loo))}
    threshold = existing.threshold if existing is not None else cfg.threshold
    if stats["loo_mean"] < threshold + 0.10:
        report["warning"] = ("Enrollment recordings are barely more similar to each other than the "
                             "accept threshold; expect many false rejections. Re-record in a quiet room.")
    profile = OwnerProfile(centroid=centroid, sample_embeddings=E, threshold=threshold,
                           model_id=embedder.model_id, stats=stats,
                           calibration={} if existing is None else existing.calibration)
    if existing is not None:
        profile.created_at = existing.created_at
    report["stats"] = stats
    return profile, report
