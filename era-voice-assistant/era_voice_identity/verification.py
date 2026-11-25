"""Embedding model wrapper, score calibration and the verification pipeline."""
from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Optional, Protocol

import numpy as np

from .audio import SpeechDetector, load_audio
from .config import Config, Status
from .profile_manager import OwnerProfile

log = logging.getLogger("era_voice_identity.verify")


class Embedder(Protocol):
    model_id: str
    def load(self) -> None: ...
    def embed(self, wave: np.ndarray) -> np.ndarray: ...


class SpoofDetector(Protocol):
    """Optional anti-spoofing plug-in (e.g. an AASIST / RawNet2 wrapper). Return P(spoof) in [0,1]."""
    threshold: float
    def score(self, wave: np.ndarray) -> float: ...


class SpeechBrainEmbedder:
    """ECAPA-TDNN (speechbrain/spkrec-ecapa-voxceleb), 192-d embeddings, CPU or CUDA."""

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.model_id = cfg.model_source
        self._model = None
        self.device = "cpu"

    def load(self) -> None:
        import torch  # imported lazily so the rest of the package works without it
        if self.cfg.num_threads:
            torch.set_num_threads(self.cfg.num_threads)
        dev = self.cfg.device
        if dev == "auto":
            dev = "cuda" if torch.cuda.is_available() else "cpu"
        try:
            from speechbrain.inference.speaker import EncoderClassifier   # SpeechBrain >= 1.0
        except ImportError:
            from speechbrain.pretrained import EncoderClassifier          # older releases
        savedir = self.cfg.model_dir
        savedir.mkdir(parents=True, exist_ok=True)
        source = str(savedir) if (savedir / "hyperparams.yaml").exists() else self.cfg.model_source
        kwargs = dict(source=source, savedir=str(savedir), run_opts={"device": dev})
        try:  # Windows without Developer Mode cannot create symlinks -> copy instead
            from speechbrain.utils.fetching import LocalStrategy
            kwargs["local_strategy"] = LocalStrategy.COPY
        except Exception:
            pass
        try:
            model = EncoderClassifier.from_hparams(**kwargs)
        except TypeError:
            kwargs.pop("local_strategy", None)
            model = EncoderClassifier.from_hparams(**kwargs)
        model.eval()
        self._model, self.device = model, dev
        self.embed(np.random.randn(16000).astype(np.float32) * 0.05)  # warm-up
        log.info("ECAPA model ready on %s", dev)

    def embed(self, wave: np.ndarray) -> np.ndarray:
        import torch
        if self._model is None:
            raise RuntimeError("model not loaded")
        with torch.inference_mode():
            t = torch.from_numpy(np.ascontiguousarray(wave, np.float32)).unsqueeze(0).to(self.device)
            e = self._model.encode_batch(t).squeeze().detach().cpu().numpy().astype(np.float32)
        return _unit(e)


def _unit(v: np.ndarray) -> np.ndarray:
    v = np.asarray(v, np.float32).reshape(-1)
    n = float(np.linalg.norm(v))
    if not np.isfinite(n) or n < 1e-8:
        raise ValueError("degenerate embedding")
    return v / n


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(_unit(a), _unit(b)))


def confidence_from_score(score: float, threshold: float, scale: float) -> float:
    """Monotonic 0-1 *index* centred on the decision threshold. NOT a probability of identity."""
    z = float(np.clip((score - threshold) / max(scale, 1e-6), -30, 30))
    return float(1.0 / (1.0 + np.exp(-z)))


def make_result(status: str, confidence: float, reason: str, **extra) -> dict:
    out = {"is_owner": status == Status.OWNER, "status": status,
           "confidence": round(float(confidence), 4), "reason": reason,
           "timestamp": time.time()}
    out.update(extra)
    return out


class Verifier:
    def __init__(self, cfg: Config, embedder: Embedder, detector: SpeechDetector):
        self.cfg, self.embedder, self.detector = cfg, embedder, detector
        self.spoof_detector: Optional[SpoofDetector] = None
        self.last_embedding: Optional[np.ndarray] = None

    def verify(self, audio, sample_rate: Optional[int], profile: Optional[OwnerProfile]) -> dict:
        t0 = time.perf_counter()
        cfg = self.cfg
        self.last_embedding = None
        try:
            wave = load_audio(audio, sample_rate, cfg.sample_rate)
        except Exception as exc:
            return make_result(Status.INSUFFICIENT_AUDIO, 0.0, f"Invalid audio input: {exc}")
        if wave.size < int(0.3 * cfg.sample_rate):
            return make_result(Status.INSUFFICIENT_AUDIO, 0.0, "Audio too short")
        speech, speech_s, _ = self.detector.extract(wave)
        if speech_s < cfg.no_speech_s:
            return make_result(Status.NO_SPEECH, 0.0, "No speech detected", speech_seconds=speech_s)
        if speech_s < cfg.min_speech_s:
            return make_result(Status.INSUFFICIENT_AUDIO, 0.0,
                               f"Only {speech_s:.1f}s of speech; need {cfg.min_speech_s:.1f}s",
                               speech_seconds=speech_s)
        speech = speech[-int(cfg.max_verify_speech_s * cfg.sample_rate):]
        if profile is None:
            return make_result(Status.UNKNOWN, 0.0, "No owner profile enrolled", speech_seconds=speech_s)

        if self.spoof_detector is not None:
            try:
                spoof = float(self.spoof_detector.score(speech))
            except Exception as exc:
                return make_result(Status.MODEL_ERROR, 0.0, f"Anti-spoof model failed: {exc}")
            if spoof >= self.spoof_detector.threshold:
                return make_result(Status.UNKNOWN, 0.0, "Audio flagged as possibly spoofed",
                                   spoof_score=spoof, speech_seconds=speech_s)
        try:
            emb = self.embedder.embed(speech)
            if emb.shape != profile.centroid.shape or not np.all(np.isfinite(emb)):
                raise ValueError("embedding shape/values do not match owner profile (model changed?)")
            score = cosine(emb, profile.centroid)
            self.last_embedding = emb
        except Exception as exc:
            log.exception("embedding failed")
            return make_result(Status.MODEL_ERROR, 0.0, f"Verification model error: {exc}")

        thr = profile.threshold
        conf = confidence_from_score(score, thr, cfg.confidence_scale)
        latency = (time.perf_counter() - t0) * 1000
        extra = dict(score=round(score, 4), threshold=round(thr, 4),
                     speech_seconds=round(speech_s, 2), latency_ms=round(latency, 1))
        if score >= thr:
            return make_result(Status.OWNER, conf, "Voice matched registered owner", **extra)
        return make_result(Status.UNKNOWN, conf, "Voice does not match owner profile", **extra)
