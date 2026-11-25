"""Public API: VoiceIdentityEngine plus module-level convenience functions."""
from __future__ import annotations

import logging
import threading
import time
from typing import Callable, Optional

import numpy as np

from .audio import SpeechDetector, load_audio
from .config import Config, Status
from .enrollment import EnrollmentError, build_profile
from .microphone import MicrophoneListener
from .profile_manager import OwnerProfile, ProfileError, ProfileManager
from .security import ReplayGuard
from .verification import (SpeechBrainEmbedder, Verifier, _unit, cosine, make_result)

log = logging.getLogger("era_voice_identity")


class VoiceIdentityEngine:
    def __init__(self, config: Optional[Config] = None, embedder=None):
        self.cfg = config or Config()
        self.embedder = embedder or SpeechBrainEmbedder(self.cfg)
        self.detector = SpeechDetector(self.cfg)
        self.verifier = Verifier(self.cfg, self.embedder, self.detector)
        self.profiles = ProfileManager(self.cfg.data_dir)
        self.replay_guard = ReplayGuard(self.cfg)
        self.profile: Optional[OwnerProfile] = None
        self._lock = threading.RLock()
        self._model_ready = False
        self._init_error: Optional[str] = None
        self._last_init_try = 0.0
        self._listener: Optional[MicrophoneListener] = None
        self._user_cb: Optional[Callable[[dict], None]] = None
        self.last_result: Optional[dict] = None

    # ------------------------------------------------------------------ init
    def initialize(self) -> dict:
        with self._lock:
            self._last_init_try = time.time()
            try:
                self.embedder.load()
                self._model_ready, self._init_error = True, None
            except Exception as exc:
                self._model_ready, self._init_error = False, f"{type(exc).__name__}: {exc}"
                log.exception("model initialisation failed")
            self._load_profile()
            return {"ok": self._model_ready, "error": self._init_error,
                    "enrolled": self.profile is not None}

    def _load_profile(self) -> None:
        try:
            self.profile = self.profiles.load() if self.profiles.exists() else None
            if self.profile and self.profile.model_id != self.embedder.model_id:
                log.error("profile was made with a different model; re-enroll")
                self.profile = None
                self._profile_error = "Profile was created with a different model"
        except ProfileError as exc:
            self.profile = None          # fail closed: nobody is the owner
            self._profile_error = str(exc)
            log.error("profile load failed: %s", exc)

    _profile_error: Optional[str] = None

    def _ensure_ready(self) -> bool:
        if self._model_ready:
            return True
        if time.time() - self._last_init_try > 30:  # retry occasionally, not on every call
            self.initialize()
        return self._model_ready

    # ------------------------------------------------------------ enrollment
    def enroll_owner(self, audio_samples: list, sample_rate: Optional[int] = None,
                     append: bool = False) -> dict:
        """audio_samples: list of arrays / wav paths / PCM bytes, one per recording."""
        with self._lock:
            if not self._ensure_ready():
                return {"ok": False, "error": f"model not available: {self._init_error}"}
            try:
                existing = self.profile if append else None
                profile, report = build_profile(audio_samples, self.cfg, self.embedder,
                                                self.detector, sample_rate, existing)
                self.profiles.save(profile)
                self.profile, self._profile_error = profile, None
                return {"ok": True, "report": report}
            except EnrollmentError as exc:
                return {"ok": False, "error": str(exc), "report": exc.report}
            except Exception as exc:
                log.exception("enrollment failed")
                return {"ok": False, "error": f"enrollment failed: {exc}"}

    def reset_profile(self) -> bool:
        with self._lock:
            self.profile = None
            self.replay_guard.hist.clear()
            return self.profiles.reset()

    # ----------------------------------------------------------- verification
    def verify_speaker(self, audio, sample_rate: Optional[int] = None) -> dict:
        """Never raises. Anything other than a confirmed match is is_owner=False."""
        try:
            with self._lock:
                if not self._ensure_ready():
                    res = make_result(Status.MODEL_ERROR, 0.0,
                                      f"Voice model unavailable: {self._init_error}")
                else:
                    res = self.verifier.verify(audio, sample_rate, self.profile)
                    if self.profile is None and self._profile_error and res["status"] == Status.UNKNOWN:
                        res["reason"] = f"Owner profile unavailable: {self._profile_error}"
                    self._replay_check(res, audio, sample_rate)
        except Exception as exc:
            log.exception("verify_speaker crashed")
            res = make_result(Status.MODEL_ERROR, 0.0, f"Unexpected error: {exc}")
        if res["status"] != Status.OWNER:
            res["is_owner"] = False
        self.last_result = res
        return res

    def _replay_check(self, res: dict, audio, sr) -> None:
        emb = self.verifier.last_embedding
        if emb is None or res["status"] not in (Status.OWNER, Status.UNKNOWN):
            return
        if self.replay_guard.check_and_add(emb, res["status"] == Status.OWNER):
            res.setdefault("flags", []).append("possible_replay")

    # ------------------------------------------------------------- threshold
    def calibrate_threshold(self, owner_audio: list, impostor_audio: list,
                            target_far: float = 0.01, sample_rate: Optional[int] = None) -> dict:
        """Pick a threshold from REAL held-out recordings; stores it in the profile."""
        with self._lock:
            if self.profile is None or not self._ensure_ready():
                return {"ok": False, "error": "need a loaded profile and model"}
            def scores(items):
                out = []
                for a in items:
                    wave = load_audio(a, sample_rate, self.cfg.sample_rate)
                    sp, s, _ = self.detector.extract(wave)
                    if s >= self.cfg.min_speech_s:
                        out.append(cosine(self.embedder.embed(sp[-int(self.cfg.max_verify_speech_s*self.cfg.sample_rate):]),
                                          self.profile.centroid))
                return np.array(out)
            gen, imp = scores(owner_audio), scores(impostor_audio)
            if len(gen) < 5 or len(imp) < 5:
                return {"ok": False, "error": "need at least 5 usable owner and 5 usable impostor clips"}
            thr = float(np.quantile(imp, 1 - target_far)) + 1e-4
            thr = max(thr, self.cfg.min_threshold)
            self.profile.threshold = thr
            self.profile.calibration = {
                "target_far": target_far, "n_owner": int(len(gen)), "n_impostor": int(len(imp)),
                "frr_at_threshold": float(np.mean(gen < thr)),
                "far_at_threshold": float(np.mean(imp >= thr)),
                "reliable_far_estimate": bool(len(imp) >= 3 / max(target_far, 1e-6))}
            self.profiles.save(self.profile)
            return {"ok": True, "threshold": thr, **self.profile.calibration}

    # ------------------------------------------------------------ monitoring
    def start_monitoring(self, on_result: Optional[Callable[[dict], None]] = None) -> bool:
        with self._lock:
            if self._listener and self._listener.state["running"]:
                return True
            if not self._ensure_ready():
                return False
            self._user_cb = on_result

            def handle(res):
                self.last_result = res
                if self._user_cb:
                    self._user_cb(res)
            self._listener = MicrophoneListener(self.cfg, self.detector, self.verify_speaker, handle)
            self._listener.start()
            return True

    def stop_monitoring(self) -> None:
        if self._listener:
            self._listener.stop()

    def get_status(self) -> dict:
        lst = self._listener.state if self._listener else {"running": False, "mic": "closed"}
        return {"model_ready": self._model_ready, "model_error": self._init_error,
                "device": getattr(self.embedder, "device", "unknown"),
                "enrolled": self.profile is not None, "profile_error": self._profile_error,
                "threshold": None if self.profile is None else self.profile.threshold,
                "monitoring": dict(lst), "last_result": self.last_result}


# ---- module-level convenience API (single shared engine) -------------------------
_engine: Optional[VoiceIdentityEngine] = None


def _get() -> VoiceIdentityEngine:
    global _engine
    if _engine is None:
        _engine = VoiceIdentityEngine()
    return _engine


def initialize(config: Optional[Config] = None) -> dict:
    global _engine
    if config is not None:
        _engine = VoiceIdentityEngine(config)
    return _get().initialize()


def enroll_owner(audio_samples, sample_rate=None, append=False) -> dict:
    return _get().enroll_owner(audio_samples, sample_rate, append)


def verify_speaker(audio, sample_rate=None) -> dict:
    return _get().verify_speaker(audio, sample_rate)


def start_monitoring(on_result=None) -> bool:
    return _get().start_monitoring(on_result)


def stop_monitoring() -> None:
    _get().stop_monitoring()


def get_status() -> dict:
    return _get().get_status()


def reset_profile() -> bool:
    return _get().reset_profile()
