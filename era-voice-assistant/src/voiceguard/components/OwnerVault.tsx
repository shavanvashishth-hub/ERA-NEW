import { useState } from 'react';
import { Lock, ShieldCheck, Plus, Trash2, Copy, Check, KeyRound } from 'lucide-react';
import { copy } from '../i18n';
import type { LockState, OwnerProfile, UiLanguage, VaultItem } from '../types';

interface OwnerVaultProps {
  language: UiLanguage;
  lockState: LockState;
  ownerProfile: OwnerProfile;
  vaultItems: VaultItem[];
  onAddItem: (title: string, category: string, secretContent: string) => void;
  onDeleteItem: (id: string) => void;
  onGoToVerify: () => void;
  onPinUnlock: (pin: string) => boolean;
  onLockNow: () => void;
}

export function OwnerVault({
  language,
  lockState,
  ownerProfile,
  vaultItems,
  onAddItem,
  onDeleteItem,
  onGoToVerify,
  onPinUnlock,
  onLockNow,
}: OwnerVaultProps) {
  const t = copy[language];
  const isUnlocked = lockState === 'UNLOCKED_OWNER_VERIFIED';

  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('Access Credential');
  const [secretContent, setSecretContent] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showPinBox, setShowPinBox] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      // ignore
    }
  };

  const handlePinSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPinError(null);
    const ok = onPinUnlock(pinInput.trim());
    if (!ok) {
      setPinError(language === 'hi' ? 'Galat PIN. Dubara koshish karein.' : 'Incorrect Emergency Owner PIN.');
    } else {
      setPinInput('');
      setShowPinBox(false);
    }
  };

  if (!isUnlocked) {
    const isIntruder = lockState === 'LOCKED_INTRUDER_ALERT';
    return (
      <div className="max-w-3xl mx-auto px-6 py-14">
        <div
          className={`border rounded-lg p-8 space-y-6 ${
            isIntruder
              ? 'border-rose-500/40 bg-rose-950/20'
              : 'border-slate-800 bg-[#0F141D]'
          }`}
        >
          <div className="flex items-start gap-4">
            <div
              className={`p-3 rounded-md border ${
                isIntruder
                  ? 'border-rose-500/40 bg-rose-500/10 text-rose-400'
                  : 'border-amber-500/30 bg-amber-500/10 text-amber-400'
              }`}
            >
              <Lock className="w-6 h-6" />
            </div>
            <div className="space-y-1.5">
              <h2 className="text-xl font-semibold text-slate-100">
                {isIntruder ? t.intruderAlertTitle : t.vaultLockedTitle}
              </h2>
              <p className="text-sm text-slate-400 leading-relaxed">{t.vaultLockedDesc}</p>
              <p className="text-xs font-mono text-slate-500">
                Enrolled Owner: {ownerProfile.ownerName} · Protected Items: {vaultItems.length}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-slate-800/80">
            <button
              type="button"
              onClick={onGoToVerify}
              className="px-4 py-2 text-xs font-semibold bg-cyan-500 text-slate-950 rounded-md hover:bg-cyan-400 transition-colors whitespace-nowrap shrink-0"
            >
              {language === 'hi' ? 'Owner Voice Verify Karein' : 'Verify Owner Voice'}
            </button>

            <button
              type="button"
              onClick={() => setShowPinBox((v) => !v)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-slate-300 border border-slate-700 rounded-md hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
            >
              <KeyRound className="w-3.5 h-3.5" />
              {t.unlockWithPin}
            </button>
          </div>

          {showPinBox && (
            <form onSubmit={handlePinSubmit} className="pt-3 border-t border-slate-800/80 flex flex-wrap items-center gap-3">
              <input
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="4-digit PIN"
                className="w-36 px-3 py-2 text-sm font-mono bg-[#07090E] border border-slate-700 rounded-md text-slate-100 focus:outline-none focus:border-cyan-500"
              />
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold bg-slate-200 text-slate-950 rounded-md hover:bg-white transition-colors whitespace-nowrap shrink-0"
              >
                Unlock via PIN
              </button>
              {pinError && <span className="text-xs text-rose-400">{pinError}</span>}
            </form>
          )}
        </div>
      </div>
    );
  }

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !secretContent.trim()) return;
    onAddItem(title.trim(), category.trim() || 'Secret', secretContent.trim());
    setTitle('');
    setSecretContent('');
  };

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-emerald-400 text-xs font-mono">
            <ShieldCheck className="w-4 h-4" />
            <span>OWNER BIOMETRIC SESSION ACTIVE · {ownerProfile.ownerName.toUpperCase()}</span>
          </div>
          <h2 className="text-xl font-semibold text-slate-100">Protected Owner Vault</h2>
        </div>

        <button
          type="button"
          onClick={onLockNow}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold border border-slate-700 text-slate-200 rounded-md hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
        >
          <Lock className="w-3.5 h-3.5" />
          {t.lockNow}
        </button>
      </div>

      {/* Add Protected Entry */}
      <form
        onSubmit={handleAdd}
        className="border border-slate-800 bg-[#0F141D] p-5 rounded-lg grid grid-cols-1 md:grid-cols-12 gap-4 items-end"
      >
        <label className="md:col-span-3 space-y-1.5 block">
          <span className="text-xs font-medium text-slate-300">Entry Title</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Server SSH Key"
            className="w-full px-3 py-2 text-sm bg-[#07090E] border border-slate-700 rounded-md text-slate-100 focus:outline-none focus:border-cyan-500"
          />
        </label>

        <label className="md:col-span-3 space-y-1.5 block">
          <span className="text-xs font-medium text-slate-300">Category</span>
          <input
            type="text"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-[#07090E] border border-slate-700 rounded-md text-slate-100 focus:outline-none focus:border-cyan-500"
          />
        </label>

        <label className="md:col-span-4 space-y-1.5 block">
          <span className="text-xs font-medium text-slate-300">Protected Value / Note</span>
          <input
            type="text"
            value={secretContent}
            onChange={(e) => setSecretContent(e.target.value)}
            placeholder="Confidential value..."
            className="w-full px-3 py-2 text-sm bg-[#07090E] border border-slate-700 rounded-md text-slate-100 focus:outline-none focus:border-cyan-500"
          />
        </label>

        <div className="md:col-span-2">
          <button
            type="submit"
            className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold bg-emerald-500 text-slate-950 rounded-md hover:bg-emerald-400 transition-colors whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            Save Entry
          </button>
        </div>
      </form>

      {/* Vault Entries */}
      <div className="border border-slate-800 bg-[#0F141D] rounded-lg divide-y divide-slate-800">
        {vaultItems.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            Vault is empty. Add a protected note or credential above.
          </div>
        ) : (
          vaultItems.map((item) => (
            <div key={item.id} className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="space-y-1 min-w-0">
                <div className="flex items-center gap-2 text-xs font-mono text-slate-400">
                  <span className="text-slate-300 font-medium font-sans">{item.title}</span>
                  <span aria-hidden="true">·</span>
                  <span>{item.category}</span>
                </div>
                <p className="text-sm font-mono text-emerald-300 break-all">{item.secretContent}</p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => void handleCopy(item.id, item.secretContent)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-300 border border-slate-700 rounded-md hover:bg-slate-800 transition-colors whitespace-nowrap"
                >
                  {copiedId === item.id ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedId === item.id ? 'Copied' : 'Copy'}
                </button>
                <button
                  type="button"
                  onClick={() => onDeleteItem(item.id)}
                  className="p-2 text-slate-400 hover:text-rose-400 border border-slate-800 hover:border-rose-500/40 rounded-md transition-colors"
                  aria-label="Delete entry"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
