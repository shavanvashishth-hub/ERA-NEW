import { useState } from 'react';
import { Mic, Square, RotateCcw, CheckCircle2, ShieldCheck, Volume2 } from 'lucide-react';
import { AcousticVisualizer } from './AcousticVisualizer';
import { useVoiceCapture } from '../useVoiceCapture';
import { computeOwnerCentroid } from '../audioBiometrics';
import { copy } from '../i18n';
import type { EnrolledSample, OwnerProfile, UiLanguage } from '../types';

interface OwnerEnrollmentProps {
  language: UiLanguage;
  onEnrolled: (profile: OwnerProfile) => void;
  onCancel?: () => void;
}

export function OwnerEnrollment({ language, onEnrolled, onCancel }: OwnerEnrollmentProps) {
  const t = copy[language];
  const [ownerName, setOwnerName] = useState('Owner');
  const [passphrase, setPassphrase] = useState('');
  const [backupPin, setBackupPin] = useState('1234');
  const [samples, setSamples] = useState<(EnrolledSample | null)[]>([null, null, null]);
  const [activeSlot, setActiveSlot] = useState<number | null>(null);
  const [sampleError, setSampleError] = useState<string | null>(null);

  const prompts = [t.samplePrompt1, t.samplePrompt2, t.samplePrompt3];

  const {
    isRecordingManual,
    vadSpeaking,
    livePitchHz,
    liveRmsDb,
    micError,
    analyser,
    startManualRecording,
    stopManualRecording,
  } = useVoiceCapture();

  const handleToggleRecord = async (slotIndex: number) => {
    setSampleError(null);
    if (isRecordingManual && activeSlot === slotIndex) {
      const clip = stopManualRecording();
      setActiveSlot(null);
      if (!clip) return;

      if (clip.features.voicedDurationSec < 0.65 || clip.features.voicedFrameCount < 15) {
        setSampleError(
          language === 'hi'
            ? 'Awaaz bahut chhoti ya slow thi. Kam se kam 1.5–3 seconds saaf bolein.'
            : 'Speech sample too short or quiet. Please speak clearly for 1.5–3 seconds.'
        );
        return;
      }

      const enrolled: EnrolledSample = {
        id: `sample-${slotIndex + 1}-${Date.now()}`,
        phrase: prompts[slotIndex],
        wavBase64: clip.wavBase64,
        durationSec: clip.durationSec,
        features: clip.features,
        recordedAt: new Date().toISOString(),
      };

      setSamples((prev) => {
        const next = [...prev];
        next[slotIndex] = enrolled;
        return next;
      });
    } else if (!isRecordingManual) {
      setActiveSlot(slotIndex);
      await startManualRecording();
    }
  };

  const playSample = (wavBase64: string) => {
    const audio = new Audio(`data:audio/wav;base64,${wavBase64}`);
    void audio.play();
  };

  const completedCount = samples.filter(Boolean).length;
  const allComplete = completedCount === 3;
  const cleanPin = backupPin.replace(/\D/g, '').slice(0, 4);

  const handleFinalize = () => {
    if (!allComplete) return;
    if (cleanPin.length !== 4) {
      setSampleError(
        language === 'hi'
          ? '4-digit Emergency Owner PIN daalein.'
          : 'Please enter a 4-digit Emergency Owner PIN.'
      );
      return;
    }

    const validSamples = samples as EnrolledSample[];
    const { centroid, consistencyScore } = computeOwnerCentroid(validSamples);

    const profile: OwnerProfile = {
      ownerName: ownerName.trim() || 'Owner',
      passphrase: passphrase.trim(),
      backupPin: cleanPin,
      enrolledAt: new Date().toISOString(),
      samples: validSamples,
      centroidFeatures: centroid,
      consistencyScore,
    };

    onEnrolled(profile);
  };

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-slate-800 pb-6">
        <div className="space-y-1.5 max-w-2xl">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100 text-balance">
            {t.enrollTitle}
          </h1>
          <p className="text-sm text-slate-400 leading-relaxed">{t.enrollSubtitle}</p>
        </div>
        <div className="flex items-center gap-4 text-xs font-mono text-slate-400 shrink-0 tabular-nums">
          <span>Samples: {completedCount}/3</span>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1.5 border border-slate-700 text-slate-300 rounded-md hover:bg-slate-800/70 transition-colors whitespace-nowrap shrink-0"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* Live Calibration Oscilloscope */}
      <AcousticVisualizer
        analyser={analyser}
        isActive={isRecordingManual}
        lockState="UNENROLLED"
        livePitchHz={livePitchHz}
        liveRmsDb={liveRmsDb}
        vadSpeaking={vadSpeaking}
      />

      {(micError || sampleError) && (
        <div className="border border-rose-500/40 bg-rose-950/30 px-4 py-3 rounded-lg text-sm text-rose-200">
          {micError || sampleError}
        </div>
      )}

      {/* Identity Configuration Inputs */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 border border-slate-800 bg-[#0F141D] p-5 rounded-lg">
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-slate-300">{t.ownerNameLabel}</span>
          <input
            type="text"
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
            maxLength={40}
            className="w-full px-3 py-2 text-sm bg-[#07090E] border border-slate-700 rounded-md text-slate-100 focus:outline-none focus:border-cyan-500"
          />
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-slate-300">{t.passphraseLabel}</span>
          <input
            type="text"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="Optional (leave blank for any speech)"
            maxLength={80}
            className="w-full px-3 py-2 text-sm bg-[#07090E] border border-slate-700 rounded-md text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500"
          />
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-slate-300">{t.pinLabel}</span>
          <input
            type="password"
            inputMode="numeric"
            value={backupPin}
            onChange={(e) => setBackupPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
            maxLength={4}
            className="w-full px-3 py-2 text-sm font-mono bg-[#07090E] border border-slate-700 rounded-md text-slate-100 focus:outline-none focus:border-cyan-500"
          />
        </label>
      </div>

      {/* 3-Sample Biometric Capture Rows */}
      <div className="border border-slate-800 bg-[#0F141D] rounded-lg divide-y divide-slate-800">
        {prompts.map((promptText, idx) => {
          const recorded = samples[idx];
          const isThisRecording = isRecordingManual && activeSlot === idx;
          const isOtherRecording = isRecordingManual && activeSlot !== idx;

          return (
            <div key={idx} className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div className="space-y-1.5 min-w-0">
                <div className="flex items-center gap-2 text-xs font-mono text-slate-400">
                  <span className="text-cyan-400">0{idx + 1}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {recorded
                      ? `Calibrated · ${recorded.durationSec.toFixed(1)}s · F0 ${recorded.features.medianPitchHz} Hz`
                      : 'Speak naturally for 2–4 seconds'}
                  </span>
                </div>
                <p className="text-sm text-slate-200 font-medium">“{promptText}”</p>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                {recorded && !isThisRecording && (
                  <button
                    type="button"
                    onClick={() => playSample(recorded.wavBase64)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-300 border border-slate-700 rounded-md hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                  >
                    <Volume2 className="w-3.5 h-3.5" />
                    Play
                  </button>
                )}

                <button
                  type="button"
                  disabled={isOtherRecording}
                  onClick={() => void handleToggleRecord(idx)}
                  className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    isThisRecording
                      ? 'bg-rose-600 text-white hover:bg-rose-500'
                      : recorded
                        ? 'bg-slate-800 text-emerald-300 border border-emerald-500/40 hover:bg-slate-700'
                        : 'bg-cyan-500 text-slate-950 hover:bg-cyan-400'
                  } disabled:opacity-40`}
                >
                  {isThisRecording ? (
                    <>
                      <Square className="w-3.5 h-3.5 fill-current" />
                      {t.stopRecording}
                    </>
                  ) : recorded ? (
                    <>
                      <RotateCcw className="w-3.5 h-3.5" />
                      {t.reRecord}
                    </>
                  ) : (
                    <>
                      <Mic className="w-3.5 h-3.5" />
                      {t.recordSample}
                    </>
                  )}
                </button>

                {recorded && !isThisRecording && (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Activation Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border border-slate-800 bg-[#0F141D] p-5 rounded-lg">
        <div className="text-xs text-slate-400 space-y-1">
          <p className="text-slate-200 font-medium">Zero-Trust Biometric Enforcement</p>
          <p>
            Once activated, all protected controls stay locked by default. Only your enrolled voice unlocks access; any other speaker triggers an immediate lockdown.
          </p>
        </div>

        <button
          type="button"
          disabled={!allComplete || isRecordingManual}
          onClick={handleFinalize}
          className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-md bg-emerald-500 text-slate-950 hover:bg-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0"
        >
          <ShieldCheck className="w-4 h-4" />
          {t.completeEnrollment}
        </button>
      </div>
    </div>
  );
}
