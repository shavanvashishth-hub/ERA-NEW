"""Authorization layer on top of voice verification.

Voice matching alone does NOT prove a live human is speaking: a replayed recording or a
cloned voice can score as the owner. Sensitive actions therefore need extra factors.
"""
from __future__ import annotations

import enum
import logging
import re
import secrets
import time
from collections import deque
from dataclasses import dataclass
from typing import Callable, Optional

import numpy as np

from .config import Config, Status

log = logging.getLogger("era_voice_identity.security")


class Sensitivity(enum.IntEnum):
    PUBLIC = 0        # no identity needed (e.g. "what time is it")
    OWNER_VOICE = 1   # fresh OWNER voice result required (e.g. open an app)
    SENSITIVE = 2     # voice + liveness challenge + second factor (e.g. shutdown, payments, messages)


@dataclass
class AuthDecision:
    allowed: bool
    reason: str
    needs: Optional[str] = None


class ReplayGuard:
    """Flags near-identical embeddings heard >= replay_min_age_s apart.

    Catches re-playing the *same* recording. It does NOT catch a new recording or a cloned voice.
    """

    def __init__(self, cfg: Config, keep: int = 50):
        self.cfg = cfg
        self.hist: deque = deque(maxlen=keep)

    def check_and_add(self, emb: np.ndarray, accepted: bool) -> bool:
        now, flagged = time.time(), False
        for t, e in self.hist:
            if now - t >= self.cfg.replay_min_age_s and float(np.dot(emb, e)) >= self.cfg.replay_cosine:
                flagged = True
                break
        if accepted:
            self.hist.append((now, emb.copy()))
        return flagged


class ChallengeLiveness:
    """Random-digit challenge-response. A pre-recorded replay cannot know the digits.

    Plug in your own speech-to-text (`transcribe`) and prompt/record callables. This stops
    replay of old recordings; it does NOT stop a real-time voice-cloning/TTS attacker.
    """

    def __init__(self, engine, transcribe: Callable[[np.ndarray], str],
                 prompt: Callable[[str], None], record: Callable[[float], np.ndarray],
                 digits: int = 4, seconds: float = 5.0):
        self.engine, self.transcribe, self.prompt, self.record = engine, transcribe, prompt, record
        self.digits, self.seconds = digits, seconds

    def __call__(self) -> bool:
        code = "".join(secrets.choice("0123456789") for _ in range(self.digits))
        self.prompt(f"Say these digits: {' '.join(code)}")
        audio = self.record(self.seconds)
        res = self.engine.verify_speaker(audio)
        if not res["is_owner"]:
            return False
        heard = re.sub(r"\D", "", self.transcribe(audio) or "")
        return code in heard


class SecurityGate:
    def __init__(self, cfg: Config, liveness: Optional[Callable[[], bool]] = None,
                 second_factor: Optional[Callable[[], bool]] = None):
        self.cfg, self.liveness, self.second_factor = cfg, liveness, second_factor

    def authorize(self, sensitivity: Sensitivity, result: Optional[dict]) -> AuthDecision:
        try:
            if sensitivity == Sensitivity.PUBLIC:
                return AuthDecision(True, "public command")
            if not result or not result.get("is_owner") or result.get("status") != Status.OWNER:
                return AuthDecision(False, "owner voice not verified", "voice")
            if time.time() - float(result.get("timestamp", 0)) > self.cfg.owner_result_ttl_s:
                return AuthDecision(False, "voice verification expired", "voice")
            if "possible_replay" in result.get("flags", []):
                return AuthDecision(False, "possible replayed recording", "liveness")
            if sensitivity == Sensitivity.OWNER_VOICE:
                return AuthDecision(True, "owner voice verified")
            # SENSITIVE
            if float(result.get("score", 0.0)) < float(result.get("threshold", 1.0)) + self.cfg.strict_margin:
                return AuthDecision(False, "voice match not strong enough for a sensitive action", "voice")
            if self.liveness is None or self.second_factor is None:
                return AuthDecision(False, "sensitive action needs liveness + second factor (not configured)",
                                    "liveness+second_factor")
            if not self.liveness():
                return AuthDecision(False, "liveness challenge failed", "liveness")
            if not self.second_factor():
                return AuthDecision(False, "second factor failed", "second_factor")
            return AuthDecision(True, "voice + liveness + second factor passed")
        except Exception as exc:  # fail closed
            log.exception("authorization error")
            return AuthDecision(False, f"authorization error: {exc}")
