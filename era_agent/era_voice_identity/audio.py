"""Audio loading, resampling, VAD and quality checks (numpy only)."""
from __future__ import annotations

import math
import wave
from pathlib import Path
from typing import Optional, Tuple

import numpy as np

from .config import Config


def _read_wav(path: Path) -> Tuple[np.ndarray, int]:
    try:
        import soundfile as sf
        data, sr = sf.read(str(path), dtype="float32", always_2d=False)
        return data, int(sr)
    except ImportError:
        with wave.open(str(path), "rb") as w:
            if w.getsampwidth() != 2:
                raise ValueError("Without soundfile only 16-bit PCM WAV is supported")
            raw = w.readframes(w.getnframes())
            x = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
            if w.getnchannels() > 1:
                x = x.reshape(-1, w.getnchannels())
            return x, w.getframerate()


def resample(x: np.ndarray, sr: int, target: int) -> np.ndarray:
    if sr == target or x.size == 0:
        return x.astype(np.float32, copy=False)
    try:
        from scipy.signal import resample_poly
        g = math.gcd(int(sr), int(target))
        return resample_poly(x, target // g, sr // g).astype(np.float32)
    except ImportError:  # crude fallback
        n = int(round(len(x) * target / sr))
        return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)


def load_audio(audio, sample_rate: Optional[int] = None, target_sr: int = 16000) -> np.ndarray:
    """Accept ndarray / list / int16 PCM bytes / wav path -> mono float32 at target_sr in [-1, 1]."""
    sr = sample_rate or target_sr
    if isinstance(audio, (str, Path)):
        x, sr = _read_wav(Path(audio))
    elif isinstance(audio, (bytes, bytearray)):
        x = np.frombuffer(bytes(audio), dtype=np.int16)
    else:
        x = np.asarray(audio)
    if x.size == 0:
        return np.zeros(0, np.float32)
    if x.dtype.kind == "i":
        x = x.astype(np.float32) / float(np.iinfo(x.dtype).max + 1)
    elif x.dtype.kind == "u":
        half = (np.iinfo(x.dtype).max + 1) / 2.0
        x = (x.astype(np.float32) - half) / half
    else:
        x = x.astype(np.float32)
    if x.ndim == 2:
        x = x.mean(axis=1 if x.shape[1] <= x.shape[0] else 0)
    elif x.ndim != 1:
        raise ValueError("audio must be 1-D or 2-D")
    x = np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0)
    return resample(x, int(sr), target_sr)


def rms_db(x: np.ndarray) -> float:
    if x.size == 0:
        return -120.0
    return float(10 * np.log10(np.mean(x.astype(np.float64) ** 2) + 1e-12))


def _runs(mask: np.ndarray):
    if mask.size == 0:
        return np.array([], int), np.array([], int)
    idx = np.flatnonzero(np.diff(mask.astype(np.int8))) + 1
    return np.r_[0, idx], np.r_[idx, len(mask)]


def smooth_mask(mask: np.ndarray, fill_gap: int, min_run: int) -> np.ndarray:
    """Fill short False gaps between speech, then drop short True bursts."""
    m = mask.copy()
    s, e = _runs(m)
    for a, b in zip(s, e):
        if not m[a] and a > 0 and b < len(m) and (b - a) <= fill_gap:
            m[a:b] = True
    s, e = _runs(m)
    for a, b in zip(s, e):
        if m[a] and (b - a) < min_run:
            m[a:b] = False
    return m


class SpeechDetector:
    """Energy + speech-band VAD with a noise floor estimated from the clip itself."""

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.sr = cfg.sample_rate
        self.n = int(self.sr * cfg.frame_ms / 1000)
        self.frame_s = self.n / self.sr
        freqs = np.fft.rfftfreq(self.n, 1.0 / self.sr)
        self._band = (freqs >= 100) & (freqs <= 4000)
        self._win = np.hanning(self.n).astype(np.float32)

    def frame_stats(self, frames: np.ndarray):
        e = 10 * np.log10(np.mean(frames.astype(np.float64) ** 2, axis=1) + 1e-12)
        spec = np.abs(np.fft.rfft(frames * self._win, axis=1)) ** 2
        ratio = spec[:, self._band].sum(axis=1) / (spec.sum(axis=1) + 1e-12)
        return e, ratio

    def frame_mask(self, wave_: np.ndarray) -> np.ndarray:
        nfr = len(wave_) // self.n
        if nfr == 0:
            return np.zeros(0, bool)
        frames = wave_[: nfr * self.n].reshape(nfr, self.n)
        e, ratio = self.frame_stats(frames)
        floor = np.percentile(e, 10)
        thr = max(floor + self.cfg.vad_margin_db, self.cfg.vad_abs_floor_db)
        mask = (e > thr) & (ratio >= self.cfg.speech_band_ratio_min)
        return smooth_mask(mask,
                           int(self.cfg.gap_fill_ms / self.cfg.frame_ms),
                           max(1, int(self.cfg.min_speech_run_ms / self.cfg.frame_ms)))

    def extract(self, wave_: np.ndarray):
        """Return (speech_audio, speech_seconds, noise_audio)."""
        mask = self.frame_mask(wave_)
        if mask.size == 0 or not mask.any():
            return np.zeros(0, np.float32), 0.0, wave_
        nfr = len(mask)
        frames = wave_[: nfr * self.n].reshape(nfr, self.n)
        return (frames[mask].reshape(-1), float(mask.sum() * self.frame_s),
                frames[~mask].reshape(-1))


def assess_quality(wave_: np.ndarray, speech: np.ndarray, noise: np.ndarray) -> dict:
    snr = None
    if speech.size and noise.size > 1600:
        snr = rms_db(speech) - rms_db(noise)
    return {
        "duration_s": len(wave_) / 16000.0,
        "speech_level_db": rms_db(speech),
        "clipping_ratio": float(np.mean(np.abs(wave_) >= 0.99)) if wave_.size else 0.0,
        "snr_db": snr,
    }
