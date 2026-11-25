"""ERA Voice Command Pipeline Audit and Traceability Logger.

Maintains immutable structured audit records across all 5 mandatory stages:
1. What the user actually said according to ASR (raw transcript + confidence + timings).
2. What ERA interpreted (intent name + target entity + confidence).
3. What command ERA intends to execute (command name + payload).
4. Whether the command was authorized (verdict + authorization reason).
5. What actually happened (execution result + OS message + latency).
"""
from __future__ import annotations

import collections
import json
import logging
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

log = logging.getLogger("era.audit")


@dataclass
class PipelineAuditRecord:
    audit_id: str
    timestamp_epoch: float
    timestamp_iso: str

    # Stage 1: Raw ASR
    raw_transcript: str
    asr_language: str
    asr_confidence: float
    audio_duration_sec: float
    audio_quality_status: str

    # Stage 2: Intent Interpretation
    interpreted_intent: str
    target_entity: Optional[str]
    intent_confidence: float
    is_sensitive: bool

    # Stage 3: Intended Command
    intended_command: Optional[str]
    command_parameters: Dict[str, Any] = field(default_factory=dict)

    # Stage 4: Authorization
    is_authorized: bool = False
    authorization_status: str = "PENDING"  # "AUTHORIZED", "REJECTED_LOW_CONFIDENCE", "INCOMPLETE_PARAMETERS", "PENDING_CONFIRMATION"
    authorization_reason: str = ""
    clarification_prompt: Optional[str] = None

    # Stage 5: Execution Result
    execution_success: Optional[bool] = None
    execution_message: Optional[str] = None
    execution_latency_ms: float = 0.0
    total_pipeline_latency_ms: float = 0.0


class PipelineAuditor:
    """In-memory and file-backed audit store for voice command traces."""

    def __init__(self, log_path: Optional[Path] = None, max_history: int = 200) -> None:
        self.log_path = log_path or Path(__file__).parent / "voice_audit_log.jsonl"
        self._history: collections.deque[PipelineAuditRecord] = collections.deque(maxlen=max_history)

    def record_turn(
        self,
        raw_transcript: str,
        asr_language: str,
        asr_confidence: float,
        audio_duration_sec: float,
        audio_quality_status: str,
        interpreted_intent: str,
        target_entity: Optional[str],
        intent_confidence: float,
        is_sensitive: bool,
        intended_command: Optional[str],
        command_parameters: Dict[str, Any],
        is_authorized: bool,
        authorization_status: str,
        authorization_reason: str,
        clarification_prompt: Optional[str],
        execution_success: Optional[bool],
        execution_message: Optional[str],
        execution_latency_ms: float,
        total_pipeline_latency_ms: float,
    ) -> PipelineAuditRecord:
        """Appends and persists a complete 5-stage pipeline audit record."""
        now = time.time()
        record = PipelineAuditRecord(
            audit_id=f"voice_{int(now * 1000)}_{len(self._history)}",
            timestamp_epoch=now,
            timestamp_iso=time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(now)),
            raw_transcript=raw_transcript,
            asr_language=asr_language,
            asr_confidence=round(asr_confidence, 4),
            audio_duration_sec=round(audio_duration_sec, 3),
            audio_quality_status=audio_quality_status,
            interpreted_intent=interpreted_intent,
            target_entity=target_entity,
            intent_confidence=round(intent_confidence, 4),
            is_sensitive=is_sensitive,
            intended_command=intended_command,
            command_parameters=command_parameters,
            is_authorized=is_authorized,
            authorization_status=authorization_status,
            authorization_reason=authorization_reason,
            clarification_prompt=clarification_prompt,
            execution_success=execution_success,
            execution_message=execution_message,
            execution_latency_ms=round(execution_latency_ms, 2),
            total_pipeline_latency_ms=round(total_pipeline_latency_ms, 2),
        )

        self._history.append(record)

        # Write to JSONL
        try:
            with open(self.log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(asdict(record), ensure_ascii=False) + "\n")
        except Exception as e:
            log.warning(f"Failed to append to audit log {self.log_path}: {e}")

        return record

    def get_recent_records(self, limit: int = 50) -> List[Dict[str, Any]]:
        return [asdict(r) for r in list(self._history)[-limit:]]


# Global singleton instance
pipeline_auditor = PipelineAuditor()
