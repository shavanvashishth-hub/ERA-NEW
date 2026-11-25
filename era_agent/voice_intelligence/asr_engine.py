"""ERA Advanced Multilingual Speech Recognition Engine.

Powered by Faster-Whisper with CTranslate2 optimization, vocabulary prompting,
calibrated acoustic confidence scoring, and strict preservation of spoken language
(never translates Hindi speech to English).
"""
from __future__ import annotations

import logging
import math
import os
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from .audio_processor import AudioQualityMetrics, AudioProcessor
from .vocabulary import vocabulary_manager

log = logging.getLogger("era.asr")


@dataclass
class TranscriptionWord:
    word: str
    start: float
    end: float
    probability: float


@dataclass
class ASRResult:
    raw_transcript: str
    language: str
    language_probability: float
    confidence_score: float  # Calibrated [0.0 - 1.0]
    duration_sec: float
    latency_ms: float
    words: List[TranscriptionWord] = field(default_factory=list)
    quality_metrics: Optional[AudioQualityMetrics] = None
    is_speech: bool = True
    error_message: Optional[str] = None


class ASREngine:
    """Manages local high-accuracy speech-to-text inference with vocabulary bias."""

    def __init__(
        self,
        model_size: str = "small",
        preferred_device: str = "cuda",
        compute_type: str = "float16",
        cpu_threads: int = 6,
    ) -> None:
        self.model_size = model_size
        self.preferred_device = preferred_device
        self.compute_type = compute_type
        self.cpu_threads = cpu_threads
        self._model = None
        self.actual_device = "unloaded"
        self.actual_compute_type = "unloaded"
        self.audio_proc = AudioProcessor()

    def _ensure_model_loaded(self) -> Any:
        if self._model is not None:
            return self._model

        from faster_whisper import WhisperModel

        # Attempt 1: Preferred device (e.g. CUDA on RTX 5050 if cuBLAS DLLs present)
        if self.preferred_device in ("cuda", "auto"):
            try:
                log.info(f"Probing WhisperModel '{self.model_size}' on CUDA ({self.compute_type})...")
                candidate = WhisperModel(
                    self.model_size,
                    device="cuda",
                    compute_type=self.compute_type,
                )
                # Test probe inference to verify required DLLs (cublas64_12.dll, etc.) are present
                dummy_probe = np.zeros(1600, dtype=np.float32)
                list(candidate.transcribe(dummy_probe, language="en")[0])
                self._model = candidate
                self.actual_device = "cuda"
                self.actual_compute_type = self.compute_type
                log.info(f"WhisperModel '{self.model_size}' verified and active on CUDA!")
                return self._model
            except Exception as cuda_err:
                log.warning(f"CUDA initialization/probe failed ({cuda_err}), switching cleanly to CPU int8...")

        # Attempt 2: High-speed CPU with int8 quantization and multi-threading
        try:
            log.info(f"Loading WhisperModel '{self.model_size}' on CPU (int8, threads={self.cpu_threads})...")
            self._model = WhisperModel(
                self.model_size,
                device="cpu",
                compute_type="int8",
                cpu_threads=self.cpu_threads,
            )
            self.actual_device = "cpu"
            self.actual_compute_type = "int8"
            log.info(f"WhisperModel '{self.model_size}' active on CPU (int8)!")
            return self._model
        except Exception as cpu_err:
            log.error(f"Failed to load WhisperModel on CPU: {cpu_err}")
            raise RuntimeError(f"Could not initialize ASR model: {cpu_err}")

    def transcribe(
        self,
        audio: np.ndarray,
        sample_rate: int = 16000,
        language: Optional[str] = None,
        initial_prompt: Optional[str] = None,
    ) -> ASRResult:
        """Transcribes raw audio array into high-precision acoustic text with confidence metrics."""
        t_start = time.perf_counter()

        # 1. Acoustic Quality Validation & Preprocessing
        clean_audio, quality = self.audio_proc.preprocess_audio(audio, source_sr=sample_rate)

        # Check for absolute silence
        if quality.is_silent or len(clean_audio) < int(0.25 * 16000):
            latency = (time.perf_counter() - t_start) * 1000.0
            return ASRResult(
                raw_transcript="",
                language="unknown",
                language_probability=0.0,
                confidence_score=0.0,
                duration_sec=quality.duration_sec,
                latency_ms=latency,
                quality_metrics=quality,
                is_speech=False,
            )

        # 2. Trim silence with VAD
        trimmed = self.audio_proc.trim_silence_with_vad(clean_audio, sr=16000)

        # 3. Load model if needed
        model = self._ensure_model_loaded()

        # 4. Prepare Vocabulary Conditioning Prompt
        prompt = initial_prompt or vocabulary_manager.get_whisper_initial_prompt()

        # 5. Execute ASR Inference
        try:
            # Note: task="transcribe" guarantees Hindi is NEVER translated into English!
            trimmed_f32 = trimmed.astype(np.float32)
            segments, info = model.transcribe(
                trimmed_f32,
                task="transcribe",
                language=language,  # None = auto-detect (hi, en, etc.)
                initial_prompt=prompt,
                beam_size=5,
                best_of=5,
                temperature=0.0,
                compression_ratio_threshold=2.4,
                vad_filter=True,
                vad_parameters=dict(min_silence_duration_ms=600),
                word_timestamps=True,
                condition_on_previous_text=False,
            )

            segment_list = list(segments)

            # If auto-detection was tricked by Hinglish code-switching into selecting an obscure language (e.g. Latin 'la')
            if language is None and getattr(info, "language", "") not in ("hi", "en", "ur"):
                log.info(f"Auto-detected language '{getattr(info, 'language', '')}' outside ERA target domain (hi/en); re-transcribing with language='hi'...")
                segments_hi, info_hi = model.transcribe(
                    trimmed_f32,
                    task="transcribe",
                    language="hi",
                    initial_prompt=prompt,
                    beam_size=5,
                    best_of=5,
                    temperature=0.0,
                    compression_ratio_threshold=2.4,
                    vad_filter=True,
                    vad_parameters=dict(min_silence_duration_ms=600),
                    word_timestamps=True,
                    condition_on_previous_text=False,
                )
                segment_list = list(segments_hi)
                info = info_hi

            latency = (time.perf_counter() - t_start) * 1000.0

            if not segment_list:
                return ASRResult(
                    raw_transcript="",
                    language=info.language or "unknown",
                    language_probability=float(info.language_probability or 0.0),
                    confidence_score=0.0,
                    duration_sec=quality.duration_sec,
                    latency_ms=latency,
                    quality_metrics=quality,
                    is_speech=False,
                )

            # 6. Aggregate segments, tokens, and compute calibrated confidence
            raw_text_parts: List[str] = []
            words_out: List[TranscriptionWord] = []
            total_logprob = 0.0
            total_words = 0
            speech_no_speech_probs: List[float] = []

            for seg in segment_list:
                text_clean = seg.text.strip()
                # Discard phantom hallucination segments on trailing silence/breathing
                if seg.no_speech_prob > 0.55 and seg.avg_logprob < -1.2:
                    continue
                if text_clean:
                    raw_text_parts.append(text_clean)
                    speech_no_speech_probs.append(seg.no_speech_prob)
                    n_words = max(1, len(seg.words or []))
                    total_logprob += seg.avg_logprob * n_words
                    total_words += n_words

                if seg.words:
                    for w in seg.words:
                        words_out.append(
                            TranscriptionWord(
                                word=w.word.strip(),
                                start=float(w.start),
                                end=float(w.end),
                                probability=float(w.probability),
                            )
                        )

            full_transcript = " ".join(raw_text_parts).strip()
            # Clean known Whisper hallucination artifacts on trailing silence (URLs, orphan domain tags, orphan 'You')
            import re
            full_transcript = re.sub(r"https?://\S+|www\.\S+|\b[a-zA-Z0-9_-]+\.(?:com|org|info|net|edu|gov|co)\b", "", full_transcript, flags=re.IGNORECASE).strip()
            full_transcript = re.sub(r"[,.]?\s*\b(?:you|thank\s*you|subtitles?|amara\.org)\b[.?!]*$", "", full_transcript, flags=re.IGNORECASE).strip()
            # Clean repetitive loops and stutters (e.g. single-syllable looping like भुभुभु)
            full_transcript = re.sub(r"(.{1,3})\1{3,}", "", full_transcript)
            # Strip trailing hallucinated filler syllables (e.g. 'भी', 'है', 'हूँ', etc.)
            full_transcript = re.sub(r"[\s,।.]+(?:भी|है|हूँ|yes|you)[\s,।.]*$", "", full_transcript, flags=re.IGNORECASE).strip(" ,।.")
            # Token cycle deduplication (detects phrases repeated in cycles of length 1 to 6)
            tokens = [t.strip(" ,।.") for t in full_transcript.split() if t.strip(" ,।.")]
            n_tok = len(tokens)
            for L in range(1, n_tok // 2 + 1):
                is_repeat = True
                first_block = [t.lower() for t in tokens[:L]]
                for i in range(L, n_tok, L):
                    block = [t.lower() for t in tokens[i : i + L]]
                    if block != first_block[: len(block)]:
                        is_repeat = False
                        break
                if is_repeat and (n_tok // L) >= 2:
                    tokens = tokens[:L]
                    break
            full_transcript = " ".join(tokens).strip(" ,।.")

            # Calibrated Confidence Score:
            # Map avg_logprob (typically -0.05 to -1.5) to probability [0, 1]
            if total_words > 0 and raw_text_parts:
                avg_lp = total_logprob / total_words
                exp_lp = math.exp(max(-5.0, avg_lp))
                mean_no_speech = float(np.mean(speech_no_speech_probs)) if speech_no_speech_probs else 0.0
                calibrated_confidence = float(np.clip(exp_lp * (1.0 - mean_no_speech), 0.0, 1.0))
                is_speech = calibrated_confidence >= 0.25
            else:
                calibrated_confidence = 0.0
                is_speech = False

            return ASRResult(
                raw_transcript=full_transcript,
                language=info.language,
                language_probability=float(info.language_probability),
                confidence_score=calibrated_confidence,
                duration_sec=quality.duration_sec,
                latency_ms=latency,
                words=words_out,
                quality_metrics=quality,
                is_speech=is_speech,
            )

        except Exception as e:
            latency = (time.perf_counter() - t_start) * 1000.0
            log.error(f"ASR transcription error: {e}")
            return ASRResult(
                raw_transcript="",
                language="unknown",
                language_probability=0.0,
                confidence_score=0.0,
                duration_sec=quality.duration_sec,
                latency_ms=latency,
                quality_metrics=quality,
                is_speech=False,
                error_message=str(e),
            )


# Global singleton instance
asr_engine = ASREngine(model_size="base")
