"""Central configuration for era_voice_identity."""
from __future__ import annotations

import os
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional


def default_data_dir() -> Path:
    override = os.environ.get("ERA_VOICE_DATA_DIR")
    if override:
        return Path(override)
    appdata = os.environ.get("APPDATA")  # Windows: C:\Users\<you>\AppData\Roaming
    root = Path(appdata) if appdata else Path.home() / ".era"
    return root / "ERA" / "voice_identity"


class Status:
    OWNER = "OWNER"
    UNKNOWN = "UNKNOWN"
    INSUFFICIENT_AUDIO = "INSUFFICIENT_AUDIO"
    MODEL_ERROR = "MODEL_ERROR"
    NO_SPEECH = "NO_SPEECH"


@dataclass
class Config:
    # ---- model -------------------------------------------------------------
    model_source: str = "speechbrain/spkrec-ecapa-voxceleb"
    data_dir: Path = None            # profile + model cache; default: %APPDATA%/ERA/voice_identity
    device: str = "auto"             # "auto" | "cpu" | "cuda"
    num_threads: int = 0             # 0 = leave torch default
    sample_rate: int = 16000

    # ---- voice activity detection -----------------------------------------
    frame_ms: int = 30
    vad_margin_db: float = 9.0       # speech must exceed noise floor by this much
    vad_abs_floor_db: float = -60.0  # never call anything quieter than this speech
    speech_band_ratio_min: float = 0.60   # share of energy in 100-4000 Hz
    gap_fill_ms: int = 200           # bridge short pauses inside speech
    min_speech_run_ms: int = 90      # drop clicks shorter than this

    # ---- verification ------------------------------------------------------
    no_speech_s: float = 0.30        # below this much speech -> NO_SPEECH
    min_speech_s: float = 1.5        # below this -> INSUFFICIENT_AUDIO
    target_speech_s: float = 2.5     # live monitoring waits for ~2-3 s of speech
    window_s: float = 3.5            # audio window handed to the model while monitoring
    max_verify_speech_s: float = 4.0 # cap model input length (latency / memory)
    threshold: float = 0.65          # default cosine accept threshold (calibrated for ECAPA)
    min_threshold: float = 0.25      # calibration can never go below this
    strict_margin: float = 0.10      # extra margin demanded for sensitive operations
    confidence_scale: float = 0.06   # width of the score->confidence logistic

    # ---- enrollment --------------------------------------------------------
    enroll_min_samples: int = 3
    enroll_min_speech_s: float = 4.0
    enroll_min_snr_db: float = 10.0
    enroll_max_clipping: float = 0.02
    enroll_consistency_min: float = 0.35   # mean cosine to other samples; lower => other speaker?
    enroll_window_s: float = 3.0

    # ---- live monitoring ---------------------------------------------------
    hangover_ms: int = 600           # silence that ends an utterance
    reverify_speech_s: float = 2.0   # new speech needed before re-running the model
    min_report_speech_s: float = 0.6 # shorter bursts are ignored (clicks, coughs)
    mic_device: Optional[int] = None
    mic_stall_s: float = 3.0         # no frames for this long => restart the stream

    # ---- security ----------------------------------------------------------
    owner_result_ttl_s: float = 10.0 # how long an OWNER result stays valid for commands
    replay_min_age_s: float = 15.0
    replay_cosine: float = 0.995

    def __post_init__(self):
        if self.data_dir is None:
            self.data_dir = default_data_dir()
        self.data_dir = Path(self.data_dir)

    @property
    def model_dir(self) -> Path:
        return self.data_dir / "model"

    def as_dict(self) -> dict:
        d = asdict(self)
        d["data_dir"] = str(self.data_dir)
        return d
