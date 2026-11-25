import { useState } from 'react';
import { Volume2, RotateCcw, Trash2, Lock, KeyRound } from 'lucide-react';
import type { LockState, OwnerProfile } from '../types';

interface VoiceprintProfileProps {
  ownerProfile: OwnerProfile;
  lockState: LockState;
  onStartReEnroll: () => void;
  onResetProfile: () => void;
  onPinUnlock: (pin: string) => boolean;
}

export function VoiceprintProfile({
  ownerProfile,
  lockState,
  onStartReEnroll,
  onResetProfile,
  onPinUnlock,
}: VoiceprintProfileProps) {
  const [showPinGate, setShowPinGate] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<'reenroll' | 'reset' | null>(null);

  const isLocked = lockState !== 'UNLOCKED_OWNER_VERIFIED';

  const playClip = (base64: string) => {
    const audio = new Audio(`data:audio/wav;base64,${base64}`);
    void audio.play();
  };

  const requestSensitiveAction = (action: 'reenroll' | 'reset') => {
    if (!isLocked) {
      if (action === 'reenroll') onStartReEnroll();
      else onResetProfile();
      return;
    }
    setPendingAction(action);
    setShowPinGate(true);
    setPinError(null);
  };

  const handlePinConfirm = (e: React.FormEvent) => {
    e.preventDefault();
    const ok = onPinUnlock(pinInput.trim());
    if (!ok) {
      setPinError('Invalid Emergency Owner PIN. Voiceprint changes remain locked.');
      return;
    }
    setShowPinGate(false);
    setPinInput('');
    if (pendingAction === 'reenroll') onStartReEnroll();
    else if (pendingAction === 'reset') onResetProfile();
    setPendingAction(null);
  };

  const { centroidFeatures } = ownerProfile;
  const maxMfccAbs = Math.max(1, ...centroidFeatures.mfccMean.map((v) => Math.abs(v)));

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold text-slate-100">
            Owner Biometric Profile · {ownerProfile.ownerName}
          </h2>
          <p className="text-xs font-mono text-slate-400">
            Enrolled {new Date(ownerProfile.enrolledAt).toLocaleString()} · Consistency{' '}
            {ownerProfile.consistencyScore}%
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => requestSensitiveAction('reenroll')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-200 border border-slate-700 rounded-md hover:bg-slate-800 transition-colors whitespace-nowrap"
          >
            {isLocked ? <Lock className="w-3.5 h-3.5 text-amber-400" /> : <RotateCcw className="w-3.5 h-3.5" />}
            Re-Enroll Voice
          </button>
          <button
            type="button"
            onClick={() => requestSensitiveAction('reset')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-rose-300 border border-rose-500/30 rounded-md hover:bg-rose-950/40 transition-colors whitespace-nowrap"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete Profile
          </button>
        </div>
      </div>

      {showPinGate && (
        <form
          onSubmit={handlePinConfirm}
          className="border border-amber-500/40 bg-amber-950/20 p-5 rounded-lg flex flex-wrap items-center justify-between gap-4"
        >
          <div className="flex items-center gap-3 text-xs text-amber-200">
            <KeyRound className="w-4 h-4 shrink-0" />
            <span>
              System is currently locked. Enter your 4-digit Emergency Owner PIN to modify or re-enroll the voiceprint.
            </span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value.replace(/\D/g, '').slice(0, 4))}
              placeholder="PIN"
              className="w-24 px-3 py-1.5 text-sm font-mono bg-[#07090E] border border-slate-700 rounded-md text-slate-100 focus:outline-none focus:border-cyan-500"
            />
            <button
              type="submit"
              className="px-3.5 py-1.5 text-xs font-semibold bg-amber-400 text-slate-950 rounded-md hover:bg-amber-300 transition-colors whitespace-nowrap"
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={() => setShowPinGate(false)}
              className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
          </div>
          {pinError && <p className="w-full text-xs text-rose-400">{pinError}</p>}
        </form>
      )}

      {/* Key Acoustic Measurements */}
      <div className="grid grid-cols-2 md:grid-cols-4 border border-slate-800 bg-[#0F141D] rounded-lg divide-y md:divide-y-0 md:divide-x divide-slate-800 tabular-nums">
        <div className="p-5">
          <p className="text-xs text-slate-400">Median Pitch (F0)</p>
          <p className="mt-1 text-2xl font-mono font-semibold text-cyan-400">
            {centroidFeatures.medianPitchHz} <span className="text-xs text-slate-500">Hz</span>
          </p>
        </div>
        <div className="p-5">
          <p className="text-xs text-slate-400">Spectral Centroid</p>
          <p className="mt-1 text-2xl font-mono font-semibold text-slate-100">
            {centroidFeatures.spectralCentroidHz} <span className="text-xs text-slate-500">Hz</span>
          </p>
        </div>
        <div className="p-5">
          <p className="text-xs text-slate-400">85% Spectral Rolloff</p>
          <p className="mt-1 text-2xl font-mono font-semibold text-slate-100">
            {centroidFeatures.spectralRolloffHz} <span className="text-xs text-slate-500">Hz</span>
          </p>
        </div>
        <div className="p-5">
          <p className="text-xs text-slate-400">Signal-to-Noise</p>
          <p className="mt-1 text-2xl font-mono font-semibold text-emerald-400">
            {centroidFeatures.snrDb} <span className="text-xs text-slate-500">dB</span>
          </p>
        </div>
      </div>

      {/* 13-Coefficient MFCC Acoustic Signature */}
      <div className="border border-slate-800 bg-[#0F141D] rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-100">13-Coefficient MFCC Vocal Tract Signature</h3>
          <span className="text-xs font-mono text-slate-500">Cepstral Envelope (c1–c13)</span>
        </div>

        <div className="grid grid-cols-13 gap-2 h-36 items-end pt-4 border-t border-slate-800/80">
          {centroidFeatures.mfccMean.map((val, idx) => {
            const pct = Math.max(8, Math.round((Math.abs(val) / maxMfccAbs) * 100));
            return (
              <div key={idx} className="flex flex-col items-center gap-1.5 h-full justify-end">
                <div
                  className={`w-full rounded-sm ${val >= 0 ? 'bg-cyan-500/80' : 'bg-indigo-400/70'}`}
                  style={{ height: `${pct}%` }}
                  title={`MFCC c${idx + 1}: ${val.toFixed(2)}`}
                />
                <span className="text-[10px] font-mono text-slate-500">c{idx + 1}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Enrolled Audio Reference Clips */}
      <div className="border border-slate-800 bg-[#0F141D] rounded-lg divide-y divide-slate-800">
        <div className="px-5 py-3.5 text-sm font-semibold text-slate-100">
          Enrolled Reference Voice Clips
        </div>
        {ownerProfile.samples.map((sample, idx) => (
          <div key={sample.id} className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="text-xs font-mono text-slate-400">
                Sample 0{idx + 1} · {sample.durationSec.toFixed(1)}s · F0 {sample.features.medianPitchHz} Hz
              </div>
              <p className="text-sm text-slate-200">“{sample.phrase}”</p>
            </div>

            <button
              type="button"
              onClick={() => playClip(sample.wavBase64)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-300 border border-slate-700 rounded-md hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
            >
              <Volume2 className="w-3.5 h-3.5" />
              Play Reference
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
