"""ERA Command Validation and Safety Execution Gate.

Enforces strict accuracy thresholds, prevents execution of unclear or
incomplete speech, detects ambiguities, and mandates user confirmation
for sensitive actions (e.g., shutdown, restart, file deletion).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, Optional

from .asr_engine import ASRResult
from .intent_analyzer import IntentCandidate

log = logging.getLogger("era.validator")


@dataclass
class ValidationVerdict:
    is_executable: bool
    status: str  # "AUTHORIZED", "REJECTED_LOW_CONFIDENCE", "INCOMPLETE_PARAMETERS", "PENDING_CONFIRMATION", "AMBIGUOUS", "CONVERSATIONAL"
    reason: str
    clarification_prompt: Optional[str] = None
    target_command: Optional[str] = None
    command_params: Dict[str, Any] = None


class CommandValidator:
    """Evaluates combined ASR quality and semantic intent to authorize execution."""

    def __init__(
        self,
        min_asr_confidence: float = 0.40,
        min_intent_confidence: float = 0.65,
    ) -> None:
        self.min_asr_confidence = min_asr_confidence
        self.min_intent_confidence = min_intent_confidence

    def validate(
        self,
        asr_result: ASRResult,
        intent: IntentCandidate,
        is_user_confirmed: bool = False,
    ) -> ValidationVerdict:
        """Validates whether a candidate command should be executed on the physical OS."""
        # 1. Non-speech or empty transcript
        if not asr_result.is_speech or not asr_result.raw_transcript.strip():
            return ValidationVerdict(
                is_executable=False,
                status="REJECTED_LOW_CONFIDENCE",
                reason="No clear speech detected in audio.",
                clarification_prompt="Boss, kuch aawaz sunai nahi di. Kripya dobara bolein.",
            )

        # 2. Acoustic Confidence Check
        # If ASR confidence is too low or audio quality is low SNR, reject execution
        if asr_result.confidence_score < self.min_asr_confidence:
            return ValidationVerdict(
                is_executable=False,
                status="REJECTED_LOW_CONFIDENCE",
                reason=f"ASR confidence {asr_result.confidence_score:.2f} below threshold {self.min_asr_confidence:.2f}.",
                clarification_prompt="Boss, aapki aawaz theek se nahi suni. Kya aap dobara bol sakte hain?",
            )

        # 3. Incomplete Command Check (Never invent missing parameters!)
        if not intent.is_complete:
            prompt = intent.confirmation_prompt or f"Boss, {intent.missing_parameter or 'detail'} bataiye?"
            return ValidationVerdict(
                is_executable=False,
                status="INCOMPLETE_PARAMETERS",
                reason=f"Command is incomplete, missing '{intent.missing_parameter}'.",
                clarification_prompt=prompt,
            )

        # 4. Conversational Chat or Explanatory Query
        if intent.intent_name in ("conversational_chat", "inspect_screen"):
            return ValidationVerdict(
                is_executable=True,
                status="CONVERSATIONAL",
                reason="Conversational dialogue or perception query (handled by response model).",
                target_command=intent.intent_name,
                command_params={"transcript": asr_result.raw_transcript},
            )

        # 5. Sensitive Command Safety Gate (Requires explicit confirmation)
        if intent.requires_confirmation and not is_user_confirmed:
            prompt = intent.confirmation_prompt or f"Boss, kya aap sach me '{intent.intent_name}' execute karna chahte hain?"
            return ValidationVerdict(
                is_executable=False,
                status="PENDING_CONFIRMATION",
                reason="Sensitive operation requires explicit user authorization.",
                clarification_prompt=prompt,
                target_command=intent.intent_name,
                command_params=intent.parameters,
            )

        # 6. Intent Confidence Threshold
        if intent.confidence < self.min_intent_confidence:
            return ValidationVerdict(
                is_executable=False,
                status="AMBIGUOUS",
                reason=f"Intent confidence {intent.confidence:.2f} is ambiguous.",
                clarification_prompt="Boss, kya aap dobara clear shabdon me bata sakte hain?",
            )

        # 7. Map to Executable Python Agent Command Name & Parameters
        cmd_name, params = self._map_intent_to_agent_command(intent)

        return ValidationVerdict(
            is_executable=True,
            status="AUTHORIZED",
            reason=f"Command '{cmd_name}' verified with ASR confidence {asr_result.confidence_score:.2f} and intent confidence {intent.confidence:.2f}.",
            target_command=cmd_name,
            command_params=params,
        )

    def _map_intent_to_agent_command(self, intent: IntentCandidate) -> tuple[str, Dict[str, Any]]:
        """Maps semantic intent representation to Python Agent registry commands."""
        name = intent.intent_name
        p = dict(intent.parameters)

        if name == "open_app":
            return "open_app", {"app_name": p.get("app_name", intent.target_entity or "")}

        elif name == "close_app":
            return "close_app", {"app_name": p.get("app_name", intent.target_entity or "")}

        elif name == "close_browser":
            return "close_browser", {}

        elif name == "open_folder":
            return "open_file_explorer", {"path": p.get("folder_name", "")}

        elif name == "set_volume":
            return "set_audio_volume", {"level": p.get("level", 50)}

        elif name == "adjust_volume":
            return "adjust_audio_volume", {"delta": p.get("delta", 10)}

        elif name == "set_volume_mute":
            return "toggle_audio_mute", {"mute": p.get("mute", True)}

        elif name == "set_brightness":
            return "set_display_brightness", {"level": p.get("level", 50)}

        elif name == "adjust_brightness":
            return "adjust_display_brightness", {"delta": p.get("delta", 15)}

        elif name == "lock_pc":
            return "lock_pc", {}

        elif name == "take_screenshot":
            return "take_screenshot", {}

        elif name == "restart_pc":
            return "restart_pc", {"confirm": "yes", "delay_seconds": p.get("delay_seconds", 30)}

        elif name == "shutdown_pc":
            return "shutdown_pc", {"confirm": "yes", "delay_seconds": p.get("delay_seconds", 30)}

        elif name == "cancel_shutdown":
            return "cancel_shutdown", {}

        elif name == "split_screen":
            return "split_screen", {
                "left_app": p.get("left_app"),
                "right_app": p.get("right_app"),
                "middle_app": p.get("middle_app"),
            }

        elif name == "snap_window":
            return "snap_window", {
                "app_name": p.get("app_name", "active"),
                "position": p.get("position", "left"),
            }

        elif name == "set_keyboard_backlight":
            return "set_keyboard_backlight", {"level": p.get("level", 50)}

        elif name == "adjust_keyboard_backlight":
            return "adjust_keyboard_backlight", {"delta": p.get("delta", 25)}

        elif name == "media_control":
            return "media_control", {"action": p.get("action", "pause")}

        return name, p


# Global singleton instance
command_validator = CommandValidator()
