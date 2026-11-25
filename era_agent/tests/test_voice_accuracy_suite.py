"""ERA Comprehensive Real-World Voice Recognition & Command Accuracy Test Suite.

Automated benchmarking framework that measures:
- Word Error Rate (WER)
- Character Error Rate (CER)
- Command Recognition Accuracy
- Intent Classification Accuracy
- False Command Execution Rate
- End-to-End Latency

Evaluates:
A. Hindi commands (Devanagari & Romanized)
B. Hinglish commands
C. English commands
D. Mixed Hindi-English commands
E. Short commands
F. Long commands
G. Fast speech
H. Slow speech
I. Background noise / Low SNR
J. Gain & Distance variations
K. Similar-sounding words (screen vs sleep, chrome vs home)
L. Application names
M. Numerical & folder parameters
N. Safety gate & confirmation enforcement
"""
from __future__ import annotations

import asyncio
import difflib
import math
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

# Ensure parent directory is in sys.path
sys.path.insert(0, str(Path(__file__).parent.parent))

from voice_intelligence import (
    AudioProcessor,
    ASREngine,
    ASRResult,
    IntentAnalyzer,
    IntentCandidate,
    CommandValidator,
    ValidationVerdict,
    VocabularyManager,
    VoicePipeline,
    voice_pipeline,
)


@dataclass
class TestCase:
    test_id: str
    category: str
    spoken_phrase: str
    expected_language: str
    expected_intent: str
    expected_command: Optional[str]
    expected_status: str  # "AUTHORIZED", "PENDING_CONFIRMATION", "INCOMPLETE_PARAMETERS", "REJECTED_LOW_CONFIDENCE", "CONVERSATIONAL"
    expected_params: Dict[str, Any]
    voice_name: Optional[str] = None  # e.g. "hi-IN-SwaraNeural", "en-IN-NeerjaNeural"
    noise_snr_db: Optional[float] = None
    rate_adjust: str = "+0%"
    volume_adjust: str = "+0%"


# Standardized Test Dataset
BENCHMARK_DATASET: List[TestCase] = [
    # Category A: Hindi Commands
    TestCase(
        test_id="A1_hi_notepad",
        category="A_Hindi",
        spoken_phrase="नोटपैड खोलो",
        expected_language="hi",
        expected_intent="open_app",
        expected_command="open_app",
        expected_status="AUTHORIZED",
        expected_params={"app_name": "notepad"},
        voice_name="hi-IN-SwaraNeural",
    ),
    TestCase(
        test_id="A2_hi_chrome_band",
        category="A_Hindi",
        spoken_phrase="अभी Chrome बंद करो",
        expected_language="hi",
        expected_intent="close_browser",
        expected_command="close_browser",
        expected_status="AUTHORIZED",
        expected_params={},
        voice_name="hi-IN-MadhurNeural",
    ),
    TestCase(
        test_id="A3_hi_brightness_up",
        category="A_Hindi",
        spoken_phrase="मेरी स्क्रीन की brightness बढ़ा दो",
        expected_language="hi",
        expected_intent="adjust_brightness",
        expected_command="adjust_display_brightness",
        expected_status="AUTHORIZED",
        expected_params={"delta": 15},
        voice_name="hi-IN-SwaraNeural",
    ),
    TestCase(
        test_id="A4_hi_volume_up",
        category="A_Hindi",
        spoken_phrase="आवाज़ बढ़ाओ",
        expected_language="hi",
        expected_intent="adjust_volume",
        expected_command="adjust_audio_volume",
        expected_status="AUTHORIZED",
        expected_params={"delta": 10},
        voice_name="hi-IN-SwaraNeural",
    ),

    # Category B: Hinglish Commands
    TestCase(
        test_id="B1_hinglish_chrome_open",
        category="B_Hinglish",
        spoken_phrase="Era Chrome open karo",
        expected_language="hi",
        expected_intent="open_app",
        expected_command="open_app",
        expected_status="AUTHORIZED",
        expected_params={"app_name": "chrome"},
        voice_name="hi-IN-MadhurNeural",
    ),
    TestCase(
        test_id="B2_hinglish_notepad_kholo",
        category="B_Hinglish",
        spoken_phrase="Notepad kholo",
        expected_language="hi",
        expected_intent="open_app",
        expected_command="open_app",
        expected_status="AUTHORIZED",
        expected_params={"app_name": "notepad"},
        voice_name="hi-IN-SwaraNeural",
    ),
    TestCase(
        test_id="B3_hinglish_volume_fifty",
        category="B_Hinglish",
        spoken_phrase="Mera volume fifty percent kar do",
        expected_language="hi",
        expected_intent="set_volume",
        expected_command="set_audio_volume",
        expected_status="AUTHORIZED",
        expected_params={"level": 50},
        voice_name="hi-IN-MadhurNeural",
    ),
    TestCase(
        test_id="B4_hinglish_brightness_kam",
        category="B_Hinglish",
        spoken_phrase="Screen brightness kam karo",
        expected_language="hi",
        expected_intent="adjust_brightness",
        expected_command="adjust_display_brightness",
        expected_status="AUTHORIZED",
        expected_params={"delta": -15},
        voice_name="hi-IN-SwaraNeural",
    ),
    TestCase(
        test_id="B5_hinglish_whatsapp_open",
        category="B_Hinglish",
        spoken_phrase="WhatsApp open karo",
        expected_language="hi",
        expected_intent="open_app",
        expected_command="open_app",
        expected_status="AUTHORIZED",
        expected_params={"app_name": "whatsapp"},
        voice_name="hi-IN-MadhurNeural",
    ),

    # Category C: English Commands
    TestCase(
        test_id="C1_en_open_chrome",
        category="C_English",
        spoken_phrase="Open Google Chrome",
        expected_language="en",
        expected_intent="open_app",
        expected_command="open_app",
        expected_status="AUTHORIZED",
        expected_params={"app_name": "chrome"},
        voice_name="en-IN-NeerjaNeural",
    ),
    TestCase(
        test_id="C2_en_close_browser",
        category="C_English",
        spoken_phrase="Close browser",
        expected_language="en",
        expected_intent="close_browser",
        expected_command="close_browser",
        expected_status="AUTHORIZED",
        expected_params={},
        voice_name="en-IN-NeerjaNeural",
    ),
    TestCase(
        test_id="C3_en_vscode",
        category="C_English",
        spoken_phrase="Open Visual Studio Code",
        expected_language="en",
        expected_intent="open_app",
        expected_command="open_app",
        expected_status="AUTHORIZED",
        expected_params={"app_name": "vscode"},
        voice_name="en-IN-NeerjaNeural",
    ),
    TestCase(
        test_id="C4_en_lock_pc",
        category="C_English",
        spoken_phrase="Lock screen",
        expected_language="en",
        expected_intent="lock_pc",
        expected_command="lock_pc",
        expected_status="AUTHORIZED",
        expected_params={},
        voice_name="en-IN-NeerjaNeural",
    ),

    # Category D: Mixed Hindi-English Commands
    TestCase(
        test_id="D1_mixed_downloads",
        category="D_Mixed",
        spoken_phrase="Mere downloads folder ko kholo",
        expected_language="hi",
        expected_intent="open_folder",
        expected_command="open_file_explorer",
        expected_status="AUTHORIZED",
        expected_params={"path": "downloads"},
        voice_name="hi-IN-MadhurNeural",
    ),

    # Category E: Short Commands
    TestCase(
        test_id="E1_short_notepad",
        category="E_Short",
        spoken_phrase="Notepad",
        expected_language="en",
        expected_intent="open_app",
        expected_command="open_app",
        expected_status="AUTHORIZED",
        expected_params={"app_name": "notepad"},
        voice_name="en-IN-NeerjaNeural",
    ),
    TestCase(
        test_id="E2_short_mute",
        category="E_Short",
        spoken_phrase="Mute karo",
        expected_language="hi",
        expected_intent="set_volume_mute",
        expected_command="toggle_audio_mute",
        expected_status="AUTHORIZED",
        expected_params={"mute": True},
        voice_name="hi-IN-SwaraNeural",
    ),

    # Category F: Long Conversational Commands
    TestCase(
        test_id="F1_long_command",
        category="F_Long",
        spoken_phrase="ERA please mere computer ka volume fifty percent kar do",
        expected_language="hi",
        expected_intent="set_volume",
        expected_command="set_audio_volume",
        expected_status="AUTHORIZED",
        expected_params={"level": 50},
        voice_name="hi-IN-MadhurNeural",
    ),

    # Category G & H: Fast and Slow Speech Variations
    TestCase(
        test_id="G1_fast_speech",
        category="G_Fast_Speed",
        spoken_phrase="Chrome open karo",
        expected_language="hi",
        expected_intent="open_app",
        expected_command="open_app",
        expected_status="AUTHORIZED",
        expected_params={"app_name": "chrome"},
        voice_name="hi-IN-SwaraNeural",
        rate_adjust="+35%",
    ),
    TestCase(
        test_id="H1_slow_speech",
        category="H_Slow_Speed",
        spoken_phrase="Notepad kholo",
        expected_language="hi",
        expected_intent="open_app",
        expected_command="open_app",
        expected_status="AUTHORIZED",
        expected_params={"app_name": "notepad"},
        voice_name="hi-IN-MadhurNeural",
        rate_adjust="-25%",
    ),

    # Category I & J: Noise and Distance Variations
    TestCase(
        test_id="I1_background_noise",
        category="I_Noise_Robustness",
        spoken_phrase="Open Calculator",
        expected_language="en",
        expected_intent="open_app",
        expected_command="open_app",
        expected_status="AUTHORIZED",
        expected_params={"app_name": "calculator"},
        voice_name="en-IN-NeerjaNeural",
        noise_snr_db=15.0,  # 15 dB SNR pink noise added
    ),
    TestCase(
        test_id="J1_mic_distance_quiet",
        category="J_Distance_Variation",
        spoken_phrase="WhatsApp open karo",
        expected_language="hi",
        expected_intent="open_app",
        expected_command="open_app",
        expected_status="AUTHORIZED",
        expected_params={"app_name": "whatsapp"},
        voice_name="hi-IN-SwaraNeural",
        volume_adjust="-35%",  # Distant microphone simulation
    ),

    # Category K: Similar-Sounding Words (Disambiguation)
    TestCase(
        test_id="K1_screen_not_sleep",
        category="K_Similar_Words",
        spoken_phrase="Screen brightness kam karo",
        expected_language="hi",
        expected_intent="adjust_brightness",  # MUST NOT trigger sleep_pc!
        expected_command="adjust_display_brightness",
        expected_status="AUTHORIZED",
        expected_params={"delta": -15},
        voice_name="hi-IN-SwaraNeural",
    ),

    # Category L: App Names
    TestCase(
        test_id="L1_spotify",
        category="L_App_Names",
        spoken_phrase="Spotify chalao",
        expected_language="hi",
        expected_intent="open_app",
        expected_command="open_app",
        expected_status="AUTHORIZED",
        expected_params={"app_name": "spotify"},
        voice_name="hi-IN-MadhurNeural",
    ),

    # Category M: Numbers & Folder Targets
    TestCase(
        test_id="M1_brightness_eighty",
        category="M_Numbers_Parameters",
        spoken_phrase="Brightness eighty percent set karo",
        expected_language="hi",
        expected_intent="set_brightness",
        expected_command="set_display_brightness",
        expected_status="AUTHORIZED",
        expected_params={"level": 80},
        voice_name="hi-IN-SwaraNeural",
    ),

    # Category N: Safety Gate & Sensitive Commands (MANDATORY CONFIRMATION)
    TestCase(
        test_id="N1_restart_requires_confirm",
        category="N_Safety_Gate",
        spoken_phrase="Laptop restart kar do",
        expected_language="hi",
        expected_intent="restart_pc",
        expected_command=None,  # MUST NOT execute without confirmation!
        expected_status="PENDING_CONFIRMATION",
        expected_params={},
        voice_name="hi-IN-MadhurNeural",
    ),
    TestCase(
        test_id="N2_shutdown_requires_confirm",
        category="N_Safety_Gate",
        spoken_phrase="Computer shutdown karo",
        expected_language="hi",
        expected_intent="shutdown_pc",
        expected_command=None,  # MUST NOT execute without confirmation!
        expected_status="PENDING_CONFIRMATION",
        expected_params={},
        voice_name="hi-IN-MadhurNeural",
    ),
    TestCase(
        test_id="N3_incomplete_open_kholo",
        category="N_Safety_Gate",
        spoken_phrase="kholo",
        expected_language="hi",
        expected_intent="open_app",
        expected_command=None,  # MUST NOT invent an app!
        expected_status="INCOMPLETE_OR_REJECTED",  # Both INCOMPLETE_PARAMETERS and REJECTED_LOW_CONFIDENCE are safe verdicts
        expected_params={},
        voice_name="hi-IN-SwaraNeural",
    ),
]


def clean_normalized_text(text: str) -> str:
    import re
    # Remove punctuation, extra spaces, lowercase
    t = text.lower()
    t = re.sub(r"[^\w\s]", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def compute_wer(reference: str, hypothesis: str) -> float:
    """Computes Word Error Rate between reference and hypothesis."""
    ref_words = clean_normalized_text(reference).split()
    hyp_words = clean_normalized_text(hypothesis).split()
    if not ref_words:
        return 0.0 if not hyp_words else 1.0

    d = np.zeros((len(ref_words) + 1, len(hyp_words) + 1), dtype=np.int32)
    for i in range(len(ref_words) + 1):
        d[i, 0] = i
    for j in range(len(hyp_words) + 1):
        d[0, j] = j

    for i in range(1, len(ref_words) + 1):
        for j in range(1, len(hyp_words) + 1):
            if ref_words[i - 1] == hyp_words[j - 1]:
                cost = 0
            else:
                cost = 1
            d[i, j] = min(
                d[i - 1, j] + 1,      # deletion
                d[i, j - 1] + 1,      # insertion
                d[i - 1, j - 1] + cost  # substitution
            )

    return float(d[len(ref_words), len(hyp_words)]) / float(len(ref_words))


def compute_cer(reference: str, hypothesis: str) -> float:
    """Computes Character Error Rate between reference and hypothesis."""
    ref_chars = list(reference.lower().replace(" ", ""))
    hyp_chars = list(hypothesis.lower().replace(" ", ""))
    if not ref_chars:
        return 0.0 if not hyp_chars else 1.0

    d = np.zeros((len(ref_chars) + 1, len(hyp_chars) + 1), dtype=np.int32)
    for i in range(len(ref_chars) + 1):
        d[i, 0] = i
    for j in range(len(hyp_chars) + 1):
        d[0, j] = j

    for i in range(1, len(ref_chars) + 1):
        for j in range(1, len(hyp_chars) + 1):
            cost = 0 if ref_chars[i - 1] == hyp_chars[j - 1] else 1
            d[i, j] = min(
                d[i - 1, j] + 1,
                d[i, j - 1] + 1,
                d[i - 1, j - 1] + cost,
            )

    return float(d[len(ref_chars), len(hyp_chars)]) / float(len(ref_chars))


async def synthesize_neural_audio(
    text: str,
    voice: str = "hi-IN-SwaraNeural",
    rate: str = "+0%",
    volume: str = "+0%",
) -> np.ndarray:
    """Uses edge-tts to generate acoustic audio buffer for testing."""
    import edge_tts
    import io
    import soundfile as sf

    communicate = edge_tts.Communicate(text, voice, rate=rate, volume=volume)
    mp3_bytes = io.BytesIO()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            mp3_bytes.write(chunk["data"])

    mp3_bytes.seek(0)
    data, sr = sf.read(mp3_bytes, dtype="float32")
    if data.ndim > 1:
        data = data.mean(axis=1)

    # Resample to 16kHz
    proc = AudioProcessor()
    return proc.resample_if_needed(data, sr)


def add_pink_noise(audio: np.ndarray, target_snr_db: float) -> np.ndarray:
    """Adds synthetic acoustic noise at specified SNR."""
    signal_power = float(np.mean(audio ** 2))
    noise = np.random.randn(len(audio)).astype(np.float32)
    noise_power = float(np.mean(noise ** 2))
    desired_noise_power = signal_power / (10.0 ** (target_snr_db / 10.0))
    scale = math.sqrt(desired_noise_power / (noise_power + 1e-12))
    noisy = audio + (noise * scale)
    return np.clip(noisy, -1.0, 1.0)


def run_benchmark():
    print("=" * 80)
    print("   ERA AUTOMATED REAL-WORLD VOICE ACCURACY & BENCHMARK SUITE")
    print("=" * 80)

    # Mock local agent executor for non-destructive testing
    executed_commands: List[Tuple[str, Dict[str, Any]]] = []

    def mock_executor(cmd: str, **params: Any) -> Any:
        executed_commands.append((cmd, params))
        class MockResult:
            success = True
            message = f"Simulated execution of '{cmd}'"
            data = None
        return MockResult()

    results: List[Dict[str, Any]] = []
    wers: List[float] = []
    cers: List[float] = []
    command_correct = 0
    intent_correct = 0
    false_executions = 0
    total_tests = len(BENCHMARK_DATASET)

    print(f"Total Test Cases: {total_tests} spanning Categories A through N\n")

    for idx, tc in enumerate(BENCHMARK_DATASET, 1):
        print(f"[{idx:02d}/{total_tests:02d}] Testing {tc.test_id} ({tc.category}): '{tc.spoken_phrase}'...")

        # 1. Synthesize audio
        voice = tc.voice_name or ("en-IN-NeerjaNeural" if tc.expected_language == "en" else "hi-IN-SwaraNeural")
        try:
            audio = asyncio.run(
                synthesize_neural_audio(
                    tc.spoken_phrase,
                    voice=voice,
                    rate=tc.rate_adjust,
                    volume=tc.volume_adjust,
                )
            )
        except Exception as e:
            print(f"   [Synthesis Fallback] Error synthesizing audio: {e}. Generating tone fallback.")
            audio = np.zeros(16000 * 2, dtype=np.float32)

        # Apply noise if configured
        if tc.noise_snr_db is not None:
            audio = add_pink_noise(audio, tc.noise_snr_db)

        # 2. Process through unified voice pipeline
        t0 = time.perf_counter()
        out = voice_pipeline.process_audio(
            audio_input=audio,
            sample_rate=16000,
            is_user_confirmed=False,
            executor_func=mock_executor,
        )
        latency_ms = (time.perf_counter() - t0) * 1000.0

        # 3. Compute WER / CER
        w_err = compute_wer(tc.spoken_phrase, out.spoken_text)
        c_err = compute_cer(tc.spoken_phrase, out.spoken_text)
        wers.append(w_err)
        cers.append(c_err)

        # 4. Check Intent Accuracy
        intent_match = (out.interpreted_intent == tc.expected_intent)
        if intent_match:
            intent_correct += 1

        # 5. Check Command & Safety Status Accuracy
        if tc.expected_status == "AUTHORIZED":
            status_match = out.status in ("AUTHORIZED", "EXECUTED")
        elif tc.expected_status == "INCOMPLETE_OR_REJECTED":
            status_match = out.status in ("INCOMPLETE_PARAMETERS", "REJECTED_LOW_CONFIDENCE")
        else:
            status_match = (out.status == tc.expected_status)

        cmd_match = (out.target_command == tc.expected_command)

        # False Execution Detection (CRITICAL: Must never execute when status should be rejected/pending!)
        if tc.expected_status in ("PENDING_CONFIRMATION", "INCOMPLETE_PARAMETERS", "REJECTED_LOW_CONFIDENCE", "INCOMPLETE_OR_REJECTED"):
            if out.status == "EXECUTED":
                false_executions += 1
                print(f"   🚨 FALSE EXECUTION DETECTED! Command ran without authorization: {out.target_command}")

        is_passed = status_match and (cmd_match or tc.expected_command is None)
        if is_passed:
            command_correct += 1
            verdict_str = "PASSED"
        else:
            verdict_str = "FAILED"

        print(f"   -> Transcript: '{out.spoken_text}' (conf={out.asr_confidence:.2f}, lang={out.asr_language})")
        print(f"   -> Intent: '{out.interpreted_intent}' (status={out.status}, cmd={out.target_command})")
        print(f"   -> Latency: {latency_ms:.1f}ms | WER: {w_err:.2f} | Result: [{verdict_str}]\n")

        results.append({
            "id": tc.test_id,
            "category": tc.category,
            "spoken": tc.spoken_phrase,
            "transcript": out.spoken_text,
            "asr_conf": out.asr_confidence,
            "intent": out.interpreted_intent,
            "expected_intent": tc.expected_intent,
            "status": out.status,
            "expected_status": tc.expected_status,
            "cmd": out.target_command,
            "expected_cmd": tc.expected_command,
            "wer": w_err,
            "cer": c_err,
            "latency_ms": latency_ms,
            "passed": is_passed,
        })

    # Summary Metrics
    avg_wer = float(np.mean(wers))
    avg_cer = float(np.mean(cers))
    cmd_acc = (command_correct / total_tests) * 100.0
    intent_acc = (intent_correct / total_tests) * 100.0
    false_exec_rate = (false_executions / total_tests) * 100.0
    avg_lat = float(np.mean([r["latency_ms"] for r in results]))

    print("=" * 80)
    print("                      BENCHMARK RESULTS SUMMARY")
    print("=" * 80)
    print(f"Total Test Cases Evaluated : {total_tests}")
    print(f"Word Error Rate (WER)      : {avg_wer:.3f} ({avg_wer * 100:.1f}%)")
    print(f"Character Error Rate (CER) : {avg_cer:.3f} ({avg_cer * 100:.1f}%)")
    print(f"Command Accuracy           : {cmd_acc:.1f}% ({command_correct}/{total_tests})")
    print(f"Intent Classification Acc  : {intent_acc:.1f}% ({intent_correct}/{total_tests})")
    print(f"False Command Execution    : {false_exec_rate:.1f}% ({false_executions} false runs)")
    print(f"Average Pipeline Latency   : {avg_lat:.1f}ms")
    print("=" * 80)

    # Save detailed JSON report
    report_path = Path(__file__).parent / "benchmark_report.json"
    import json
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump({
            "total_tests": total_tests,
            "avg_wer": avg_wer,
            "avg_cer": avg_cer,
            "command_accuracy": cmd_acc,
            "intent_accuracy": intent_acc,
            "false_execution_rate": false_exec_rate,
            "avg_latency_ms": avg_lat,
            "results": results,
        }, f, indent=2, ensure_ascii=False)
    print(f"Saved full benchmark report to: {report_path}")

    return {
        "avg_wer": avg_wer,
        "avg_cer": avg_cer,
        "command_accuracy": cmd_acc,
        "intent_accuracy": intent_acc,
        "false_execution_rate": false_exec_rate,
        "avg_latency_ms": avg_lat,
        "results": results,
    }


if __name__ == "__main__":
    run_benchmark()
