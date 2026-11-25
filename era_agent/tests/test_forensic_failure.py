import asyncio
import os
import sys
import tempfile
sys.path.insert(0, r"D:\era_agent")
import edge_tts
from voice_intelligence import asr_engine, AudioProcessor, IntentAnalyzer, CommandValidator

async def run_test():
    voices = ['hi-IN-MadhurNeural', 'hi-IN-SwaraNeural']
    text = "मेरा VS Code मेरी right screen पर, मेरा WhatsApp मेरे left screen पर set करो।"
    
    for v in voices:
        print(f"\n--- Testing with voice: {v} ---")
        out_path = os.path.join(tempfile.gettempdir(), f"failure_test_{v}.wav")
        comm = edge_tts.Communicate(text, v)
        await comm.save(out_path)
        
        # Transcribe with Faster-Whisper
        import soundfile as sf
        audio, sr = sf.read(out_path, dtype="float32")
        if len(audio.shape) > 1:
            audio = audio[:, 0]
        res = asr_engine.transcribe(audio, sample_rate=sr)
        print("Raw Whisper Transcript :", repr(res.raw_transcript))
        print("Detected Language      :", res.language)
        print("Acoustic Confidence    :", res.confidence)
        
        # Test intent
        analyzer = IntentAnalyzer()
        intent = analyzer.analyze(res.raw_transcript)
        print("Interpreted Intent     :", intent.intent_name)
        print("Target Entity          :", intent.target_entity)
        print("Parameters             :", intent.parameters)

if __name__ == "__main__":
    asyncio.run(run_test())
