"""Synthetic speech + a fake embedder so the PIPELINE LOGIC can be tested without the real model.

IMPORTANT: results from these tests say nothing about biometric accuracy. The fake embedder maps
(f0, spectral shape) to a vector; it is not ECAPA. Real FAR/FRR needs real recordings: see evaluate.py.
"""
import os, sys
import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from era_voice_identity import Config, VoiceIdentityEngine  # noqa: E402

SR = 16000


def synth_speech(f0=120.0, formant_scale=1.0, seconds=6.0, seed=0, level_db=-20.0, noise_db=None):
    """Harmonic 'voice' with syllable-like amplitude bursts and speaker-specific formant peaks."""
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    t = np.arange(n) / SR
    f0_t = f0 * (1 + 0.04 * np.sin(2 * np.pi * 0.7 * t + rng.uniform(0, 6)))
    phase = 2 * np.pi * np.cumsum(f0_t) / SR
    formants = np.array([500, 1500, 2500]) * formant_scale
    sig = np.zeros(n)
    for k in range(1, 30):
        fk = k * f0
        if fk > 4000:
            break
        gain = sum(np.exp(-0.5 * ((fk - fm) / (250 * formant_scale)) ** 2) for fm in formants) + 0.05
        sig += gain * np.sin(k * phase)
    env = np.clip(np.sin(2 * np.pi * 3.5 * t + rng.uniform(0, 6)) * 1.5, 0, 1)   # syllables w/ pauses
    env = np.convolve(env, np.ones(200) / 200, mode="same")
    sig *= env
    sig /= np.sqrt(np.mean(sig ** 2) + 1e-12)
    sig *= 10 ** (level_db / 20)
    if noise_db is not None:
        sig = sig + rng.standard_normal(n) * 10 ** (noise_db / 20)
    return np.clip(sig, -1, 1).astype(np.float32)


class FakeEmbedder:
    model_id = "fake-embedder"
    device = "cpu"

    def __init__(self, fail=False, dim=64):
        self.fail, self.dim, self.calls = fail, dim, 0
        self.W = np.random.default_rng(1234).standard_normal((dim, 3))
        self.b = np.random.default_rng(99).uniform(0, 6.28, dim)

    def load(self):
        if self.fail == "load":
            raise RuntimeError("simulated model load failure")

    def embed(self, wave):
        if self.fail == "embed":
            raise RuntimeError("simulated inference failure")
        self.calls += 1
        w = wave[: 16000 * 3]
        ac = np.correlate(w[:8000], w[:8000], "full")[7999:]
        lo, hi = 16000 // 400, 16000 // 70
        f0 = 16000 / (lo + np.argmax(ac[lo:hi]))
        spec = np.abs(np.fft.rfft(w * np.hanning(len(w))))
        fr = np.fft.rfftfreq(len(w), 1 / 16000)
        centroid = float((spec * fr).sum() / (spec.sum() + 1e-9))
        spread = float(np.sqrt(((fr - centroid) ** 2 * spec).sum() / (spec.sum() + 1e-9)))
        feats = np.array([f0 / 60.0, centroid / 400.0, spread / 400.0])
        v = np.cos(self.W @ feats + self.b)
        return (v / np.linalg.norm(v)).astype(np.float32)


@pytest.fixture
def make_engine(tmp_path):
    def _make(fail=False, **cfg):
        e = VoiceIdentityEngine(Config(data_dir=tmp_path, threshold=0.6, **cfg), embedder=FakeEmbedder(fail))
        return e
    return _make


@pytest.fixture
def owner_samples():
    return [synth_speech(110, 1.0, 6.0, seed=s) for s in range(4)]
