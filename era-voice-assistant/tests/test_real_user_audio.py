import math

def evaluate_voiceprint(
    owner_pitch: float,
    probe_pitch: float,
    owner_centroid: float,
    probe_centroid: float,
    mel_cos: float,
    mfcc_cos: float,
    strictness: str = "balanced"
):
    pitch_delta = abs(probe_pitch - owner_pitch)
    rel_diff = pitch_delta / max(1.0, owner_pitch)
    # sigma = 0.38 allows up to ±32% natural intonation with >= 50% pitch compatibility
    pitch_compat = round(100 * math.exp(-((rel_diff / 0.38) ** 2)))

    # Spectral centroid ratio (vocal tract length / acoustic brightness)
    centroid_ratio = min(owner_centroid, probe_centroid) / max(1.0, max(owner_centroid, probe_centroid))
    centroid_score = round(centroid_ratio * 100)

    # Mel formant envelope (Long-term spectral slope) - measures vocal tract shape independent of words
    mel_score = max(0, min(100, round(((mel_cos + 0.1) / 1.1) * 100)))

    # MFCC score (normalized): words differ, so MFCC has lower weight in text-independent verification
    mfcc_score = max(0, min(100, round(30 + max(0.0, mfcc_cos) * 70)))

    # Timbre composite (60% Mel envelope + 25% Centroid + 15% MFCC)
    timbre_score = round(0.60 * mel_score + 0.25 * centroid_score + 0.15 * mfcc_score)

    # Holistic overall score:
    # 40% Pitch + 40% Vocal Tract Timbre + 20% Mel Spectral Formants
    overall_score = round(0.40 * pitch_compat + 0.40 * timbre_score + 0.20 * mel_score)

    # Verification threshold:
    # balanced: 45% (allows natural owner command variations, blocks intruders)
    # strict: 55%
    threshold = 55 if strictness == "strict" else 45

    passed = overall_score >= threshold
    failure_reason = None
    if not passed:
        if pitch_compat < 35:
            failure_reason = f"Fundamental pitch mismatch ({probe_pitch:.0f} Hz vs owner {owner_pitch:.0f} Hz)."
        else:
            failure_reason = f"Acoustic vocal profile mismatch (Confidence: {overall_score}% < {threshold}%)."

    return {
        "overall_score": overall_score,
        "pitch_compat": pitch_compat,
        "timbre_score": timbre_score,
        "mel_score": mel_score,
        "mfcc_score": mfcc_score,
        "passed": passed,
        "failure_reason": failure_reason
    }

print("=== CALIBRATED ACCURACY TEST ===")
owner_pitch = 160.0
owner_centroid = 1850.0

cases = [
    ("Owner Normal Command (186 Hz)", 186.0, 1800.0, 0.85, 0.25),
    ("Owner Energetic Command (191 Hz)", 191.0, 1880.0, 0.82, 0.20),
    ("Owner Short Command (174 Hz)", 174.0, 1820.0, 0.88, 0.30),
    ("Owner Calm/Tired Command (150 Hz)", 150.0, 1780.0, 0.86, 0.35),
    ("Owner Question Intonation (215 Hz)", 215.0, 1920.0, 0.78, 0.18),
    ("INTRUDER 1: Female voice (255 Hz)", 255.0, 2400.0, 0.30, -0.10),
    ("INTRUDER 2: Deep Male voice (95 Hz)", 95.0, 1200.0, 0.35, -0.05),
    ("INTRUDER 3: Background TV / Radio", 230.0, 2600.0, 0.20, -0.20),
]

for name, p_pitch, p_cent, mel_c, mfcc_c in cases:
    res = evaluate_voiceprint(owner_pitch, p_pitch, owner_centroid, p_cent, mel_c, mfcc_c, "balanced")
    verdict = "PASS (ALLOWED)" if res["passed"] else f"BLOCK ({res['failure_reason']})"
    print(f"{name:38} -> Score: {res['overall_score']:2d}% | PitchCompat: {res['pitch_compat']:2d}% -> {verdict}")
