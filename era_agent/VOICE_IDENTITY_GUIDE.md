# ERA Voice Identity & Owner Verification System 🎙️🛡️

ERA is equipped with a state-of-the-art **Biometric Speaker Verification System** powered by SpeechBrain's ECAPA-TDNN (192-dimensional deep neural voice embeddings) and real-time Voice Activity Detection (VAD).

---

## 🚀 How It Works in ERA

1. **Continuous Secret Background Verification:**
   - While ERA's voice agent (Gemini Live) listens and converses with you naturally, the **VoiceGuard** engine runs silently in parallel in the background.
   - It captures speech from your microphone or audio stream, runs real-time VAD, extracts speaker embeddings, and computes cosine similarity against your registered owner voiceprint.

2. **Per-Command Security Gate:**
   - Before executing **ANY command or system action** (launching apps, opening websites, writing/running code, WhatsApp messaging, OS controls, shell execution):
     - ERA secretly checks the fresh voice identity verification.
     - **If the speaker is NOT the Owner (or an unknown/impostor voice):**
       - The command is **BLOCKED immediately**.
       - ERA prevents execution and informs: *"Access Denied: Voice verification failed. Speaker is not recognized as the registered owner."*
     - **If the speaker IS the Owner:**
       - The command executes seamlessly and properly without delay.

3. **Public Commands:**
   - Safe diagnostic commands (e.g. asking for the time, date, weather, or system status) remain accessible to anyone.

---

## 🎙️ Step 1: Enroll Your Voice (One-Time Setup)

To lock ERA exclusively to your voice, enroll your voice using the automated helper:

### Option A: Quick Batch Launcher
Double-click:
```
d:\era_agent\enroll_owner_voice.bat
```
or
```
d:\era-voice-assistant\enroll_owner_voice.bat
```

### Option B: Terminal Command
Run inside PowerShell:
```powershell
Set-Location "d:\era_agent"
& "d:\era_agent\.venv\Scripts\python.exe" -m era_voice_identity enroll --samples 3 --seconds 6
```

> **Enrollment Tips:**
> - Speak naturally in your regular tone and pace.
> - Ensure your room is relatively quiet.
> - Speak for the full 5-6 seconds when prompted.
> - Your voiceprint is securely encrypted on disk using Windows DPAPI (tied to your Windows user account).

---

## 🔍 Step 2: Check Verification Status Anytime

You can inspect the live voice identity status at any time:

- **Via Terminal:**
  ```powershell
  & "d:\era_agent\.venv\Scripts\python.exe" -m era_voice_identity status
  ```
- **Via REST API (Web UI):**
  ```
  GET http://localhost:3000/api/voice-identity/status
  ```
- **Via Local Agent API:**
  ```
  GET http://localhost:8000/voice-identity/status
  ```

---

## ⚙️ Configuration & Sensitivity

In `d:\era_agent\.env` or environment variables:
- `ERA_VOICE_TTL_SECONDS=15.0`: Freshness window for voice verification (default: 15 seconds).
- `ERA_VOICE_REQUIRE_ENROLLMENT=true`: Enforces strict command gating once enrolled.
- Threshold: Pre-calibrated to `0.65` cosine similarity for optimal balance between high security and zero false rejections.

---

## 🔄 Resetting Voice Profile

If you ever want to re-enroll or reset your voice profile:
```powershell
& "d:\era_agent\.venv\Scripts\python.exe" -m era_voice_identity reset
```
Then run the enrollment script again.
