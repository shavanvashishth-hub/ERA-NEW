import type { AuditLogEntry, OwnerProfile, SecurityStrictness, UiLanguage, VaultItem, VoiceGuardMode } from './types';

const DB_NAME = 'voiceguard_biometric_db';
const DB_VERSION = 1;
const STORE_PROFILE = 'owner_profile';

const AUDIT_STORAGE_KEY = 'voiceguard_audit_log_v1';
const VAULT_STORAGE_KEY = 'voiceguard_vault_v1';
const PREFS_STORAGE_KEY = 'voiceguard_prefs_v1';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PROFILE)) {
        db.createObjectStore(STORE_PROFILE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveOwnerProfile(profile: OwnerProfile): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROFILE, 'readwrite');
    const store = tx.objectStore(STORE_PROFILE);
    store.put(profile, 'active_owner');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadOwnerProfile(): Promise<OwnerProfile | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROFILE, 'readonly');
    const store = tx.objectStore(STORE_PROFILE);
    const req = store.get('active_owner');
    req.onsuccess = () => resolve((req.result as OwnerProfile) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function clearOwnerProfile(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROFILE, 'readwrite');
    const store = tx.objectStore(STORE_PROFILE);
    store.delete('active_owner');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function loadAuditLog(): AuditLogEntry[] {
  try {
    const raw = localStorage.getItem(AUDIT_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AuditLogEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveAuditLog(entries: AuditLogEntry[]): void {
  try {
    localStorage.setItem(AUDIT_STORAGE_KEY, JSON.stringify(entries.slice(0, 100)));
  } catch {
    // Ignore storage quota issues
  }
}

export function loadVaultItems(): VaultItem[] {
  try {
    const raw = localStorage.getItem(VAULT_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as VaultItem[];
  } catch {
    // fallback to default seed
  }
  const initial: VaultItem[] = [
    {
      id: 'vault-1',
      title: 'Primary Master Recovery Code',
      category: 'Access Credential',
      secretContent: 'VG-OWNER-9482-KILO-ALPHA (Protected by VoiceLock)',
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'vault-2',
      title: 'Private Owner Directive',
      category: 'Confidential Note',
      secretContent: 'Only the enrolled voiceprint holder can read or modify entries inside this vault.',
      updatedAt: new Date().toISOString(),
    },
  ];
  saveVaultItems(initial);
  return initial;
}

export function saveVaultItems(items: VaultItem[]): void {
  try {
    localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Ignore storage quota issues
  }
}

export interface UserPrefs {
  strictness: SecurityStrictness;
  language: UiLanguage;
  muted: boolean;
  mode?: VoiceGuardMode;
}

export function loadPrefs(): UserPrefs {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        strictness: parsed.strictness || 'strict',
        language: parsed.language || 'en',
        muted: Boolean(parsed.muted),
        mode: parsed.mode === 'offline' ? 'offline' : 'online',
      };
    }
  } catch {
    // ignore
  }
  return { strictness: 'strict', language: 'en', muted: false, mode: 'online' };
}

export function savePrefs(prefs: UserPrefs): void {
  try {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}
