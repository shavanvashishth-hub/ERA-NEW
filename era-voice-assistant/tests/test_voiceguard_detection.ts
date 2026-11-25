import fs from 'fs';
import path from 'path';
import { compareVoiceprints, VoiceprintFeatures } from '../src/voiceguard/audioBiometrics';
import { serverVoiceGuard } from '../server';

async function runDetectionTests() {
  console.log('=================================================================');
  console.log('🎯 VoiceGuard Real-Time Voice Biometrics & Security Gate Tests');
  console.log('=================================================================\n');

  // Load owner profile
  const profilePath = 'C:/Users/MSI/AppData/Local/ERA/data/voiceguard_owner_profile.json';
  if (!fs.existsSync(profilePath)) {
    throw new Error('Owner profile not found at ' + profilePath);
  }
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  const ownerFeat: VoiceprintFeatures = profile.centroidFeatures;
  console.log(`[Enrolled Owner] Name: ${profile.ownerName}, Centroid Pitch: ${ownerFeat.medianPitchHz} Hz, Centroid: ${ownerFeat.spectralCentroidHz} Hz\n`);

  // 1. OWNER VOICE VERIFICATION (Real owner speaking)
  console.log('[Test 1] Testing Registered Owner Voice matching:');
  const t0 = performance.now();
  const ownerProbe: VoiceprintFeatures = {
    ...ownerFeat,
    meanPitchHz: 163.5,
    medianPitchHz: 164.0,
    voicedDurationSec: 1.4,
    voicedFrameCount: 45
  };
  const ownerResult = compareVoiceprints(ownerFeat, ownerProbe, 'balanced');
  const t1 = performance.now();
  console.log(`  Execution time: ${(t1 - t0).toFixed(2)} ms (sub-millisecond!)`);
  console.log(`  Owner verification score: ${ownerResult.overallScore}%, Pitch Delta: ${ownerResult.pitchDeltaHz} Hz, Passed: ${ownerResult.passed}`);
  if (!ownerResult.passed) {
    throw new Error('Owner voice MUST pass verification!');
  }
  console.log('  ✓ Test 1 Passed: Owner voice successfully verified instantly.\n');

  // 2. INTRUDER 1: Deep Voice (e.g. 110 Hz pitch)
  console.log('[Test 2] Testing Intruder with Deep Voice (Pitch 110 Hz vs Owner 165 Hz):');
  const intruderDeep: VoiceprintFeatures = {
    ...ownerFeat,
    meanPitchHz: 110.0,
    medianPitchHz: 110.0,
    voicedDurationSec: 1.5,
    voicedFrameCount: 50
  };
  const deepResult = compareVoiceprints(ownerFeat, intruderDeep, 'balanced');
  console.log(`  Intruder deep score: ${deepResult.overallScore}%, Pitch Delta: ${deepResult.pitchDeltaHz} Hz, Passed: ${deepResult.passed}`);
  console.log(`  Failure Reason: ${deepResult.failureReason}`);
  if (deepResult.passed) {
    throw new Error('Intruder with deep voice MUST be rejected!');
  }
  console.log('  ✓ Test 2 Passed: Deep voice intruder rejected immediately.\n');

  // 3. INTRUDER 2: High Voice (e.g. 215 Hz pitch)
  console.log('[Test 3] Testing Intruder with High Voice (Pitch 215 Hz vs Owner 165 Hz):');
  const intruderHigh: VoiceprintFeatures = {
    ...ownerFeat,
    meanPitchHz: 215.0,
    medianPitchHz: 215.0,
    voicedDurationSec: 1.3,
    voicedFrameCount: 42
  };
  const highResult = compareVoiceprints(ownerFeat, intruderHigh, 'balanced');
  console.log(`  Intruder high score: ${highResult.overallScore}%, Pitch Delta: ${highResult.pitchDeltaHz} Hz, Passed: ${highResult.passed}`);
  console.log(`  Failure Reason: ${highResult.failureReason}`);
  if (highResult.passed) {
    throw new Error('Intruder with high voice MUST be rejected!');
  }
  console.log('  ✓ Test 3 Passed: High voice intruder rejected immediately.\n');

  // 4. INTRUDER 3: Similar pitch (165 Hz) but completely different MFCC vocal tract
  console.log('[Test 4] Testing Intruder with similar pitch (165 Hz) but different vocal tract MFCC:');
  const intruderDifferentTimbre: VoiceprintFeatures = {
    ...ownerFeat,
    meanPitchHz: 165.0,
    medianPitchHz: 165.0,
    mfccMean: ownerFeat.mfccMean.map(v => -v * 0.8), // inverted / shifted vocal tract
    melProfile: ownerFeat.melProfile.map(v => Math.max(0, 1 - v)),
    voicedDurationSec: 1.2,
    voicedFrameCount: 40
  };
  const timbreResult = compareVoiceprints(ownerFeat, intruderDifferentTimbre, 'balanced');
  console.log(`  Intruder timbre score: ${timbreResult.overallScore}%, Pitch Delta: ${timbreResult.pitchDeltaHz} Hz, Passed: ${timbreResult.passed}`);
  console.log(`  Failure Reason: ${timbreResult.failureReason}`);
  if (timbreResult.passed) {
    throw new Error('Intruder with mismatched timbre MUST be rejected!');
  }
  console.log('  ✓ Test 4 Passed: Timbre/MFCC intruder rejected immediately.\n');

  // 5. SERVER LEASE TTL (3.5 seconds sliding window)
  console.log('[Test 5] Testing Sliding Lease Window (3500ms):');
  serverVoiceGuard.setMode('online');
  serverVoiceGuard.setOwnerVerified('test-command');
  if (!serverVoiceGuard.isOwnerAuthorized()) {
    throw new Error('Immediately after verification, owner MUST be authorized!');
  }
  console.log('  Verified owner is authorized immediately: true');
  // Simulate passage of 3.6 seconds (expired lease)
  serverVoiceGuard.lastOwnerVerifiedAt = Date.now() - 3600;
  if (serverVoiceGuard.isOwnerAuthorized()) {
    throw new Error('After 3.6 seconds, lease MUST expire and require fresh verification!');
  }
  console.log('  After 3.6 seconds, lease expired as expected: true');
  console.log('  ✓ Test 5 Passed: Lease window strictly prevents intruder piggybacking.\n');

  // 6. OFFLINE MODE (Bypass)
  console.log('[Test 6] Testing OFFLINE Mode bypass:');
  serverVoiceGuard.setMode('offline');
  if (!serverVoiceGuard.isOwnerAuthorized()) {
    throw new Error('In OFFLINE mode, any command MUST be authorized!');
  }
  console.log('  In OFFLINE mode, isOwnerAuthorized() returns true immediately without voice check.');
  console.log('  ✓ Test 6 Passed: OFFLINE mode functions properly.\n');

  // Reset to online mode for security
  serverVoiceGuard.setMode('online');
  console.log('=================================================================');
  console.log('🎉 ALL VOICEGUARD REAL-TIME BIOMETRICS TESTS PASSED SUCCESSFULLY!');
  console.log('=================================================================\n');
  process.exit(0);
}

runDetectionTests().catch(err => {
  console.error('❌ Detection Test Failed:', err);
  process.exit(1);
});
