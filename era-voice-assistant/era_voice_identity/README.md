# era_voice_identity — owner voice verification for ERA

Standalone, fully local **speaker verification** (not speech-to-text): is the live microphone voice the registered owner?
SpeechBrain ECAPA-TDNN (`speechbrain/spkrec-ecapa-voxceleb`, 192-d embeddings) + cosine scoring + VAD.
No cloud, no Gemini, no external biometric API. Does not import or modify anything from ERA.

## Architecture

```
mic ─► StreamingVAD ─► UtteranceSegmenter ──(≥2.5 s speech, then every +2 s)──► Verifier
                                                                                  │
 audio.py  load/resample/VAD/quality        speech-only audio (≤4 s) ─► ECAPA embedding ─► cosine vs owner centroid
 enrollment.py  validate ► embed ► outlier-reject ► centroid                      │
 profile_manager.py  atomic, integrity-hashed, DPAPI-encrypted (Windows)          ▼
 verification.py  model wrapper, calibration, status logic     {is_owner, status, confidence, reason, score, ...}
 security.py  SecurityGate (voice → liveness → 2nd factor), ReplayGuard, ChallengeLiveness
 engine.py  public API + thread safety + fail-closed wrapper
```

Decision rules: `OWNER` only if a profile is loaded, the model ran, there was ≥1.5 s of detected speech, and
`cosine ≥ threshold`. Everything else (silence, short audio, model/profile error, no profile) is `is_owner=false`.
`verify_speaker` never raises.

**Confidence is not a probability.** It is a logistic index of `(score − threshold)/0.06`: 0.5 exactly at the
threshold. Treat the *threshold*, calibrated on real data, as the real decision; use `score` for strict checks.

## Install (Windows 10/11, Python 3.10–3.12, 64-bit)

```powershell
cd <folder that CONTAINS era_voice_identity\>
python -m venv .venv
.venv\Scripts\activate
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
pip install -r era_voice_identity\requirements.txt
python -m era_voice_identity devices      # lists microphones
python -m era_voice_identity status       # first run downloads the model (~80 MB) into %APPDATA%\ERA\voice_identity\model
```
* First run needs internet once (Hugging Face). After that it is offline: the cached copy is used.
* Model files are *copied*, not symlinked, so Windows needs no Developer Mode.
* NVIDIA GPU: install the CUDA build of PyTorch; `device="auto"` picks it up (`--device cpu` to force CPU).
* Allow microphone access: Settings → Privacy → Microphone → "Let desktop apps access your microphone".

## Enroll the owner

```powershell
python -m era_voice_identity enroll --samples 5 --seconds 8     # prompts you to speak naturally
python -m era_voice_identity enroll --append --samples 2        # add more recordings later
python -m era_voice_identity reset                              # delete profile, then enroll again
```
Tips: quiet room, normal speaking distance, your everyday microphone, different sentences, ≥4 s of speech each
(rejected automatically if too short, clipped, noisy, or inconsistent with the others). Also enroll on each mic you use.
In code: `enroll_owner([wav_path_or_numpy_array, ...])`.

## Use

```python
import era_voice_identity as vi
print(vi.initialize())                         # {'ok': True, 'error': None, 'enrolled': True}
print(vi.verify_speaker("clip.wav"))           # path | float32/int16 ndarray | int16 PCM bytes
vi.start_monitoring(lambda r: print(r["status"], r["confidence"]))
vi.get_status(); vi.stop_monitoring()
```
Result keys: `is_owner, status, confidence, reason` plus `score, threshold, speech_seconds, latency_ms, timestamp, flags`.
Statuses: `OWNER, UNKNOWN, INSUFFICIENT_AUDIO, MODEL_ERROR, NO_SPEECH`.

## Calibrate the threshold (do this — the default 0.40 is a conservative starting guess)

Collect held-out clips of you (not used in enrollment) and of other people on your mics, then:
```powershell
python -m era_voice_identity calibrate --owner-dir D:\voice\owner_holdout --impostor-dir D:\voice\others --target-far 0.01
```
The result reports FRR/FAR at the chosen threshold and whether the FAR estimate is statistically meaningful
(1% FAR needs ≳300 impostor clips to be trusted).

## Testing

```powershell
python -m pytest era_voice_identity\tests -q                       # logic tests (synthetic audio + fake embedder)
set ERA_VOICE_TEST_DATA=D:\voice\dataset
python -m era_voice_identity evaluate --data D:\voice\dataset      # REAL FAR/FRR
```
Dataset layout: `enroll/`, `genuine/<condition>/`, `impostor/<condition>/` (see `evaluate.py`). Suggested conditions:

| # | Spec item | How it is covered |
|---|-----------|-------------------|
| 1 | Registered owner | `genuine/clean` (real) + synthetic logic test |
| 2 | Different speakers | `impostor/different_speakers` (real) + synthetic logic test |
| 3 | Similar-sounding speakers | `impostor/similar_speakers` — **real recordings only** (siblings, same-gender/accent) |
| 4 | Background noise | `genuine/noisy` (real) + synthetic NO_SPEECH/noise logic tests |
| 5 | Low-volume speech | `genuine/low_volume` (real) + synthetic level test |
| 6 | Different microphones | `genuine/mic_b`, `mic_c`… — **real only** |
| 7 | Replay recordings | `impostor/replay` — play owner recordings through a speaker, record with the mic |
| 8 | AI voice cloning | `impostor/ai_clone` — clones you generate yourself with consent |
| 9 | Insufficient audio | automated tests |
| 10 | Model failure | automated tests (load failure, inference failure, corrupt profile) |

`evaluate` prints per-condition FRR/FAR with 95% Wilson intervals and clip counts; it prints `null` instead of a rate
when a folder is empty. **No FAR/FRR numbers are shipped with this code — they must come from your recordings.**

## Security model

* **Fail closed:** any error, missing profile, corrupt profile, model mismatch ⇒ not the owner.
* **Voice ≠ proof of a live human.** Replays and cloned voices can score as the owner. Mitigations, in layers:
  1. `SecurityGate` (`security.py`): `PUBLIC` / `OWNER_VOICE` (fresh OWNER result ≤10 s old) / `SENSITIVE`
     (stronger score margin **and** a liveness challenge **and** a second factor such as PIN/Windows Hello/phone tap).
     If liveness or second factor is not configured, SENSITIVE commands are **denied**.
  2. `ChallengeLiveness`: random digits the owner must speak; defeats pre-recorded replay (needs your own STT callable).
     Does **not** stop a real-time cloned-voice attacker.
  3. `ReplayGuard`: flags near-identical embeddings ≥15 s apart (exact re-play of one recording). Weak heuristic.
  4. Optional `SpoofDetector` hook (`verifier.spoof_detector`) for a dedicated anti-spoofing model (e.g. AASIST/RawNet2);
     not bundled — you must supply and evaluate one.
* Profile at rest: Windows DPAPI (user-bound), integrity hash, atomic writes, overwrite on reset. A voiceprint is
  biometric data; keep it local and don't commit it.

## Integrating with ERA (without modifying it)

`examples/era_agent_integration.py` shows `VoiceGuard`: one engine in the local-agent process, `start_monitoring()` to keep
`last_result` fresh, and `guard.check(command)` wrapped around the agent's dispatcher. Unknown commands default to the
strictest policy. Only the dict returned by the engine crosses the boundary, so ERA never touches embeddings.
For Antigravity: point it at this folder and ask it to wrap the agent's `/execute` handler with `execute(...)`.

## Performance

Design: model runs once per ~2 s of *new* speech (not per frame); input capped at 4 s; one model instance; VAD is numpy-only.
Measured here (sandbox, numpy VAD only): ~0.7 ms median per 3 s clip.
**Model latency, memory and GPU numbers were NOT measured** (the sandbox cannot download the model).
Run `python -m era_voice_identity benchmark` on your PC and record the output.

## Known limitations

* Not yet run against the real ECAPA model, a real microphone, or Windows DPAPI in the environment where this was built;
  first real-hardware run may need small fixes (SpeechBrain API versions differ — both import paths are handled).
* Default threshold is a starting point; short (~2–3 s) clips on laptop mics are noticeably less accurate than benchmark conditions.
* Similar voices (siblings), different mics, illness, and whispering will raise errors; enroll across conditions.
* Cosine similarity ≠ probability; `confidence` is an index only.
* No bundled anti-spoofing model; cloned/replayed audio can pass voice matching. Use the gate for anything sensitive.
* The built-in VAD is energy/spectral, not neural: loud non-speech with voice-like spectra (music, TV) can pass VAD,
  though it then still has to match the owner embedding. Swap in Silero VAD if you need more robustness.
* Overlapping speakers are not separated; a mid-utterance speaker change is caught at the next re-verification (~2 s).
