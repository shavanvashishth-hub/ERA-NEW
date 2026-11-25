import numpy as np
import pytest

from era_voice_identity import Status
from era_voice_identity.audio import SpeechDetector
from era_voice_identity.config import Config
from era_voice_identity.microphone import MicrophoneListener
from .conftest import synth_speech, SR

STATUSES = {"OWNER", "UNKNOWN", "INSUFFICIENT_AUDIO", "MODEL_ERROR", "NO_SPEECH"}


def enrolled(make_engine, owner_samples):
    e = make_engine()
    assert e.initialize()["ok"]
    out = e.enroll_owner(owner_samples)
    assert out["ok"], out
    return e


def test_1_registered_owner(make_engine, owner_samples):
    e = enrolled(make_engine, owner_samples)
    r = e.verify_speaker(synth_speech(110, 1.0, 5.0, seed=42))
    assert r["status"] == Status.OWNER and r["is_owner"] is True
    assert 0.5 <= r["confidence"] <= 1.0


def test_2_different_speaker_rejected(make_engine, owner_samples):
    e = enrolled(make_engine, owner_samples)
    r = e.verify_speaker(synth_speech(210, 1.25, 5.0, seed=7))
    assert r["status"] == Status.UNKNOWN and r["is_owner"] is False
    assert r["confidence"] < 0.5


def test_4_background_noise_still_owner_or_safe(make_engine, owner_samples):
    e = enrolled(make_engine, owner_samples)
    r = e.verify_speaker(synth_speech(110, 1.0, 5.0, seed=3, noise_db=-45))
    assert r["status"] in STATUSES
    assert r["is_owner"] == (r["status"] == Status.OWNER)


def test_5_low_volume_speech_detected(make_engine, owner_samples):
    e = enrolled(make_engine, owner_samples)
    r = e.verify_speaker(synth_speech(110, 1.0, 5.0, seed=5, level_db=-38))
    assert r["status"] != Status.NO_SPEECH


def test_9_insufficient_audio(make_engine, owner_samples):
    e = enrolled(make_engine, owner_samples)
    r = e.verify_speaker(synth_speech(110, 1.0, 1.0, seed=1))
    assert r["status"] in (Status.INSUFFICIENT_AUDIO, Status.NO_SPEECH) and not r["is_owner"]
    assert e.verify_speaker(np.zeros(100, np.float32))["status"] == Status.INSUFFICIENT_AUDIO


def test_silence_and_stationary_noise_never_owner(make_engine, owner_samples):
    e = enrolled(make_engine, owner_samples)
    assert e.verify_speaker(np.zeros(SR * 4, np.float32))["status"] == Status.NO_SPEECH
    noise = (np.random.default_rng(0).standard_normal(SR * 4) * 0.02).astype(np.float32)
    r = e.verify_speaker(noise)
    assert r["status"] == Status.NO_SPEECH and not r["is_owner"]


def test_10_model_failure_load(make_engine):
    e = make_engine(fail="load")
    assert e.initialize()["ok"] is False
    r = e.verify_speaker(synth_speech(110, 1.0, 5.0))
    assert r["status"] == Status.MODEL_ERROR and r["is_owner"] is False


def test_10_model_failure_inference(make_engine, owner_samples):
    e = enrolled(make_engine, owner_samples)
    e.embedder.fail = "embed"
    r = e.verify_speaker(synth_speech(110, 1.0, 5.0))
    assert r["status"] == Status.MODEL_ERROR and r["is_owner"] is False


def test_not_enrolled_fails_closed(make_engine):
    e = make_engine()
    e.initialize()
    r = e.verify_speaker(synth_speech(110, 1.0, 5.0))
    assert r["status"] == Status.UNKNOWN and not r["is_owner"]


def test_bad_input_never_raises(make_engine, owner_samples):
    e = enrolled(make_engine, owner_samples)
    for bad in (None, "no_such_file.wav", [], object(), np.array([np.nan] * 20000)):
        r = e.verify_speaker(bad)
        assert r["status"] in STATUSES and r["is_owner"] is False


def test_all_non_owner_statuses_have_is_owner_false(make_engine, owner_samples):
    e = enrolled(make_engine, owner_samples)
    for audio in (np.zeros(10), synth_speech(250, 1.3, 5.0), np.zeros(SR * 3)):
        r = e.verify_speaker(audio)
        assert r["is_owner"] == (r["status"] == Status.OWNER)


def test_corrupt_profile_fails_closed(make_engine, owner_samples, tmp_path):
    e = enrolled(make_engine, owner_samples)
    p = e.profiles.path
    data = bytearray(p.read_bytes()); data[-20] ^= 0xFF; p.write_bytes(bytes(data))
    e2 = make_engine(); e2.initialize()
    assert e2.profile is None
    assert not e2.verify_speaker(synth_speech(110, 1.0, 5.0))["is_owner"]


def test_enrollment_validation_and_reset(make_engine, owner_samples):
    e = make_engine(); e.initialize()
    short = [synth_speech(110, 1.0, 1.5, seed=i) for i in range(4)]
    out = e.enroll_owner(short)
    assert not out["ok"] and out["report"]["rejected"]
    assert e.enroll_owner(owner_samples)["ok"]
    assert e.reset_profile() is True and e.profile is None
    assert not e.profiles.exists()
    assert e.enroll_owner(owner_samples)["ok"]          # re-enrollment


def test_enrollment_rejects_other_speaker_outlier(make_engine, owner_samples):
    e = make_engine(enroll_consistency_min=0.5); e.initialize()
    mix = owner_samples + [synth_speech(220, 1.3, 6.0, seed=99)]
    out = e.enroll_owner(mix)
    assert out["ok"]
    assert any("inconsistent" in r for rej in out["report"]["rejected"] for r in rej["reasons"])


def test_append_enrollment(make_engine, owner_samples):
    e = enrolled(make_engine, owner_samples[:3])
    out = e.enroll_owner([synth_speech(110, 1.0, 6.0, seed=77)], append=True)
    assert out["ok"] and out["report"]["stats"]["n_samples"] == 4


def test_monitoring_segmenter_runs_model_sparingly_and_handles_speaker_change(make_engine, owner_samples):
    e = enrolled(make_engine, owner_samples)
    results = []
    lst = MicrophoneListener(e.cfg, e.detector, e.verify_speaker, results.append)
    owner = synth_speech(110, 1.0, 8.0, seed=11)
    other = synth_speech(210, 1.25, 8.0, seed=12)
    gap = np.zeros(SR * 2, np.float32)
    stream = np.concatenate([np.zeros(SR), owner, gap, other, gap])
    n = lst.n
    calls_before = e.embedder.calls
    for i in range(0, len(stream) - n, n):
        lst.process_frame(stream[i:i + n])
    kinds = [(r["status"]) for r in results]
    assert Status.OWNER in kinds and Status.UNKNOWN in kinds
    assert kinds.index(Status.OWNER) < kinds.index(Status.UNKNOWN)
    frames = len(stream) // n
    assert (e.embedder.calls - calls_before) < frames / 20      # far fewer inferences than frames


def test_monitoring_silence_produces_no_owner(make_engine, owner_samples):
    e = enrolled(make_engine, owner_samples)
    results = []
    lst = MicrophoneListener(e.cfg, e.detector, e.verify_speaker, results.append)
    n = lst.n
    silence = np.zeros(SR * 10, np.float32)
    for i in range(0, len(silence) - n, n):
        lst.process_frame(silence[i:i + n])
    assert results == []
