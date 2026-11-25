export type SecurityStrictness = 'balanced' | 'strict' | 'maximum';
export type UiLanguage = 'en' | 'hi';
export type VoiceGuardMode = 'online' | 'offline';

export type LockState =
  | 'UNENROLLED'
  | 'LOCKED_AWAITING_OWNER'
  | 'UNLOCKED_OWNER_VERIFIED'
  | 'LOCKED_INTRUDER_ALERT';

export type VerificationVerdict =
  | 'VERIFIED_OWNER'
  | 'INTRUDER_REJECTED'
  | 'SILENCE_OR_UNCLEAR'
  | 'SPOOF_DETECTED';

export interface VoiceprintFeatures {
  meanPitchHz: number;
  medianPitchHz: number;
  pitchStdHz: number;
  spectralCentroidHz: number;
  spectralRolloffHz: number;
  spectralFlatness: number;
  zeroCrossingRate: number;
  melProfile: number[]; // 24 normalized log Mel bands
  mfccMean: number[]; // 13 MFCC coefficients
  mfccStd: number[];
  voicedDurationSec: number;
  totalDurationSec: number;
  rmsEnergy: number;
  snrDb: number;
  voicedFrameCount: number;
}

export interface EnrolledSample {
  id: string;
  phrase: string;
  wavBase64: string;
  durationSec: number;
  features: VoiceprintFeatures;
  recordedAt: string;
}

export interface OwnerProfile {
  ownerName: string;
  passphrase: string;
  backupPin: string;
  enrolledAt: string;
  samples: EnrolledSample[];
  centroidFeatures: VoiceprintFeatures;
  consistencyScore: number;
}

export interface DspComparisonResult {
  overallScore: number; // 0 - 100
  mfccCosineScore: number; // 0 - 100
  melCosineScore: number; // 0 - 100
  pitchCompatibility: number; // 0 - 100
  timbreScore: number; // 0 - 100
  pitchDeltaHz: number;
  ownerMeanPitchHz: number;
  probeMeanPitchHz: number;
  voicedDurationSec: number;
  passed: boolean;
  failureReason: string | null;
}

export interface AiForensicAnalysis {
  isOwner: boolean;
  confidence: number;
  verdict: VerificationVerdict;
  transcript: string;
  languageDetected: string;
  pitchMatchSummary: string;
  timbreMatchSummary: string;
  voiceAnalysis: string;
  lockReason: string;
  spoofRisk: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface VerificationResponse {
  finalVerdict: VerificationVerdict;
  isVerifiedOwner: boolean;
  systemLocked: boolean;
  combinedConfidence: number;
  dspComparison: DspComparisonResult;
  aiForensics: AiForensicAnalysis;
  timestamp: string;
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  verdict: VerificationVerdict;
  isVerifiedOwner: boolean;
  combinedConfidence: number;
  dspScore: number;
  aiConfidence: number;
  pitchDeltaHz: number;
  probePitchHz: number;
  transcript: string;
  analysis: string;
  source: 'microphone' | 'auto_guard' | 'audio_upload';
}

export interface VaultItem {
  id: string;
  title: string;
  category: string;
  secretContent: string;
  updatedAt: string;
}
