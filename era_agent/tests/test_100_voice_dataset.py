"""ERA 100-Command Voice Recognition & Intent Accuracy Benchmark Suite.

Evaluates 100 real-world spoken commands across:
1. Hindi Commands (20)
2. English Commands (20)
3. Hinglish Commands (20)
4. Multi-Window & Screen Arrangement (15)
5. Hardware Controls (Brightness, Volume, Keyboard Backlight) (15)
6. App Lifecycle (VS Code, Opera, Chrome, WhatsApp, Notepad) (10)

Calculates:
- Word Error Rate (WER)
- Character Error Rate (CER)
- Exact Match Accuracy (%)
- Application Name Accuracy (%)
- False Command Execution Rate (%)
- Mean & P95 Transcription Latency (ms)
"""
import asyncio
import json
import os
import re
import sys
import time
from dataclasses import dataclass, asdict
from typing import List, Dict, Any, Optional

import numpy as np
import edge_tts
import soundfile as sf

# Add parent path to import voice_intelligence
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from voice_intelligence.asr_engine import asr_engine
from voice_intelligence.intent_analyzer import intent_analyzer
from voice_intelligence.command_validator import command_validator
from voice_intelligence.vocabulary import vocabulary_manager
from voice_intelligence.audio_processor import AudioProcessor


def levenshtein_distance(s1: list, s2: list) -> int:
    """Computes Levenshtein edit distance between two sequences."""
    m, n = len(s1), len(s2)
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(m + 1):
        dp[i][0] = i
    for j in range(n + 1):
        dp[0][j] = j
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if s1[i - 1] == s2[j - 1]:
                dp[i][j] = dp[i - 1][j - 1]
            else:
                dp[i][j] = 1 + min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    return dp[m][n]


def compute_wer(reference: str, hypothesis: str) -> float:
    """Computes Word Error Rate."""
    ref_words = re.sub(r"[^\w\s]", "", reference.lower()).split()
    hyp_words = re.sub(r"[^\w\s]", "", hypothesis.lower()).split()
    if not ref_words:
        return 0.0 if not hyp_words else 1.0
    dist = levenshtein_distance(ref_words, hyp_words)
    return float(dist / len(ref_words))


def compute_cer(reference: str, hypothesis: str) -> float:
    """Computes Character Error Rate."""
    ref_chars = list(re.sub(r"\s+", "", reference.lower()))
    hyp_chars = list(re.sub(r"\s+", "", hypothesis.lower()))
    if not ref_chars:
        return 0.0 if not hyp_chars else 1.0
    dist = levenshtein_distance(ref_chars, hyp_chars)
    return float(dist / len(ref_chars))


# 100 Command Test Dataset Definition
DATASET = [
    # -------------------------------------------------------------
    # Category 1: Pure Hindi Commands (20)
    # -------------------------------------------------------------
    {"id": 1, "cat": "hindi", "voice": "hi-IN-MadhurNeural", "spoken": "कंप्यूटर की आवाज बढ़ाओ", "expected_app": None, "expected_intent": "adjust_volume"},
    {"id": 2, "cat": "hindi", "voice": "hi-IN-MadhurNeural", "spoken": "आवाज धीमी कर दो", "expected_app": None, "expected_intent": "adjust_volume"},
    {"id": 3, "cat": "hindi", "voice": "hi-IN-SwaraNeural", "spoken": "आवाज म्यूट कर दो", "expected_app": None, "expected_intent": "mute_volume"},
    {"id": 4, "cat": "hindi", "voice": "hi-IN-MadhurNeural", "spoken": "स्क्रीन की ब्राइटनेस बढ़ाओ", "expected_app": None, "expected_intent": "adjust_brightness"},
    {"id": 5, "cat": "hindi", "voice": "hi-IN-SwaraNeural", "spoken": "ब्राइटनेस कम करो", "expected_app": None, "expected_intent": "adjust_brightness"},
    {"id": 6, "cat": "hindi", "voice": "hi-IN-MadhurNeural", "spoken": "स्क्रीन की चमक पचास प्रतिशत सेट करो", "expected_app": None, "expected_intent": "set_brightness"},
    {"id": 7, "cat": "hindi", "voice": "hi-IN-SwaraNeural", "spoken": "कीबोर्ड लाइट चालू करो", "expected_app": "keyboard", "expected_intent": "set_keyboard_backlight"},
    {"id": 8, "cat": "hindi", "voice": "hi-IN-MadhurNeural", "spoken": "कीबोर्ड लाइट बंद कर दो", "expected_app": "keyboard", "expected_intent": "set_keyboard_backlight"},
    {"id": 9, "cat": "hindi", "voice": "hi-IN-SwaraNeural", "spoken": "नोटपैड खोलो", "expected_app": "notepad", "expected_intent": "open_app"},
    {"id": 10, "cat": "hindi", "voice": "hi-IN-MadhurNeural", "spoken": "नोटपैड बंद करो", "expected_app": "notepad", "expected_intent": "close_app"},
    {"id": 11, "cat": "hindi", "voice": "hi-IN-SwaraNeural", "spoken": "कैल्कुलेटर चलाओ", "expected_app": "calculator", "expected_intent": "open_app"},
    {"id": 12, "cat": "hindi", "voice": "hi-IN-MadhurNeural", "spoken": "गूगल क्रोम खोलो", "expected_app": "chrome", "expected_intent": "open_app"},
    {"id": 13, "cat": "hindi", "voice": "hi-IN-SwaraNeural", "spoken": "ओपेरा ब्राउज़र खोलो", "expected_app": "opera", "expected_intent": "open_app"},
    {"id": 14, "cat": "hindi", "voice": "hi-IN-MadhurNeural", "spoken": "व्हाट्सएप चालू करो", "expected_app": "whatsapp", "expected_intent": "open_app"},
    {"id": 15, "cat": "hindi", "voice": "hi-IN-SwaraNeural", "spoken": "स्क्रीनशॉट लो", "expected_app": None, "expected_intent": "take_screenshot"},
    {"id": 16, "cat": "hindi", "voice": "hi-IN-MadhurNeural", "spoken": "कंप्यूटर लॉक कर दो", "expected_app": None, "expected_intent": "lock_screen"},
    {"id": 17, "cat": "hindi", "voice": "hi-IN-SwaraNeural", "spoken": "सिस्टम की स्थिति बताओ", "expected_app": None, "expected_intent": "system_status"},
    {"id": 18, "cat": "hindi", "voice": "hi-IN-MadhurNeural", "spoken": "डाउनलोड्स फोल्डर खोलो", "expected_app": None, "expected_intent": "open_folder"},
    {"id": 19, "cat": "hindi", "voice": "hi-IN-SwaraNeural", "spoken": "टर्मिनल बंद करो", "expected_app": "terminal", "expected_intent": "close_app"},
    {"id": 20, "cat": "hindi", "voice": "hi-IN-MadhurNeural", "spoken": "ब्राउज़र बंद करो", "expected_app": "chrome", "expected_intent": "close_app"},

    # -------------------------------------------------------------
    # Category 2: Pure English Commands (20)
    # -------------------------------------------------------------
    {"id": 21, "cat": "english", "voice": "en-IN-PrabhatNeural", "spoken": "Open Google Chrome", "expected_app": "chrome", "expected_intent": "open_app"},
    {"id": 22, "cat": "english", "voice": "en-IN-NeerjaNeural", "spoken": "Close Google Chrome", "expected_app": "chrome", "expected_intent": "close_app"},
    {"id": 23, "cat": "english", "voice": "en-IN-PrabhatNeural", "spoken": "Open Visual Studio Code", "expected_app": "vscode", "expected_intent": "open_app"},
    {"id": 24, "cat": "english", "voice": "en-IN-NeerjaNeural", "spoken": "Close VS Code", "expected_app": "vscode", "expected_intent": "close_app"},
    {"id": 25, "cat": "english", "voice": "en-IN-PrabhatNeural", "spoken": "Open Opera browser", "expected_app": "opera", "expected_intent": "open_app"},
    {"id": 26, "cat": "english", "voice": "en-IN-NeerjaNeural", "spoken": "Open WhatsApp Desktop", "expected_app": "whatsapp", "expected_intent": "open_app"},
    {"id": 27, "cat": "english", "voice": "en-IN-PrabhatNeural", "spoken": "Launch Notepad", "expected_app": "notepad", "expected_intent": "open_app"},
    {"id": 28, "cat": "english", "voice": "en-IN-NeerjaNeural", "spoken": "Open Calculator", "expected_app": "calculator", "expected_intent": "open_app"},
    {"id": 29, "cat": "english", "voice": "en-IN-PrabhatNeural", "spoken": "Increase volume", "expected_app": None, "expected_intent": "adjust_volume"},
    {"id": 30, "cat": "english", "voice": "en-IN-NeerjaNeural", "spoken": "Decrease volume", "expected_app": None, "expected_intent": "adjust_volume"},
    {"id": 31, "cat": "english", "voice": "en-IN-PrabhatNeural", "spoken": "Set volume to 50 percent", "expected_app": None, "expected_intent": "set_volume"},
    {"id": 32, "cat": "english", "voice": "en-IN-NeerjaNeural", "spoken": "Mute sound", "expected_app": None, "expected_intent": "mute_volume"},
    {"id": 33, "cat": "english", "voice": "en-IN-PrabhatNeural", "spoken": "Increase brightness", "expected_app": None, "expected_intent": "adjust_brightness"},
    {"id": 34, "cat": "english", "voice": "en-IN-NeerjaNeural", "spoken": "Decrease brightness", "expected_app": None, "expected_intent": "adjust_brightness"},
    {"id": 35, "cat": "english", "voice": "en-IN-PrabhatNeural", "spoken": "Set brightness to 80 percent", "expected_app": None, "expected_intent": "set_brightness"},
    {"id": 36, "cat": "english", "voice": "en-IN-NeerjaNeural", "spoken": "Take a screenshot", "expected_app": None, "expected_intent": "take_screenshot"},
    {"id": 37, "cat": "english", "voice": "en-IN-PrabhatNeural", "spoken": "Lock my computer", "expected_app": None, "expected_intent": "lock_screen"},
    {"id": 38, "cat": "english", "voice": "en-IN-NeerjaNeural", "spoken": "Open Downloads folder", "expected_app": None, "expected_intent": "open_folder"},
    {"id": 39, "cat": "english", "voice": "en-IN-PrabhatNeural", "spoken": "Turn on keyboard backlight", "expected_app": "keyboard", "expected_intent": "set_keyboard_backlight"},
    {"id": 40, "cat": "english", "voice": "en-IN-NeerjaNeural", "spoken": "Turn off keyboard backlight", "expected_app": "keyboard", "expected_intent": "set_keyboard_backlight"},

    # -------------------------------------------------------------
    # Category 3: Hinglish Hybrid Commands (20)
    # -------------------------------------------------------------
    {"id": 41, "cat": "hinglish", "voice": "hi-IN-MadhurNeural", "spoken": "Mera Google Chrome open karo", "expected_app": "chrome", "expected_intent": "open_app"},
    {"id": 42, "cat": "hinglish", "voice": "hi-IN-SwaraNeural", "spoken": "VS Code band kar do", "expected_app": "vscode", "expected_intent": "close_app"},
    {"id": 43, "cat": "hinglish", "voice": "hi-IN-MadhurNeural", "spoken": "WhatsApp open karo", "expected_app": "whatsapp", "expected_intent": "open_app"},
    {"id": 44, "cat": "hinglish", "voice": "hi-IN-SwaraNeural", "spoken": "Opera browser close kar do", "expected_app": "opera", "expected_intent": "close_app"},
    {"id": 45, "cat": "hinglish", "voice": "hi-IN-MadhurNeural", "spoken": "Volume thoda badha do", "expected_app": None, "expected_intent": "adjust_volume"},
    {"id": 46, "cat": "hinglish", "voice": "hi-IN-SwaraNeural", "spoken": "Volume kam karo", "expected_app": None, "expected_intent": "adjust_volume"},
    {"id": 47, "cat": "hinglish", "voice": "hi-IN-MadhurNeural", "spoken": "Brightness full kar do", "expected_app": None, "expected_intent": "set_brightness"},
    {"id": 48, "cat": "hinglish", "voice": "hi-IN-SwaraNeural", "spoken": "Brightness zero kar do", "expected_app": None, "expected_intent": "set_brightness"},
    {"id": 49, "cat": "hinglish", "voice": "hi-IN-MadhurNeural", "spoken": "Screenshot le lo", "expected_app": None, "expected_intent": "take_screenshot"},
    {"id": 50, "cat": "hinglish", "voice": "hi-IN-SwaraNeural", "spoken": "PC lock kar do", "expected_app": None, "expected_intent": "lock_screen"},
    {"id": 51, "cat": "hinglish", "voice": "hi-IN-MadhurNeural", "spoken": "Notepad chala do", "expected_app": "notepad", "expected_intent": "open_app"},
    {"id": 52, "cat": "hinglish", "voice": "hi-IN-SwaraNeural", "spoken": "Calculator open kar do", "expected_app": "calculator", "expected_intent": "open_app"},
    {"id": 53, "cat": "hinglish", "voice": "hi-IN-MadhurNeural", "spoken": "Keyboard backlight badhao", "expected_app": "keyboard", "expected_intent": "adjust_keyboard_backlight"},
    {"id": 54, "cat": "hinglish", "voice": "hi-IN-SwaraNeural", "spoken": "Keyboard light off karo", "expected_app": "keyboard", "expected_intent": "set_keyboard_backlight"},
    {"id": 55, "cat": "hinglish", "voice": "hi-IN-MadhurNeural", "spoken": "Downloads folder open karo", "expected_app": None, "expected_intent": "open_folder"},
    {"id": 56, "cat": "hinglish", "voice": "hi-IN-SwaraNeural", "spoken": "Volume 40 percent set karo", "expected_app": None, "expected_intent": "set_volume"},
    {"id": 57, "cat": "hinglish", "voice": "hi-IN-MadhurNeural", "spoken": "Sound mute kar do", "expected_app": None, "expected_intent": "mute_volume"},
    {"id": 58, "cat": "hinglish", "voice": "hi-IN-SwaraNeural", "spoken": "Terminal open karo", "expected_app": "terminal", "expected_intent": "open_app"},
    {"id": 59, "cat": "hinglish", "voice": "hi-IN-MadhurNeural", "spoken": "Settings open kar do", "expected_app": "settings", "expected_intent": "open_app"},
    {"id": 60, "cat": "hinglish", "voice": "hi-IN-SwaraNeural", "spoken": "Paint app kholo", "expected_app": "paint", "expected_intent": "open_app"},

    # -------------------------------------------------------------
    # Category 4: Multi-Window & Screen Arrangement (15)
    # -------------------------------------------------------------
    {"id": 61, "cat": "multi_window", "voice": "hi-IN-MadhurNeural", "spoken": "मेरा VS Code मेरी right screen पर, मेरा WhatsApp मेरे left screen पर set करो।", "expected_app": "whatsapp & vscode", "expected_intent": "split_screen"},
    {"id": 62, "cat": "multi_window", "voice": "en-IN-PrabhatNeural", "spoken": "Set VS Code on right screen and WhatsApp on left screen", "expected_app": "whatsapp & vscode", "expected_intent": "split_screen"},
    {"id": 63, "cat": "multi_window", "voice": "hi-IN-SwaraNeural", "spoken": "Left side Google Chrome right side Notepad set karo", "expected_app": "chrome & notepad", "expected_intent": "split_screen"},
    {"id": 64, "cat": "multi_window", "voice": "hi-IN-MadhurNeural", "spoken": "Chrome ko left side aur VS Code ko right side arrange karo", "expected_app": "chrome & vscode", "expected_intent": "split_screen"},
    {"id": 65, "cat": "multi_window", "voice": "en-IN-NeerjaNeural", "spoken": "Split screen left Chrome right VS Code", "expected_app": "chrome & vscode", "expected_intent": "split_screen"},
    {"id": 66, "cat": "multi_window", "voice": "hi-IN-MadhurNeural", "spoken": "VS Code ko left screen par move karo", "expected_app": "vscode", "expected_intent": "snap_window"},
    {"id": 67, "cat": "multi_window", "voice": "hi-IN-SwaraNeural", "spoken": "WhatsApp ko right screen par snap karo", "expected_app": "whatsapp", "expected_intent": "snap_window"},
    {"id": 68, "cat": "multi_window", "voice": "en-IN-PrabhatNeural", "spoken": "Move Google Chrome to right screen", "expected_app": "chrome", "expected_intent": "snap_window"},
    {"id": 69, "cat": "multi_window", "voice": "en-IN-NeerjaNeural", "spoken": "Snap Notepad to left side", "expected_app": "notepad", "expected_intent": "snap_window"},
    {"id": 70, "cat": "multi_window", "voice": "hi-IN-MadhurNeural", "spoken": "Left side WhatsApp right side Opera set karo", "expected_app": "whatsapp & opera", "expected_intent": "split_screen"},
    {"id": 71, "cat": "multi_window", "voice": "hi-IN-SwaraNeural", "spoken": "Left me VS Code right me Terminal set karo", "expected_app": "vscode & terminal", "expected_intent": "split_screen"},
    {"id": 72, "cat": "multi_window", "voice": "en-IN-PrabhatNeural", "spoken": "Place Notepad on the right screen", "expected_app": "notepad", "expected_intent": "snap_window"},
    {"id": 73, "cat": "multi_window", "voice": "hi-IN-MadhurNeural", "spoken": "Screen ko aadha aadha split kar do", "expected_app": "active_windows", "expected_intent": "split_screen"},
    {"id": 74, "cat": "multi_window", "voice": "hi-IN-SwaraNeural", "spoken": "Windows ko side by side set karo", "expected_app": "active_windows", "expected_intent": "split_screen"},
    {"id": 75, "cat": "multi_window", "voice": "en-IN-NeerjaNeural", "spoken": "Split screen side by side", "expected_app": "active_windows", "expected_intent": "split_screen"},

    # -------------------------------------------------------------
    # Category 5: Hardware Controls (Volume, Brightness, Backlight) (15)
    # -------------------------------------------------------------
    {"id": 76, "cat": "hardware", "voice": "hi-IN-MadhurNeural", "spoken": "Volume 75 percent set karo", "expected_app": None, "expected_intent": "set_volume"},
    {"id": 77, "cat": "hardware", "voice": "hi-IN-SwaraNeural", "spoken": "Volume ko full kar do", "expected_app": None, "expected_intent": "set_volume"},
    {"id": 78, "cat": "hardware", "voice": "en-IN-PrabhatNeural", "spoken": "Set master volume to 30 percent", "expected_app": None, "expected_intent": "set_volume"},
    {"id": 79, "cat": "hardware", "voice": "en-IN-NeerjaNeural", "spoken": "Unmute audio", "expected_app": None, "expected_intent": "set_volume_mute"},
    {"id": 80, "cat": "hardware", "voice": "hi-IN-MadhurNeural", "spoken": "Aawaz band kar do", "expected_app": None, "expected_intent": "mute_volume"},
    {"id": 81, "cat": "hardware", "voice": "hi-IN-SwaraNeural", "spoken": "Aawaz thodi tez karo", "expected_app": None, "expected_intent": "adjust_volume"},
    {"id": 82, "cat": "hardware", "voice": "hi-IN-MadhurNeural", "spoken": "Brightness 60 percent set karo", "expected_app": None, "expected_intent": "set_brightness"},
    {"id": 83, "cat": "hardware", "voice": "hi-IN-SwaraNeural", "spoken": "Chamak thodi kam karo", "expected_app": None, "expected_intent": "adjust_brightness"},
    {"id": 84, "cat": "hardware", "voice": "en-IN-PrabhatNeural", "spoken": "Set display brightness to 100 percent", "expected_app": None, "expected_intent": "set_brightness"},
    {"id": 85, "cat": "hardware", "voice": "en-IN-NeerjaNeural", "spoken": "Dim display brightness", "expected_app": None, "expected_intent": "adjust_brightness"},
    {"id": 86, "cat": "hardware", "voice": "hi-IN-MadhurNeural", "spoken": "Keyboard backlight 50 percent set karo", "expected_app": "keyboard", "expected_intent": "set_keyboard_backlight"},
    {"id": 87, "cat": "hardware", "voice": "hi-IN-SwaraNeural", "spoken": "Keyboard light full kar do", "expected_app": "keyboard", "expected_intent": "set_keyboard_backlight"},
    {"id": 88, "cat": "hardware", "voice": "en-IN-PrabhatNeural", "spoken": "Turn off keyboard light", "expected_app": "keyboard", "expected_intent": "set_keyboard_backlight"},
    {"id": 89, "cat": "hardware", "voice": "en-IN-NeerjaNeural", "spoken": "Increase keyboard backlight", "expected_app": "keyboard", "expected_intent": "adjust_keyboard_backlight"},
    {"id": 90, "cat": "hardware", "voice": "hi-IN-MadhurNeural", "spoken": "Keyboard light kam karo", "expected_app": "keyboard", "expected_intent": "adjust_keyboard_backlight"},

    # -------------------------------------------------------------
    # Category 6: Specific App Lifecycle (VS Code, Opera, Chrome, WhatsApp, Notepad) (10)
    # -------------------------------------------------------------
    {"id": 91, "cat": "app_lifecycle", "voice": "hi-IN-MadhurNeural", "spoken": "Opera browser open kar do", "expected_app": "opera", "expected_intent": "open_app"},
    {"id": 92, "cat": "app_lifecycle", "voice": "hi-IN-SwaraNeural", "spoken": "Opera browser band karo", "expected_app": "opera", "expected_intent": "close_app"},
    {"id": 93, "cat": "app_lifecycle", "voice": "hi-IN-MadhurNeural", "spoken": "VS Code open karo", "expected_app": "vscode", "expected_intent": "open_app"},
    {"id": 94, "cat": "app_lifecycle", "voice": "hi-IN-SwaraNeural", "spoken": "VS Code close karo", "expected_app": "vscode", "expected_intent": "close_app"},
    {"id": 95, "cat": "app_lifecycle", "voice": "hi-IN-MadhurNeural", "spoken": "WhatsApp open karo", "expected_app": "whatsapp", "expected_intent": "open_app"},
    {"id": 96, "cat": "app_lifecycle", "voice": "hi-IN-SwaraNeural", "spoken": "WhatsApp band kar do", "expected_app": "whatsapp", "expected_intent": "close_app"},
    {"id": 97, "cat": "app_lifecycle", "voice": "en-IN-PrabhatNeural", "spoken": "Launch Google Chrome", "expected_app": "chrome", "expected_intent": "open_app"},
    {"id": 98, "cat": "app_lifecycle", "voice": "en-IN-NeerjaNeural", "spoken": "Close Google Chrome", "expected_app": "chrome", "expected_intent": "close_app"},
    {"id": 99, "cat": "app_lifecycle", "voice": "hi-IN-MadhurNeural", "spoken": "Notepad open kar do", "expected_app": "notepad", "expected_intent": "open_app"},
    {"id": 100, "cat": "app_lifecycle", "voice": "hi-IN-SwaraNeural", "spoken": "Notepad band kar do", "expected_app": "notepad", "expected_intent": "close_app"},
]


async def run_benchmark():
    print(f"================================================================")
    print(f"      ERA 100-COMMAND VOICE INTELLIGENCE BENCHMARK SUITE       ")
    print(f"================================================================")
    print(f"Total Test Cases: {len(DATASET)}")
    print(f"Model Under Test: Faster-Whisper 'small' (int8 quantization)")
    print(f"Pipeline: AudioProcessor -> ASREngine -> IntentAnalyzer -> CommandValidator\n")

    audio_cache_dir = os.path.join(os.path.dirname(__file__), "benchmark_audio_cache")
    os.makedirs(audio_cache_dir, exist_ok=True)

    results: List[Dict[str, Any]] = []
    wers: List[float] = []
    cers: List[float] = []
    latencies: List[float] = []
    exact_matches = 0
    app_matches = 0
    total_app_cases = 0
    false_executions = 0

    t_suite_start = time.perf_counter()

    for idx, item in enumerate(DATASET, 1):
        item_id = item["id"]
        spoken = item["spoken"]
        voice = item["voice"]
        cat = item["cat"]
        expected_app = item["expected_app"]
        expected_intent = item["expected_intent"]

        wav_path = os.path.join(audio_cache_dir, f"cmd_{item_id:03d}.wav")
        # Synthesize audio if not already cached
        if not os.path.exists(wav_path):
            comm = edge_tts.Communicate(spoken, voice)
            await comm.save(wav_path)

        # 1. Load audio and decode
        raw_audio, sr = sf.read(wav_path, dtype="float32")
        if len(raw_audio.shape) > 1:
            raw_audio = raw_audio[:, 0]

        # 2. Resample to 16kHz if needed
        audio_proc = AudioProcessor()
        audio_16k = audio_proc.resample_if_needed(raw_audio, sr)

        # 3. Transcribe with ASREngine
        t0 = time.perf_counter()
        asr_res = asr_engine.transcribe(audio_16k, sample_rate=16000)
        t_asr = (time.perf_counter() - t0) * 1000.0

        transcript = asr_res.raw_transcript
        latencies.append(t_asr)

        # 4. Analyze intent
        intent_res = intent_analyzer.analyze(transcript)
        verdict = command_validator.validate(asr_res, intent_res)

        # 5. Metrics calculation
        wer = compute_wer(spoken, transcript)
        cer = compute_cer(spoken, transcript)
        wers.append(wer)
        cers.append(cer)

        is_exact = (wer == 0.0)
        if is_exact:
            exact_matches += 1

        # Check App Name recognition
        app_matched = None
        if expected_app is not None:
            total_app_cases += 1
            detected_target = intent_res.target_entity.lower() if intent_res.target_entity else ""
            # Check if expected app name appears in target or parameters
            params_str = str(intent_res.parameters).lower()
            if expected_app.lower() in detected_target or expected_app.lower() in params_str:
                app_matched = True
                app_matches += 1
            else:
                app_matched = False

        # False execution check: Did ERA execute the WRONG app (e.g. Opera instead of WhatsApp/VS Code)?
        is_false_exec = False
        if expected_app and app_matched is False and verdict.is_executable:
            is_false_exec = True
            false_executions += 1
        elif expected_intent and verdict.is_executable and verdict.status == "AUTHORIZED":
            det = intent_res.intent_name
            compatible = {
                "mute_volume": ["mute_volume", "set_volume_mute"],
                "lock_screen": ["lock_screen", "lock_pc"],
                "close_app": ["close_app", "close_browser"],
                "adjust_keyboard_backlight": ["adjust_keyboard_backlight", "set_keyboard_backlight"],
            }.get(expected_intent, [expected_intent])
            if det not in compatible:
                is_false_exec = True
                false_executions += 1

        res_record = {
            "id": item_id,
            "category": cat,
            "spoken": spoken,
            "transcript": transcript,
            "wer": round(wer, 4),
            "cer": round(cer, 4),
            "latency_ms": round(t_asr, 1),
            "asr_conf": round(asr_res.confidence_score, 3),
            "detected_intent": intent_res.intent_name,
            "expected_intent": expected_intent,
            "detected_target": intent_res.target_entity,
            "expected_app": expected_app,
            "app_matched": app_matched,
            "verdict_status": verdict.status,
            "is_false_execution": is_false_exec,
        }
        results.append(res_record)

        if idx % 10 == 0 or idx == len(DATASET):
            print(f"[{idx:3d}/100] Spoken: {spoken[:32]:<32} | Transcript: {transcript[:32]:<32} | WER: {wer:.2f} | Latency: {t_asr:5.0f}ms", flush=True)

    total_time = time.perf_counter() - t_suite_start

    # Summary Statistics
    mean_wer = float(np.mean(wers))
    mean_cer = float(np.mean(cers))
    exact_acc = float(exact_matches / len(DATASET)) * 100.0
    app_acc = float(app_matches / total_app_cases) * 100.0 if total_app_cases > 0 else 100.0
    false_exec_rate = float(false_executions / len(DATASET)) * 100.0
    mean_lat = float(np.mean(latencies))
    p95_lat = float(np.percentile(latencies, 95))

    summary = {
        "total_cases": len(DATASET),
        "total_time_sec": round(total_time, 2),
        "mean_wer": round(mean_wer, 4),
        "mean_cer": round(mean_cer, 4),
        "exact_transcription_accuracy_pct": round(exact_acc, 2),
        "application_name_accuracy_pct": round(app_acc, 2),
        "false_command_execution_rate_pct": round(false_exec_rate, 2),
        "mean_latency_ms": round(mean_lat, 1),
        "p95_latency_ms": round(p95_lat, 1),
    }

    report = {
        "summary": summary,
        "test_results": results,
    }

    report_path = os.path.join(os.path.dirname(__file__), "benchmark_report_100.json")
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    print(f"\n================================================================")
    print(f"                    BENCHMARK FINAL SUMMARY                     ")
    print(f"================================================================")
    print(f"Total Commands Tested        : {len(DATASET)}")
    print(f"Mean Word Error Rate (WER)   : {mean_wer * 100:.2f}%")
    print(f"Mean Character Error Rate    : {mean_cer * 100:.2f}%")
    print(f"Exact Match Accuracy         : {exact_acc:.1f}%")
    print(f"Application Name Accuracy    : {app_acc:.1f}%")
    print(f"False Command Execution Rate : {false_exec_rate:.1f}% (Expected: 0.0%)")
    print(f"Mean Latency                 : {mean_lat:.1f} ms")
    print(f"P95 Latency                  : {p95_lat:.1f} ms")
    print(f"Report saved to              : {report_path}")
    print(f"================================================================")


if __name__ == "__main__":
    asyncio.run(run_benchmark())
