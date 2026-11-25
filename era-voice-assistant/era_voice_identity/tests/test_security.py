import time
from era_voice_identity import SecurityGate, Sensitivity, Config
from era_voice_identity.config import Status

OWNER = lambda **k: {"is_owner": True, "status": Status.OWNER, "score": 0.9, "threshold": 0.4,
                     "timestamp": time.time(), **k}


def test_public_always_allowed():
    assert SecurityGate(Config()).authorize(Sensitivity.PUBLIC, None).allowed


def test_owner_voice_requires_fresh_owner():
    g = SecurityGate(Config())
    assert g.authorize(Sensitivity.OWNER_VOICE, OWNER()).allowed
    assert not g.authorize(Sensitivity.OWNER_VOICE, None).allowed
    assert not g.authorize(Sensitivity.OWNER_VOICE, OWNER(timestamp=time.time() - 60)).allowed
    assert not g.authorize(Sensitivity.OWNER_VOICE, {"is_owner": False, "status": Status.UNKNOWN}).allowed
    assert not g.authorize(Sensitivity.OWNER_VOICE, OWNER(flags=["possible_replay"])).allowed


def test_sensitive_fails_closed_without_extra_factors():
    assert not SecurityGate(Config()).authorize(Sensitivity.SENSITIVE, OWNER()).allowed


def test_sensitive_needs_both_factors_and_strong_score():
    ok = lambda: True
    no = lambda: False
    assert SecurityGate(Config(), ok, ok).authorize(Sensitivity.SENSITIVE, OWNER()).allowed
    assert not SecurityGate(Config(), no, ok).authorize(Sensitivity.SENSITIVE, OWNER()).allowed
    assert not SecurityGate(Config(), ok, no).authorize(Sensitivity.SENSITIVE, OWNER()).allowed
    assert not SecurityGate(Config(), ok, ok).authorize(Sensitivity.SENSITIVE, OWNER(score=0.45)).allowed


def test_exception_in_factor_fails_closed():
    def boom(): raise RuntimeError("x")
    assert not SecurityGate(Config(), boom, lambda: True).authorize(Sensitivity.SENSITIVE, OWNER()).allowed
