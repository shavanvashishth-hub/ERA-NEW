import os

if "HF_ENDPOINT" not in os.environ:
    os.environ["HF_ENDPOINT"] = "https://hf-mirror.net"
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

from .config import Config, Status
from .engine import (VoiceIdentityEngine, initialize, enroll_owner, verify_speaker,
                     start_monitoring, stop_monitoring, get_status, reset_profile)
from .security import SecurityGate, Sensitivity, ChallengeLiveness, ReplayGuard

__all__ = ["Config", "Status", "VoiceIdentityEngine", "initialize", "enroll_owner",
           "verify_speaker", "start_monitoring", "stop_monitoring", "get_status",
           "reset_profile", "SecurityGate", "Sensitivity", "ChallengeLiveness", "ReplayGuard"]
