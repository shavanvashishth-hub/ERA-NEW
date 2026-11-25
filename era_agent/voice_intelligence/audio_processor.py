"""ERA Audio Quality Validator, VAD, and Preprocessing Engine.

Audits incoming microphone buffers for clipping, noise floor, SNR, and energy,
extracts valid speech segments with preroll buffering and hangover, and ensures
that audio sent to speech recognition is clean, unclipped, and properly calibrated.
"""
from __future__ import annotations

import base64
import math
from dataclasses import dataclass
from typing import Optional, Tuple, Union

import numpy as np


@dataclass
class AudioQualityMetrics:
    sample_rate: int
    duration_sec: float
    rms_db: float
    peak_amplitude: float
    clipping_ratio: float
    estimated_snr_db: float
    speech_frames_ratio: float
    is_clipped: bool
    is_silent: bool
    is_low_snr: bool
    quality_score: float  # 0.0 (unusable) to 1.0 (crystal clear)
    status_summary: str


class AudioProcessor:
    """Processes raw microphone audio, validates acoustic quality, and segments speech."""

    def __init__(
        self,
        target_sample_rate: int = 16000,
        silence_threshold_db: float = -55.0,
        min_snr_db: float = 8.0,
        max_clipping_ratio: float = 0.005,
        preroll_ms: int = 250,
        hangover_ms: int = 500,
    ) -> None:
        self.target_sr = target_sample_rate
        self.silence_threshold_db = silence_threshold_db
        self.min_snr_db = min_snr_db
        self.max_clipping_ratio = max_clipping_ratio
        self.preroll_ms = preroll_ms
        self.hangover_ms = hangover_ms

    @staticmethod
    def pcm16_to_float32(pcm_bytes: bytes) -> np.ndarray:
        """Converts raw 16-bit PCM byte buffer (little endian) into mono float32 in [-1.0, 1.0]."""
        if not pcm_bytes:
            return np.zeros(0, dtype=np.float32)
        int16_arr = np.frombuffer(pcm_bytes, dtype=np.int16)
        return (int16_arr.astype(np.float32) / 32768.0).copy()

    @staticmethod
    def float32_to_pcm16(audio: np.ndarray) -> bytes:
        """Converts mono float32 array in [-1.0, 1.0] into raw 16-bit PCM bytes."""
        if audio.size == 0:
            return b""
        clamped = np.clip(audio, -1.0, 1.0)
        int16_arr = (clamped * 32767.0).astype(np.int16)
        return int16_arr.tobytes()

    @staticmethod
    def base64_to_float32(b64_string: str) -> np.ndarray:
        """Decodes base64-encoded audio (raw PCM 16-bit, WAV, or container audio) into float32 array."""
        raw_bytes = base64.b64decode(b64_string)
        if not raw_bytes:
            return np.zeros(0, dtype=np.float32)
        # Check if bytes start with a container format (WAV, MP3, OGG, FLAC)
        if raw_bytes.startswith(b"RIFF") or raw_bytes.startswith(b"ID3") or raw_bytes[:2] in (b"\xff\xfb", b"\xff\xf3", b"OG", b"fL"):
            try:
                import io
                import soundfile as sf
                data, sr = sf.read(io.BytesIO(raw_bytes), dtype="float32")
                if len(data.shape) > 1:
                    data = data[:, 0]
                if sr != 16000 and data.size > 0:
                    try:
                        from scipy.signal import resample_poly
                        g = math.gcd(int(sr), 16000)
                        data = resample_poly(data, 16000 // g, int(sr) // g).astype(np.float32)
                    except Exception:
                        pass
                return data.astype(np.float32)
            except Exception:
                pass
        return AudioProcessor.pcm16_to_float32(raw_bytes)

    @staticmethod
    def float32_to_base64(audio: np.ndarray) -> str:
        """Encodes float32 array into base64 16-bit PCM string."""
        pcm_bytes = AudioProcessor.float32_to_pcm16(audio)
        return base64.b64encode(pcm_bytes).decode("ascii")

    def resample_if_needed(self, audio: np.ndarray, source_sr: int) -> np.ndarray:
        """Resamples audio array to target_sr using polyphase filtering or linear interpolation."""
        if source_sr == self.target_sr or audio.size == 0:
            return audio.astype(np.float32)
        try:
            from scipy.signal import resample_poly
            g = math.gcd(int(source_sr), int(self.target_sr))
            return resample_poly(audio, self.target_sr // g, source_sr // g).astype(np.float32)
        except Exception:
            new_len = int(round(len(audio) * self.target_sr / source_sr))
            return np.interp(
                np.linspace(0, len(audio) - 1, new_len),
                np.arange(len(audio)),
                audio,
            ).astype(np.float32)

    def analyze_quality(self, audio: np.ndarray, sample_rate: Optional[int] = None) -> AudioQualityMetrics:
        """Computes comprehensive acoustic quality metrics for an audio buffer."""
        sr = sample_rate or self.target_sr
        if audio.size == 0:
            return AudioQualityMetrics(
                sample_rate=sr,
                duration_sec=0.0,
                rms_db=-100.0,
                peak_amplitude=0.0,
                clipping_ratio=0.0,
                estimated_snr_db=0.0,
                speech_frames_ratio=0.0,
                is_clipped=False,
                is_silent=True,
                is_low_snr=True,
                quality_score=0.0,
                status_summary="Empty audio buffer",
            )

        duration = float(len(audio)) / sr
        peak = float(np.max(np.abs(audio)))

        # 1. Clipping detection
        clipped_samples = int(np.sum(np.abs(audio) >= 0.995))
        clipping_ratio = float(clipped_samples) / float(len(audio))
        is_clipped = clipping_ratio > self.max_clipping_ratio

        # 2. RMS energy (in dBFS)
        mean_sq = float(np.mean(audio.astype(np.float64) ** 2))
        rms_db = float(10.0 * np.log10(mean_sq + 1e-12))
        is_silent = rms_db < self.silence_threshold_db or duration < 0.15

        # 3. Frame-based noise floor & SNR estimation
        frame_len = int(0.025 * sr)  # 25ms frames
        hop_len = int(0.010 * sr)    # 10ms hop
        if len(audio) < frame_len:
            frame_energies = np.array([rms_db])
        else:
            num_frames = 1 + (len(audio) - frame_len) // hop_len
            frames = np.lib.stride_tricks.as_strided(
                audio,
                shape=(num_frames, frame_len),
                strides=(audio.strides[0] * hop_len, audio.strides[0]),
            )
            frame_sq = np.mean(frames.astype(np.float64) ** 2, axis=1)
            frame_energies = 10.0 * np.log10(frame_sq + 1e-12)

        # 10th percentile as estimated background noise floor
        noise_floor_db = float(np.percentile(frame_energies, 15))
        # 90th percentile as estimated speech peak energy
        speech_energy_db = float(np.percentile(frame_energies, 90))
        snr_db = max(0.0, speech_energy_db - noise_floor_db)
        is_low_snr = snr_db < self.min_snr_db

        # 4. Voiced frame ratio (frames significantly above noise floor)
        speech_frame_thresh = max(noise_floor_db + 8.0, -45.0)
        voiced_frames = int(np.sum(frame_energies > speech_frame_thresh))
        speech_ratio = float(voiced_frames) / float(len(frame_energies))

        # 5. Composite Quality Score (0.0 to 1.0)
        q = 1.0
        if is_silent:
            q = 0.05
        else:
            # Penalize low SNR
            if snr_db < 20.0:
                q *= max(0.2, snr_db / 20.0)
            # Penalize clipping
            if is_clipped:
                q *= max(0.3, 1.0 - (clipping_ratio * 15.0))
            # Penalize too low or too high RMS
            if rms_db < -35.0:
                q *= max(0.4, (rms_db + 50.0) / 15.0)
            elif rms_db > -3.0:
                q *= 0.8  # near saturation

        quality_score = float(np.clip(q, 0.0, 1.0))

        # Status summary
        if is_silent:
            status = "SILENT"
        elif is_clipped and is_low_snr:
            status = "CLIPPED_AND_NOISY"
        elif is_clipped:
            status = "CLIPPED"
        elif is_low_snr:
            status = "LOW_SNR"
        elif quality_score >= 0.75:
            status = "EXCELLENT"
        else:
            status = "ACCEPTABLE"

        return AudioQualityMetrics(
            sample_rate=sr,
            duration_sec=duration,
            rms_db=rms_db,
            peak_amplitude=peak,
            clipping_ratio=clipping_ratio,
            estimated_snr_db=snr_db,
            speech_frames_ratio=speech_ratio,
            is_clipped=is_clipped,
            is_silent=is_silent,
            is_low_snr=is_low_snr,
            quality_score=quality_score,
            status_summary=status,
        )

    def preprocess_audio(
        self,
        audio: np.ndarray,
        source_sr: int = 16000,
        remove_dc: bool = True,
        normalize_peak: bool = True,
    ) -> Tuple[np.ndarray, AudioQualityMetrics]:
        """Cleans and standardizes audio buffer for ASR without altering speech phonetics."""
        x = audio.astype(np.float32)
        if x.size == 0:
            return x, self.analyze_quality(x, source_sr)

        # 1. Resample to target rate (16kHz)
        if source_sr != self.target_sr:
            x = self.resample_if_needed(x, source_sr)

        # 2. Remove DC bias
        if remove_dc:
            x = x - float(np.mean(x))

        # 3. Analyze quality before gain changes
        metrics = self.analyze_quality(x, self.target_sr)

        # 4. Safe peak normalization: scale quiet speech up to -1.5 dBFS (0.841)
        if normalize_peak and not metrics.is_silent:
            peak = float(np.max(np.abs(x)))
            if 0.005 < peak < 0.85:
                # Target peak: -1.5 dBFS (approx 0.841)
                target_peak = 0.841
                scale = target_peak / peak
                # Limit scale to at most 10.0x to avoid amplifying noise excessively
                scale = min(10.0, scale)
                x = x * scale

        # Final clip safety
        x = np.clip(x, -1.0, 1.0)
        return x, metrics

    def trim_silence_with_vad(
        self,
        audio: np.ndarray,
        sr: int = 16000,
    ) -> np.ndarray:
        """Trims leading and trailing silence while guaranteeing pre-speech and hangover padding."""
        if len(audio) < int(0.2 * sr):
            return audio

        frame_len = int(0.02 * sr)  # 20ms
        hop_len = int(0.01 * sr)    # 10ms
        num_frames = 1 + (len(audio) - frame_len) // hop_len
        if num_frames <= 1:
            return audio

        frames = np.lib.stride_tricks.as_strided(
            audio,
            shape=(num_frames, frame_len),
            strides=(audio.strides[0] * hop_len, audio.strides[0]),
        )
        energies = 10.0 * np.log10(np.mean(frames.astype(np.float64) ** 2, axis=1) + 1e-12)
        noise_floor = float(np.percentile(energies, 15))
        thresh = max(noise_floor + 7.0, -42.0)

        voiced_indices = np.where(energies > thresh)[0]
        if len(voiced_indices) == 0:
            return audio  # Keep as-is if no clear voiced frames

        first_frame = int(voiced_indices[0])
        last_frame = int(voiced_indices[-1])

        preroll_samples = int((self.preroll_ms / 1000.0) * sr)
        hangover_samples = int((self.hangover_ms / 1000.0) * sr)

        start_sample = max(0, (first_frame * hop_len) - preroll_samples)
        end_sample = min(len(audio), (last_frame * hop_len + frame_len) + hangover_samples)

        return audio[start_sample:end_sample].copy()
