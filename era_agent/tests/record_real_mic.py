import sounddevice as sd
import soundfile as sf
import numpy as np
import time
import os
import sys

sys.path.insert(0, r"D:\era_agent")
from voice_intelligence import asr_engine, AudioProcessor

def test_mic(duration_sec=4, sample_rate=16000):
    print(f"--- Recording {duration_sec}s from default microphone at {sample_rate}Hz ---")
    print("Speak something now into your microphone...")
    audio = sd.rec(int(duration_sec * sample_rate), samplerate=sample_rate, channels=1, dtype='float32')
    sd.wait()
    audio = audio.flatten()
    
    # Calculate audio metrics
    rms = float(np.sqrt(np.mean(audio ** 2)))
    peak = float(np.max(np.abs(audio)))
    noise_floor = float(np.percentile(np.abs(audio), 10))
    snr_db = 20 * np.log10((rms + 1e-9) / (noise_floor + 1e-9))
    clipping_ratio = float(np.mean(np.abs(audio) >= 0.99))
    
    print(f"Recording Complete:")
    print(f"  Duration      : {duration_sec}s")
    print(f"  Sample Rate   : {sample_rate}Hz")
    print(f"  RMS Level     : {rms:.4f}")
    print(f"  Peak Level    : {peak:.4f}")
    print(f"  Noise Floor   : {noise_floor:.6f}")
    print(f"  Estimated SNR : {snr_db:.2f} dB")
    print(f"  Clipping Ratio: {clipping_ratio:.4f}")
    
    out_wav = r"D:\era_agent\tests\real_mic_sample.wav"
    sf.write(out_wav, audio, sample_rate)
    print(f"Saved audio to: {out_wav}")
    
    # Run Faster-Whisper on this audio
    res = asr_engine.transcribe(audio, sample_rate=sample_rate)
    print(f"\nFaster-Whisper Transcript : {repr(res.raw_transcript)}")
    print(f"Detected Language         : {res.language}")
    print(f"Acoustic Confidence       : {res.confidence_score}")
    print(f"Latency                   : {res.latency_ms:.1f}ms")

if __name__ == "__main__":
    test_mic(duration_sec=4)
