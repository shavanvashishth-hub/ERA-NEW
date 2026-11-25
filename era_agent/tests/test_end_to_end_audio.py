import asyncio
import base64
import json
import os
import sys
import urllib.request
import edge_tts

async def test():
    wav_path = r"D:\era_agent\tests\test_split_command.wav"
    text = "मेरा VS Code मेरी right screen पर, मेरा WhatsApp मेरे left screen पर set करो।"
    print(f"Synthesizing audio for: '{text}'...")
    comm = edge_tts.Communicate(text, "hi-IN-MadhurNeural")
    await comm.save(wav_path)
    
    with open(wav_path, "rb") as f:
        audio_b64 = base64.b64encode(f.read()).decode("utf-8")
        
    print("Sending audio_base64 to http://127.0.0.1:8000/voice/process_command...")
    req = urllib.request.Request(
        "http://127.0.0.1:8000/voice/process_command",
        data=json.dumps({"audio_base64": audio_b64, "sample_rate": 16000}).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    res = urllib.request.urlopen(req)
    out = json.loads(res.read().decode("utf-8"))
    print("\n--- Pipeline Audio Response ---")
    print("Spoken Text Heard   :", repr(out.get("spoken_text")))
    print("ASR Language        :", out.get("asr_language"))
    print("ASR Confidence      :", out.get("asr_confidence"))
    print("Interpreted Intent  :", out.get("interpreted_intent"))
    print("Target Command      :", out.get("target_command"))
    print("Command Parameters  :", out.get("command_params"))
    print("Status              :", out.get("status"))
    print("Voice Response Text :", out.get("voice_response_text"))

if __name__ == "__main__":
    asyncio.run(test())
