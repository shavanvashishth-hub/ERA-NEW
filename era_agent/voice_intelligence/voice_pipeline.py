"""ERA Unified Voice Pipeline Orchestrator.

Implements the end-to-end 11-stage voice recognition and command execution pipeline:
Audio -> Quality Check -> VAD -> STT -> Transcript -> Confidence -> Intent ->
Validation -> Authorization -> Execution -> Voice Feedback.
"""
from __future__ import annotations

import logging
import time
from dataclasses import asdict, dataclass
from typing import Any, Dict, Optional, Union

import numpy as np

from .asr_engine import asr_engine, ASRResult
from .audio_processor import AudioProcessor
from .command_validator import command_validator, ValidationVerdict
from .intent_analyzer import intent_analyzer, IntentCandidate
from .pipeline_audit import pipeline_auditor, PipelineAuditRecord
from .vocabulary import vocabulary_manager

log = logging.getLogger("era.pipeline")


@dataclass
class VoicePipelineOutput:
    success: bool
    status: str  # "EXECUTED", "REJECTED_LOW_CONFIDENCE", "INCOMPLETE_PARAMETERS", "PENDING_CONFIRMATION", "CONVERSATIONAL", "FAILED"
    spoken_text: str
    asr_language: str
    asr_confidence: float
    interpreted_intent: str
    target_command: Optional[str]
    command_params: Dict[str, Any]
    voice_response_text: str
    clarification_prompt: Optional[str]
    execution_result: Optional[Dict[str, Any]]
    total_latency_ms: float
    audit_id: str


class VoicePipeline:
    """End-to-end orchestrator for speech recognition, intent understanding, and command dispatch."""

    def __init__(self) -> None:
        self.audio_proc = AudioProcessor()
        self.asr = asr_engine
        self.intent = intent_analyzer
        self.validator = command_validator
        self.auditor = pipeline_auditor
        self.vocab = vocabulary_manager

    def process_transcript(
        self,
        transcript: str,
        is_user_confirmed: bool = False,
        executor_func: Optional[Any] = None,
    ) -> VoicePipelineOutput:
        """Processes pre-existing raw transcript through intent analysis, validation, and execution."""
        from .asr_engine import ASRResult
        asr_res = ASRResult(
            raw_transcript=transcript,
            language="hi" if any("\u0900" <= c <= "\u097f" for c in transcript) else "en",
            language_probability=1.0,
            confidence_score=0.95,
            duration_sec=0.0,
            latency_ms=0.0,
        )
        return self._process_stages(asr_res, is_user_confirmed=is_user_confirmed, executor_func=executor_func, t_start=time.perf_counter())

    def process_audio(
        self,
        audio_input: Union[np.ndarray, bytes, str],
        sample_rate: int = 16000,
        is_user_confirmed: bool = False,
        executor_func: Optional[Any] = None,
    ) -> VoicePipelineOutput:
        """Processes an audio buffer or base64 string through the complete ERA pipeline."""
        t_pipeline_start = time.perf_counter()

        # 1. Convert input to float32 numpy array
        if isinstance(audio_input, str):
            audio = AudioProcessor.base64_to_float32(audio_input)
        elif isinstance(audio_input, (bytes, bytearray)):
            audio = AudioProcessor.pcm16_to_float32(bytes(audio_input))
        else:
            audio = np.asarray(audio_input, dtype=np.float32)

        # 2. Stage 1 & 2: ASR (Audio quality validation, VAD, Whisper transcription)
        asr_res: ASRResult = self.asr.transcribe(audio, sample_rate=sample_rate)

        return self._process_stages(
            asr_res,
            is_user_confirmed=is_user_confirmed,
            executor_func=executor_func,
            t_start=t_pipeline_start,
        )

    def _process_stages(
        self,
        asr_res: Any,
        is_user_confirmed: bool = False,
        executor_func: Optional[Any] = None,
        t_start: float = 0.0,
    ) -> VoicePipelineOutput:
        # 3. Stage 3: Intent Analysis
        intent: IntentCandidate = self.intent.analyze(asr_res.raw_transcript)

        # 4. Stage 4: Command Validation & Safety Gate
        verdict: ValidationVerdict = self.validator.validate(
            asr_res, intent, is_user_confirmed=is_user_confirmed
        )

        # 5. Stage 5: Execution Authorization and Local Agent Dispatch
        exec_success: Optional[bool] = None
        exec_message: Optional[str] = None
        exec_data: Optional[Dict[str, Any]] = None
        voice_response = ""
        t_exec_start = time.perf_counter()

        if verdict.is_executable and verdict.status == "AUTHORIZED":
            cmd = verdict.target_command
            params = verdict.command_params or {}
            try:
                if executor_func:
                    res = executor_func(cmd, **params)
                else:
                    res = self._execute_local_agent_command(cmd, params)

                exec_success = getattr(res, "success", True) if res else True
                exec_message = getattr(res, "message", "Executed successfully") if res else "Executed"
                exec_data = getattr(res, "data", None) if res else None

                # Generate polite Hindi/English voice response
                voice_response = self._build_voice_response(cmd, params, exec_success, exec_message)
            except Exception as e:
                exec_success = False
                exec_message = str(e)
                voice_response = f"Boss, command execute karne me dikkat aayi: {e}"

        elif verdict.status == "PENDING_CONFIRMATION":
            voice_response = verdict.clarification_prompt or "Boss, kya aap sach me ye action execute karna chahte hain?"

        elif verdict.status == "INCOMPLETE_PARAMETERS":
            voice_response = verdict.clarification_prompt or "Boss, command poori nahi hai. Kripya detail bataiye."

        elif verdict.status == "REJECTED_LOW_CONFIDENCE":
            voice_response = verdict.clarification_prompt or "Boss, aapki aawaz theek se nahi suni. Kya aap dobara bol sakte hain?"

        elif verdict.status == "CONVERSATIONAL":
            voice_response = ""  # Handled by conversational LLM / Live session

        exec_latency = (time.perf_counter() - t_exec_start) * 1000.0
        total_latency = (time.perf_counter() - (t_start or time.perf_counter())) * 1000.0

        # 6. Stage 6: Audit Logging
        audit_record = self.auditor.record_turn(
            raw_transcript=asr_res.raw_transcript,
            asr_language=asr_res.language,
            asr_confidence=asr_res.confidence_score,
            audio_duration_sec=asr_res.duration_sec,
            audio_quality_status=asr_res.quality_metrics.status_summary if asr_res.quality_metrics else "UNKNOWN",
            interpreted_intent=intent.intent_name,
            target_entity=intent.target_entity,
            intent_confidence=intent.confidence,
            is_sensitive=intent.is_sensitive,
            intended_command=verdict.target_command,
            command_parameters=verdict.command_params or {},
            is_authorized=(verdict.status == "AUTHORIZED"),
            authorization_status=verdict.status,
            authorization_reason=verdict.reason,
            clarification_prompt=verdict.clarification_prompt,
            execution_success=exec_success,
            execution_message=exec_message,
            execution_latency_ms=exec_latency,
            total_pipeline_latency_ms=total_latency,
        )

        return VoicePipelineOutput(
            success=(exec_success is True or verdict.status in ("PENDING_CONFIRMATION", "CONVERSATIONAL")),
            status=verdict.status if exec_success is None else ("EXECUTED" if exec_success else "FAILED"),
            spoken_text=asr_res.raw_transcript,
            asr_language=asr_res.language,
            asr_confidence=asr_res.confidence_score,
            interpreted_intent=intent.intent_name,
            target_command=verdict.target_command,
            command_params=verdict.command_params or {},
            voice_response_text=voice_response,
            clarification_prompt=verdict.clarification_prompt,
            execution_result={"success": exec_success, "message": exec_message, "data": exec_data} if exec_success is not None else None,
            total_latency_ms=total_latency,
            audit_id=audit_record.audit_id,
        )

    def _execute_local_agent_command(self, cmd_name: str, params: Dict[str, Any]) -> Any:
        """Executes the command on the Python Local Agent registry."""
        try:
            from commands import registry
            return registry.execute(cmd_name, **params)
        except ImportError:
            try:
                from era_agent.commands import registry
                return registry.execute(cmd_name, **params)
            except Exception as e:
                log.error(f"Failed to import command registry: {e}")
                return None

    def _build_voice_response(
        self,
        cmd: str,
        params: Dict[str, Any],
        success: bool,
        message: Optional[str] = None,
    ) -> str:
        """Generates polite, natural JARVIS-style Hindi/English feedback."""
        if not success:
            return f"Boss, {message or 'execution failed'}."

        if cmd == "open_app":
            app = params.get("app_name", "application")
            return f"Ji boss! Maine {app} open kar diya hai."

        elif cmd == "close_app":
            app = params.get("app_name", "application")
            return f"Ji boss! Maine {app} band kar diya hai."

        elif cmd == "close_browser":
            return "Ji boss! Browser band kar diya hai."

        elif cmd == "open_file_explorer":
            path_val = params.get("path", "")
            if path_val:
                return f"Ji boss! Maine {path_val} folder open kar diya hai."
            return "Ji boss! File Explorer open kar diya hai."

        elif cmd == "set_audio_volume":
            lvl = params.get("level", 50)
            return f"Ji boss! Volume {lvl} percent par set kar diya hai."

        elif cmd == "adjust_audio_volume":
            delta = params.get("delta", 10)
            action = "badha" if delta > 0 else "kam kar"
            return f"Ji boss! Volume {action} diya hai."

        elif cmd == "toggle_audio_mute":
            mute = params.get("mute", True)
            return "Ji boss! Audio mute kar diya hai." if mute else "Ji boss! Audio unmute kar diya hai."

        elif cmd == "set_display_brightness":
            lvl = params.get("level", 50)
            return f"Ji boss! Screen brightness {lvl} percent par set kar diya hai."

        elif cmd == "adjust_display_brightness":
            delta = params.get("delta", 15)
            action = "badha" if delta > 0 else "kam kar"
            return f"Ji boss! Screen brightness {action} di hai."

        elif cmd == "lock_pc":
            return "Ji boss! Computer lock kar diya hai."

        elif cmd == "cancel_shutdown":
            return "Ji boss! PC shutdown successfully cancel kar diya gaya hai."

        elif cmd == "split_screen":
            left = params.get("left_app", "window")
            right = params.get("right_app", "window")
            return f"Ji boss! Screen split karke left side {left} aur right side {right} set kar diya hai."

        elif cmd == "snap_window":
            app = params.get("app_name", "window")
            pos = params.get("position", "screen")
            return f"Ji boss! {app} ko {pos} screen par set kar diya hai."

        elif cmd == "set_keyboard_backlight":
            lvl = params.get("level", 50)
            return f"Ji boss! Keyboard backlight {lvl} percent par set kar di hai."

        elif cmd == "adjust_keyboard_backlight":
            return "Ji boss! Keyboard backlight adjust kar di hai."

        elif cmd == "start_gesture_control":
            return "Ji boss! Hand gesture recognition chalu kar diya hai. Ab camera ke samne ungliyon ko door karke brightness aur palm ghuma kar volume control kar sakte hain!"

        elif cmd == "stop_gesture_control":
            return "Ji boss! Hand gesture recognition band kar diya hai."

        elif cmd == "get_gesture_status":
            return "Ji boss! Hand gesture recognition active hai."

        return f"Ji boss! {cmd} execute kar diya hai."


# Global singleton instance
voice_pipeline = VoicePipeline()
