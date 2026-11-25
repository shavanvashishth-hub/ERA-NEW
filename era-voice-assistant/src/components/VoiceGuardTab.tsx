import { useState } from 'react';
import {
  ShieldCheck,
  ShieldAlert,
  Lock,
  Mic,
  Activity,
  FileText,
  KeyRound,
  Sliders,
  Volume2,
  VolumeX,
  UserCheck,
  RotateCcw
} from 'lucide-react';
import { GuardConsole } from '../voiceguard/components/GuardConsole';
import { OwnerEnrollment } from '../voiceguard/components/OwnerEnrollment';
import { VoiceprintProfile } from '../voiceguard/components/VoiceprintProfile';
import { AuditLogView } from '../voiceguard/components/AuditLogView';
import { OwnerVault } from '../voiceguard/components/OwnerVault';
import { copy } from '../voiceguard/i18n';
import type {
  AuditLogEntry,
  LockState,
  OwnerProfile,
  SecurityStrictness,
  UiLanguage,
  VaultItem,
  VerificationResponse,
} from '../voiceguard/types';
import type { CapturedVoiceClip } from '../voiceguard/useVoiceCapture';

interface VoiceGuardTabProps {
  language: UiLanguage;
  setLanguage: (l: UiLanguage) => void;
  strictness: SecurityStrictness;
  setStrictness: (s: SecurityStrictness) => void;
  muted: boolean;
  setMuted: (m: boolean) => void;
  mode?: 'online' | 'offline';
  setMode?: (m: 'online' | 'offline') => void;
  onLockVoiceGuard?: () => void;
  ownerProfile: OwnerProfile | null;
  lockState: LockState;
  lastResult: VerificationResponse | null;
  isVerifying: boolean;
  verifyError: string | null;
  auditLog: AuditLogEntry[];
  vaultItems: VaultItem[];
  onEnrolled: (p: OwnerProfile) => Promise<void>;
  onResetProfile: () => Promise<void>;
  onLockNow: () => void;
  onPinUnlock: (pin: string) => boolean;
  onVerifyClip: (clip: CapturedVoiceClip, source: 'microphone' | 'auto_guard' | 'audio_upload') => Promise<void>;
  onAddItem: (title: string, category: string, secret: string) => void;
  onDeleteItem: (id: string) => void;
  onClearAuditLog: () => void;
}

export function VoiceGuardTab({
  language,
  setLanguage,
  strictness,
  setStrictness,
  muted,
  setMuted,
  mode = 'online',
  setMode,
  onLockVoiceGuard,
  ownerProfile,
  lockState,
  lastResult,
  isVerifying,
  verifyError,
  auditLog,
  vaultItems,
  onEnrolled,
  onResetProfile,
  onLockNow,
  onPinUnlock,
  onVerifyClip,
  onAddItem,
  onDeleteItem,
  onClearAuditLog,
}: VoiceGuardTabProps) {
  const [subTab, setSubTab] = useState<'console' | 'enrollment' | 'voiceprint' | 'audit' | 'vault'>(
    ownerProfile ? 'console' : 'enrollment'
  );

  const t = copy[language];

  const statusLabel =
    mode === 'offline'
      ? 'OFFLINE (Bypassed)'
      : lockState === 'UNLOCKED_OWNER_VERIFIED'
      ? t.statusVerified
      : lockState === 'LOCKED_INTRUDER_ALERT'
      ? t.statusIntruder
      : lockState === 'LOCKED_AWAITING_OWNER'
      ? t.statusAwaiting
      : t.statusUnenrolled;

  const statusBadgeColor =
    mode === 'offline'
      ? 'border-neutral-700 bg-neutral-800/80 text-neutral-300'
      : lockState === 'UNLOCKED_OWNER_VERIFIED'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
      : lockState === 'LOCKED_INTRUDER_ALERT'
      ? 'border-rose-500/30 bg-rose-500/10 text-rose-400 animate-pulse'
      : lockState === 'LOCKED_AWAITING_OWNER'
      ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
      : 'border-cyan-500/30 bg-cyan-500/10 text-cyan-400';

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4 md:p-6 text-neutral-200">
      {/* VoiceGuard Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-white/10 bg-[#14171c]/90 p-4 backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10 shadow-[0_0_20px_rgba(230,169,74,0.15)]">
            <ShieldCheck size={26} className="text-amber-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-semibold text-lg text-white tracking-wide">
                VoiceGuard AI <span className="text-xs font-mono px-2 py-0.5 rounded bg-white/10 text-neutral-300">v2.0 Biometric Gate</span>
              </h2>
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${statusBadgeColor}`}>
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
                {statusLabel}
              </span>
            </div>
            <p className="text-xs text-neutral-400">
              Zero-Trust Dual-Gate: DSP Acoustic Voiceprint + Multimodal Gemini Audio Verification. Locks ERA strictly to the owner's voice.
            </p>
          </div>
        </div>

        {/* Global Controls: Online/Offline, Strictness, Language, Audio Effects, Lock */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Online / Offline Switch */}
          <div className="flex items-center rounded-xl border border-white/10 bg-black/40 p-1 text-xs">
            <button
              onClick={() => setMode?.('online')}
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 transition-all cursor-pointer ${
                mode === 'online'
                  ? 'bg-emerald-500 font-bold text-black shadow-[0_0_15px_rgba(16,185,129,0.3)]'
                  : 'text-neutral-400 hover:text-white'
              }`}
              title="ONLINE: Voice biometric verification active. Only verified owner voice commands will execute."
            >
              <ShieldCheck size={13} />
              <span>ONLINE</span>
            </button>
            <button
              onClick={() => setMode?.('offline')}
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 transition-all cursor-pointer ${
                mode === 'offline'
                  ? 'bg-rose-500 font-bold text-white shadow-[0_0_15px_rgba(244,63,94,0.3)]'
                  : 'text-neutral-400 hover:text-white'
              }`}
              title="OFFLINE: Voice biometric verification disabled. ERA executes everyone's commands immediately."
            >
              <ShieldAlert size={13} />
              <span>OFFLINE</span>
            </button>
          </div>

          {/* Strictness Level Selector */}
          <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-black/40 p-1 text-xs">
            <span className="px-2 text-neutral-400 flex items-center gap-1">
              <Sliders size={12} /> Strictness:
            </span>
            <button
              onClick={() => setStrictness('balanced')}
              className={`rounded-lg px-2.5 py-1 transition-colors cursor-pointer ${
                strictness === 'balanced'
                  ? 'bg-amber-400 font-semibold text-black'
                  : 'text-neutral-400 hover:text-white'
              }`}
              title="Smooth owner recognition with balanced threshold (Recommended)"
            >
              Balanced
            </button>
            <button
              onClick={() => setStrictness('strict')}
              className={`rounded-lg px-2.5 py-1 transition-colors cursor-pointer ${
                strictness === 'strict'
                  ? 'bg-amber-400 font-semibold text-black'
                  : 'text-neutral-400 hover:text-white'
              }`}
              title="Strict speaker gating"
            >
              Strict
            </button>
            <button
              onClick={() => setStrictness('maximum')}
              className={`rounded-lg px-2.5 py-1 transition-colors cursor-pointer ${
                strictness === 'maximum'
                  ? 'bg-amber-400 font-semibold text-black'
                  : 'text-neutral-400 hover:text-white'
              }`}
              title="Maximum paranoid verification"
            >
              Max
            </button>
          </div>

          {/* Language Toggle */}
          <div className="flex items-center rounded-xl border border-white/10 bg-black/40 p-1 text-xs">
            <button
              onClick={() => setLanguage('en')}
              className={`rounded-lg px-2.5 py-1 transition-colors cursor-pointer ${
                language === 'en' ? 'bg-white/20 font-semibold text-white' : 'text-neutral-400 hover:text-white'
              }`}
            >
              EN
            </button>
            <button
              onClick={() => setLanguage('hi')}
              className={`rounded-lg px-2.5 py-1 transition-colors cursor-pointer ${
                language === 'hi' ? 'bg-white/20 font-semibold text-white' : 'text-neutral-400 hover:text-white'
              }`}
            >
              हिंदी
            </button>
          </div>

          {/* Mute/Sound Toggle */}
          <button
            onClick={() => setMuted(!muted)}
            className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-black/40 text-neutral-400 transition-colors hover:text-white cursor-pointer"
            title={muted ? 'Unmute VoiceGuard Alerts' : 'Mute VoiceGuard Alerts'}
          >
            {muted ? <VolumeX size={15} /> : <Volume2 size={15} className="text-amber-400" />}
          </button>

          {/* Lock VoiceGuard Button */}
          {onLockVoiceGuard && (
            <button
              onClick={onLockVoiceGuard}
              className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-black/40 px-3 py-1.5 text-xs font-mono text-neutral-300 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
              title="Lock VoiceGuard Console (Requires PIN 1234 to reopen)"
            >
              <Lock size={12} className="text-amber-400" />
              <span className="hidden sm:inline">Lock Guard</span>
            </button>
          )}
        </div>
      </div>

      {/* Online / Offline Mode Informational Banner */}
      {mode === 'offline' ? (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-200 backdrop-blur-md">
          <div className="flex items-center gap-2.5">
            <ShieldAlert size={18} className="text-amber-400 shrink-0 animate-pulse" />
            <div>
              <span className="font-bold text-amber-300">VoiceGuard is OFFLINE:</span> Voice biometric verification is completely bypassed. ERA will immediately execute all commands from anyone without voice verification, exactly as it operated before.
            </div>
          </div>
          <button
            onClick={() => setMode?.('online')}
            className="shrink-0 px-3 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-mono font-bold text-xs transition-colors cursor-pointer shadow-lg shadow-emerald-500/20"
          >
            Turn ONLINE
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-xs text-emerald-200 backdrop-blur-md">
          <div className="flex items-center gap-2.5">
            <ShieldCheck size={18} className="text-emerald-400 shrink-0" />
            <div>
              <span className="font-bold text-emerald-300">VoiceGuard is ONLINE:</span> Zero-Trust Biometric Gate active. Every voice command is strictly verified against your registered voiceprint centroid before execution.
            </div>
          </div>
          <span className="text-[11px] font-mono text-emerald-400/80 px-2 py-0.5 rounded bg-emerald-500/20 uppercase tracking-wider hidden sm:inline">
            Guarded & Active
          </span>
        </div>
      )}

      {/* VoiceGuard Sub-Navigation */}
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 pb-3">
        <button
          onClick={() => setSubTab('console')}
          className={`flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs transition-colors cursor-pointer ${
            subTab === 'console'
              ? 'bg-[#e6a94a] font-semibold text-[#1a1409]'
              : 'border border-white/10 bg-white/5 text-neutral-300 hover:bg-white/10'
          }`}
        >
          <Activity size={14} /> Guard Console & Telemetry
        </button>

        <button
          onClick={() => setSubTab('enrollment')}
          className={`flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs transition-colors cursor-pointer ${
            subTab === 'enrollment'
              ? 'bg-[#e6a94a] font-semibold text-[#1a1409]'
              : 'border border-white/10 bg-white/5 text-neutral-300 hover:bg-white/10'
          }`}
        >
          <Mic size={14} /> {ownerProfile ? 'Re-Enroll Owner Voice' : '🎙️ Enroll Owner Voice'}
        </button>

        <button
          onClick={() => setSubTab('voiceprint')}
          className={`flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs transition-colors cursor-pointer ${
            subTab === 'voiceprint'
              ? 'bg-[#e6a94a] font-semibold text-[#1a1409]'
              : 'border border-white/10 bg-white/5 text-neutral-300 hover:bg-white/10'
          }`}
        >
          <UserCheck size={14} /> Voiceprint Profile
        </button>

        <button
          onClick={() => setSubTab('audit')}
          className={`flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs transition-colors cursor-pointer ${
            subTab === 'audit'
              ? 'bg-[#e6a94a] font-semibold text-[#1a1409]'
              : 'border border-white/10 bg-white/5 text-neutral-300 hover:bg-white/10'
          }`}
        >
          <FileText size={14} /> Audit Logs ({auditLog.length})
        </button>

        <button
          onClick={() => setSubTab('vault')}
          className={`flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs transition-colors cursor-pointer ${
            subTab === 'vault'
              ? 'bg-[#e6a94a] font-semibold text-[#1a1409]'
              : 'border border-white/10 bg-white/5 text-neutral-300 hover:bg-white/10'
          }`}
        >
          <KeyRound size={14} /> Owner Vault ({vaultItems.length})
        </button>
      </div>

      {/* Main SubTab Panels */}
      <div className="flex-1">
        {subTab === 'console' && (
          ownerProfile ? (
            <GuardConsole
              language={language}
              strictness={strictness}
              lockState={lockState}
              ownerProfile={ownerProfile}
              lastResult={lastResult}
              isVerifying={isVerifying}
              verifyError={verifyError}
              mode={mode}
              onToggleMode={setMode}
              onVerifyClip={onVerifyClip}
              onOpenVault={() => setSubTab('vault')}
              onLockNow={onLockNow}
            />
          ) : (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-white/10 bg-[#14171c]/80 p-12 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-amber-500/30 bg-amber-500/10 mb-4 shadow-[0_0_30px_rgba(230,169,74,0.2)]">
                <Mic size={32} className="text-amber-400" />
              </div>
              <h3 className="text-xl font-semibold text-white mb-2">No Owner Voice Enrolled Yet</h3>
              <p className="max-w-md text-sm text-neutral-400 mb-6">
                Enroll your voice to create your unique biometric acoustic profile. Once enrolled, ERA will strictly obey only your commands and instantly reject anyone else!
              </p>
              <button
                onClick={() => setSubTab('enrollment')}
                className="flex items-center gap-2 rounded-xl bg-[#e6a94a] px-6 py-2.5 font-semibold text-[#1a1409] transition-transform hover:scale-105 cursor-pointer shadow-lg shadow-amber-500/20"
              >
                <Mic size={16} /> Start Voice Enrollment (3 Quick Samples)
              </button>
            </div>
          )
        )}

        {subTab === 'enrollment' && (
          <div className="rounded-2xl border border-white/10 bg-[#14171c]/80 p-6 backdrop-blur-xl">
            <OwnerEnrollment
              language={language}
              onEnrolled={async (p) => {
                await onEnrolled(p);
                setSubTab('console');
              }}
              onCancel={ownerProfile ? () => setSubTab('console') : undefined}
            />
          </div>
        )}

        {subTab === 'voiceprint' && (
          ownerProfile ? (
            <VoiceprintProfile
              ownerProfile={ownerProfile}
              lockState={lockState}
              onStartReEnroll={() => setSubTab('enrollment')}
              onResetProfile={onResetProfile}
              onPinUnlock={onPinUnlock}
            />
          ) : (
            <div className="rounded-2xl border border-white/10 bg-[#14171c]/80 p-8 text-center text-neutral-400">
              Please enroll your voice first to view your voiceprint biometric profile.
            </div>
          )
        )}

        {subTab === 'audit' && (
          <div className="rounded-2xl border border-white/10 bg-[#14171c]/80 p-6 backdrop-blur-xl">
            <AuditLogView
              entries={auditLog}
              isUnlocked={lockState === 'UNLOCKED_OWNER_VERIFIED'}
              onClearLog={onClearAuditLog}
            />
          </div>
        )}

        {subTab === 'vault' && (
          ownerProfile ? (
            <OwnerVault
              language={language}
              lockState={lockState}
              ownerProfile={ownerProfile}
              vaultItems={vaultItems}
              onAddItem={onAddItem}
              onDeleteItem={onDeleteItem}
              onGoToVerify={() => setSubTab('console')}
              onPinUnlock={onPinUnlock}
              onLockNow={onLockNow}
            />
          ) : (
            <div className="rounded-2xl border border-white/10 bg-[#14171c]/80 p-8 text-center text-neutral-400">
              Please enroll your voice first to access the VoiceGuard Vault.
            </div>
          )
        )}
      </div>
    </div>
  );
}
