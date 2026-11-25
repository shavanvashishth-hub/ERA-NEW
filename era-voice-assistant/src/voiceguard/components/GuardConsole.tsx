import { useRef, useState } from 'react';
import { Mic, Square, Radio, Upload, ShieldCheck, ShieldAlert, Lock, Loader2, ArrowRight } from 'lucide-react';
import { AcousticVisualizer } from './AcousticVisualizer';
import { useVoiceCapture, type CapturedVoiceClip } from '../useVoiceCapture';
import {
  TARGET_SAMPLE_RATE,
  compareVoiceprints,
  decodeAudioFileTo16kPcm,
  encodeWavBase64,
  extractVoiceprintFromPcm,
} from '../audioBiometrics';
import { copy } from '../i18n';
import type {
  LockState,
  OwnerProfile,
  SecurityStrictness,
  UiLanguage,
  VerificationResponse,
} from '../types';

interface GuardConsoleProps {
  language: UiLanguage;
  strictness: SecurityStrictness;
  lockState: LockState;
  ownerProfile: OwnerProfile;
  lastResult: VerificationResponse | null;
  isVerifying: boolean;
  verifyError: string | null;
  mode?: 'online' | 'offline';
  onToggleMode?: (mode: 'online' | 'offline') => void;
  onVerifyClip: (clip: CapturedVoiceClip, source: 'microphone' | 'auto_guard' | 'audio_upload') => Promise<void>;
  onOpenVault: () => void;
  onLockNow: () => void;
}

export function GuardConsole({
  language,
  strictness,
  lockState,
  ownerProfile,
  lastResult,
  isVerifying,
  verifyError,
  mode = 'online',
  onToggleMode,
  onVerifyClip,
  onOpenVault,
  onLockNow,
}: GuardConsoleProps) {
  const t = copy[language];
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const {
    isRecordingManual,
    isAutoGuardActive,
    vadSpeaking,
    livePitchHz,
    liveRmsDb,
    micError,
    analyser,
    startManualRecording,
    stopManualRecording,
    startAutoGuard,
    stopAutoGuard,
  } = useVoiceCapture({
    paused: isVerifying,
    onAutoUtterance: (clip) => {
      void onVerifyClip(clip, 'auto_guard');
    },
  });

  const handleManualToggle = async () => {
    setUploadError(null);
    if (isRecordingManual) {
      const clip = stopManualRecording();
      if (clip) {
        await onVerifyClip(clip, 'microphone');
      }
    } else {
      await startManualRecording();
    }
  };

  const handleAutoGuardToggle = async () => {
    setUploadError(null);
    if (isAutoGuardActive) {
      stopAutoGuard();
    } else {
      await startAutoGuard();
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadError(null);

    try {
      const samples16k = await decodeAudioFileTo16kPcm(file);
      const wavBase64 = encodeWavBase64(samples16k, TARGET_SAMPLE_RATE);
      const features = extractVoiceprintFromPcm(samples16k, TARGET_SAMPLE_RATE);
      const clip: CapturedVoiceClip = {
        samples16k,
        wavBase64,
        features,
        durationSec: Number((samples16k.length / TARGET_SAMPLE_RATE).toFixed(2)),
      };
      await onVerifyClip(clip, 'audio_upload');
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Unable to decode uploaded audio file.');
    }
  };

  const isIntruderLocked = lockState === 'LOCKED_INTRUDER_ALERT';
  const isOwnerVerified = lockState === 'UNLOCKED_OWNER_VERIFIED';

  // Live preview of DSP comparison when lastResult exists
  const dsp = lastResult?.dspComparison;
  const ai = lastResult?.aiForensics;

  const dspPreviewCheck = dsp
    ? dsp
    : compareVoiceprints(ownerProfile.centroidFeatures, ownerProfile.centroidFeatures, strictness);

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      {/* Left 7 Columns: Acoustic Stage & Primary Verification Controls */}
      <div className="lg:col-span-7 space-y-5">
        {/* Dominant State Banner */}
        <div
          className={`border rounded-lg p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 ${
            mode === 'offline'
              ? 'border-amber-500/40 bg-amber-950/20'
              : isIntruderLocked
              ? 'border-rose-500/50 bg-rose-950/25'
              : isOwnerVerified
                ? 'border-emerald-500/40 bg-emerald-950/20'
                : 'border-slate-800 bg-[#0F141D]'
          }`}
        >
          <div className="flex items-start gap-3.5 min-w-0">
            <div
              className={`p-2.5 rounded-md border shrink-0 ${
                mode === 'offline'
                  ? 'border-amber-500/40 bg-amber-500/15 text-amber-400'
                  : isIntruderLocked
                  ? 'border-rose-500/40 bg-rose-500/15 text-rose-400'
                  : isOwnerVerified
                    ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-400'
                    : 'border-amber-500/30 bg-amber-500/10 text-amber-400'
              }`}
            >
              {mode === 'offline' ? (
                <ShieldAlert className="w-5 h-5" />
              ) : isIntruderLocked ? (
                <ShieldAlert className="w-5 h-5" />
              ) : isOwnerVerified ? (
                <ShieldCheck className="w-5 h-5" />
              ) : (
                <Lock className="w-5 h-5" />
              )}
            </div>
            <div className="space-y-1 min-w-0">
              <h1 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                {mode === 'offline' ? (
                  <>
                    <span>VoiceGuard OFFLINE</span>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                      Open Access Mode
                    </span>
                  </>
                ) : isIntruderLocked ? (
                  t.intruderAlertTitle
                ) : isOwnerVerified ? (
                  t.ownerVerifiedTitle
                ) : (
                  t.awaitingTitle
                )}
              </h1>
              <p className="text-xs text-slate-400 leading-relaxed">
                {mode === 'offline'
                  ? 'Voice biometric verification is OFFLINE. Commands from all speakers will execute immediately without voice verification, exactly as ERA operated before.'
                  : isIntruderLocked
                  ? ai?.lockReason || t.intruderAlertSub
                  : isOwnerVerified
                    ? `Verified speaker: ${ownerProfile.ownerName}. Any subsequent non-owner voice will immediately re-lock the system.`
                    : `System enforces strict owner-only access for ${ownerProfile.ownerName} (${ownerProfile.centroidFeatures.medianPitchHz} Hz baseline).`}
              </p>
            </div>
          </div>

          {mode === 'offline' ? (
            onToggleMode && (
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => onToggleMode('online')}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-emerald-500 text-slate-950 rounded-md hover:bg-emerald-400 transition-colors whitespace-nowrap cursor-pointer"
                >
                  <ShieldCheck className="w-4 h-4" /> Enable Online Guard
                </button>
              </div>
            )
          ) : isOwnerVerified ? (
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={onOpenVault}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-emerald-500 text-slate-950 rounded-md hover:bg-emerald-400 transition-colors whitespace-nowrap"
              >
                Open Vault
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={onLockNow}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-slate-700 bg-slate-800 text-slate-200 rounded-md hover:bg-slate-700 transition-colors"
              >
                <Lock className="w-3.5 h-3.5" /> Lock
              </button>
            </div>
          ) : isIntruderLocked ? (
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleManualToggle}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-rose-500 text-white rounded-md hover:bg-rose-400 transition-colors whitespace-nowrap"
              >
                <Mic className="w-4 h-4" /> Verify Owner
              </button>
            </div>
          ) : null}
        </div>

        {/* Live Acoustic Waveform Analyzer */}
        <AcousticVisualizer
          analyser={analyser}
          isActive={isRecordingManual || isAutoGuardActive}
          lockState={lockState}
          livePitchHz={livePitchHz}
          liveRmsDb={liveRmsDb}
          vadSpeaking={vadSpeaking}
        />

        {(micError || verifyError || uploadError) && (
          <div className="border border-rose-500/40 bg-rose-950/30 px-4 py-3 rounded-lg text-xs text-rose-200">
            {micError || verifyError || uploadError}
          </div>
        )}

        {/* Primary Action Controls */}
        <div className="border border-slate-800 bg-[#0F141D] rounded-lg divide-y divide-slate-800">
          <div className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm font-medium text-slate-100">Manual Biometric Voice Scan</p>
              <p className="text-xs text-slate-400">
                {ownerProfile.passphrase
                  ? `Speak naturally (secret phrase: "${ownerProfile.passphrase}") for 2–4 seconds.`
                  : 'Speak any natural sentence in Hindi, Hinglish, or English for 2–4 seconds.'}
              </p>
            </div>

            <button
              type="button"
              disabled={isVerifying}
              onClick={() => void handleManualToggle()}
              className={`inline-flex items-center justify-center gap-2 px-5 py-2.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                isVerifying
                  ? 'bg-slate-700 text-slate-300 cursor-wait'
                  : isRecordingManual
                    ? 'bg-rose-600 text-white hover:bg-rose-500'
                    : 'bg-cyan-500 text-slate-950 hover:bg-cyan-400'
              }`}
            >
              {isVerifying ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t.verifyButtonAnalyzing}
                </>
              ) : isRecordingManual ? (
                <>
                  <Square className="w-3.5 h-3.5 fill-current" />
                  {t.verifyButtonRecording}
                </>
              ) : (
                <>
                  <Mic className="w-4 h-4" />
                  {t.verifyButtonIdle}
                </>
              )}
            </button>
          </div>

          <div className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium text-slate-100">{t.autoGuardLabel}</p>
                {isAutoGuardActive && (
                  <span className="text-xs font-mono text-cyan-400">· Monitoring Mic</span>
                )}
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">{t.autoGuardDesc}</p>
            </div>

            <button
              type="button"
              disabled={isRecordingManual}
              onClick={() => void handleAutoGuardToggle()}
              className={`inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                isAutoGuardActive
                  ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500/25'
                  : 'border-slate-700 bg-[#07090E] text-slate-300 hover:bg-slate-800'
              } disabled:opacity-40`}
            >
              <Radio className="w-3.5 h-3.5" />
              {isAutoGuardActive ? 'Stop Auto-Guard' : 'Enable Auto-Guard'}
            </button>
          </div>

          <div className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm font-medium text-slate-100">{t.uploadTestLabel}</p>
              <p className="text-xs text-slate-400">
                Upload another speaker&apos;s audio (.wav, .mp3, .webm) to verify instant intruder rejection and lock behavior.
              </p>
            </div>

            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*"
                onChange={(e) => void handleFileUpload(e)}
                className="hidden"
              />
              <button
                type="button"
                disabled={isVerifying || isRecordingManual}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium border border-slate-700 bg-[#07090E] text-slate-300 rounded-md hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 disabled:opacity-40"
              >
                <Upload className="w-3.5 h-3.5" />
                Select Audio Clip
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Right 5 Columns: Real-Time Dual-Gate Forensic Telemetry */}
      <div className="lg:col-span-5 border border-slate-800 bg-[#0F141D] rounded-lg divide-y divide-slate-800">
        <div className="px-5 py-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-100">Forensic Verification Telemetry</h2>
          <span className="text-xs font-mono text-slate-400 tabular-nums">
            Mode: {strictness === 'maximum' ? 'Maximum' : 'Strict'}
          </span>
        </div>

        {!lastResult ? (
          <div className="p-6 space-y-4">
            <p className="text-sm text-slate-400 leading-relaxed">
              No voice probe scanned in this session yet. Speak using the microphone or enable Continuous Auto-Guard to run real-time owner vs. intruder detection.
            </p>
            <div className="border-t border-slate-800 pt-4 space-y-2 text-xs font-mono text-slate-500 tabular-nums">
              <div className="flex justify-between">
                <span>Enrolled Owner</span>
                <span className="text-slate-300">{ownerProfile.ownerName}</span>
              </div>
              <div className="flex justify-between">
                <span>Baseline Pitch (F0)</span>
                <span className="text-slate-300">{ownerProfile.centroidFeatures.medianPitchHz} Hz</span>
              </div>
              <div className="flex justify-between">
                <span>Spectral Centroid</span>
                <span className="text-slate-300">{ownerProfile.centroidFeatures.spectralCentroidHz} Hz</span>
              </div>
              <div className="flex justify-between">
                <span>Calibration Consistency</span>
                <span className="text-slate-300">{ownerProfile.consistencyScore}%</span>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Summary Score Row */}
            <div className="p-5 grid grid-cols-3 gap-4 tabular-nums">
              <div>
                <p className="text-xs text-slate-400">Verdict</p>
                <p
                  className={`mt-1 text-sm font-mono font-semibold ${
                    lastResult.isVerifiedOwner ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {lastResult.isVerifiedOwner ? 'OWNER' : 'REJECTED'}
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-400">Combined Match</p>
                <p className="mt-1 text-xl font-mono font-semibold text-slate-100">
                  {lastResult.combinedConfidence}%
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-400">System State</p>
                <p
                  className={`mt-1 text-sm font-mono font-semibold ${
                    lastResult.systemLocked ? 'text-rose-400' : 'text-emerald-400'
                  }`}
                >
                  {lastResult.systemLocked ? 'LOCKED' : 'OPEN'}
                </p>
              </div>
            </div>

            {/* Acoustic DSP Gate Metrics */}
            <div className="p-5 space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-slate-300">01. Acoustic DSP Gate</span>
                <span
                  className={`font-mono ${
                    dspPreviewCheck.passed ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {dspPreviewCheck.passed ? 'PASS' : 'FAIL'} · {dspPreviewCheck.overallScore}%
                </span>
              </div>

              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs font-mono tabular-nums pt-1">
                <div className="flex justify-between text-slate-400">
                  <span>Probe F0</span>
                  <span className="text-slate-200">{dspPreviewCheck.probeMeanPitchHz} Hz</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Pitch Delta</span>
                  <span className="text-slate-200">{dspPreviewCheck.pitchDeltaHz} Hz</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Pitch Match</span>
                  <span className="text-slate-200">{dspPreviewCheck.pitchCompatibility}%</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>MFCC Cosine</span>
                  <span className="text-slate-200">{dspPreviewCheck.mfccCosineScore}%</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Formant Timbre</span>
                  <span className="text-slate-200">{dspPreviewCheck.timbreScore}%</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Voiced Speech</span>
                  <span className="text-slate-200">{dspPreviewCheck.voicedDurationSec}s</span>
                </div>
              </div>
            </div>

            {/* AI Multimodal Forensics */}
            {ai && (
              <div className="p-5 space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-slate-300">02. Multimodal Audio AI Gate</span>
                  <span className={`font-mono ${ai.isOwner ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {ai.verdict} · {ai.confidence}%
                  </span>
                </div>

                <div className="space-y-2.5 text-xs">
                  <div>
                    <span className="text-slate-500">Captured Transcript ({ai.languageDetected}):</span>
                    <p className="mt-0.5 text-slate-200 font-medium">“{ai.transcript}”</p>
                  </div>
                  <div>
                    <span className="text-slate-500">Pitch &amp; Register:</span>
                    <p className="mt-0.5 text-slate-300">{ai.pitchMatchSummary}</p>
                  </div>
                  <div>
                    <span className="text-slate-500">Vocal Tract Timbre:</span>
                    <p className="mt-0.5 text-slate-300">{ai.timbreMatchSummary}</p>
                  </div>
                  <div>
                    <span className="text-slate-500">Forensic Conclusion:</span>
                    <p className="mt-0.5 text-slate-300 leading-relaxed">{ai.voiceAnalysis}</p>
                  </div>
                  <div className="flex items-center justify-between pt-1 text-slate-500 font-mono">
                    <span>Spoof / Replay Risk</span>
                    <span className={ai.spoofRisk === 'LOW' ? 'text-emerald-400' : 'text-rose-400'}>
                      {ai.spoofRisk}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
