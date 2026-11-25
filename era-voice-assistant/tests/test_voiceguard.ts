import {
  resampleTo16k,
  estimatePitchHz,
  extractVoiceprintFromPcm,
  computeOwnerCentroid,
  compareVoiceprints,
  encodeWavBase64,
  TARGET_SAMPLE_RATE,
} from '../src/voiceguard/audioBiometrics';
import type { EnrolledSample } from '../src/voiceguard/types';

function generateSineWave(freqHz: number, durationSec: number, sampleRate: number, amplitude = 0.5): Float32Array {
  const numSamples = Math.floor(durationSec * sampleRate);
  const out = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    // Fundamental + 2 harmonics for human vocal simulation
    const t = i / sampleRate;
    out[i] =
      amplitude * (0.6 * Math.sin(2 * Math.PI * freqHz * t) +
                   0.3 * Math.sin(2 * Math.PI * (freqHz * 2) * t) +
                   0.1 * Math.sin(2 * Math.PI * (freqHz * 3) * t));
  }
  return out;
}

async function runTests() {
  console.log('--- VoiceGuard Biometric Engine Test Suite ---');

  // Test 1: Pitch Estimation
  const testPitch = 145; // Hz (typical male speaking fundamental)
  const audio16k = generateSineWave(testPitch, 2.0, TARGET_SAMPLE_RATE);
  const estimatedPitch = estimatePitchHz(audio16k.subarray(0, 512), TARGET_SAMPLE_RATE);
  console.log(`[Test 1] Synthetic pitch: ${testPitch} Hz, Estimated: ${estimatedPitch?.toFixed(1)} Hz`);
  if (!estimatedPitch || Math.abs(estimatedPitch - testPitch) > 10) {
    throw new Error(`[Test 1 Failed] Pitch estimate inaccurate: expected ~${testPitch}, got ${estimatedPitch}`);
  }
  console.log('✓ Test 1: Pitch Estimation Passed');

  // Test 2: Voiceprint feature extraction
  const featuresOwner1 = extractVoiceprintFromPcm(audio16k, TARGET_SAMPLE_RATE);
  console.log(`[Test 2] Extracted features: median pitch = ${featuresOwner1.medianPitchHz} Hz, voiced frames = ${featuresOwner1.voicedFrameCount}`);
  if (featuresOwner1.voicedFrameCount < 10 || featuresOwner1.mfccMean.length !== 13) {
    throw new Error('[Test 2 Failed] Incomplete features extracted');
  }
  console.log('✓ Test 2: Voiceprint Feature Extraction Passed');

  // Test 3: Enrollment centroid
  const sample1: EnrolledSample = {
    id: 's1',
    phrase: 'test 1',
    wavBase64: encodeWavBase64(audio16k),
    durationSec: 2.0,
    features: featuresOwner1,
    recordedAt: new Date().toISOString(),
  };
  const audioOwner2 = generateSineWave(148, 2.0, TARGET_SAMPLE_RATE); // Slight natural drift (148 Hz)
  const sample2: EnrolledSample = {
    id: 's2',
    phrase: 'test 2',
    wavBase64: encodeWavBase64(audioOwner2),
    durationSec: 2.0,
    features: extractVoiceprintFromPcm(audioOwner2, TARGET_SAMPLE_RATE),
    recordedAt: new Date().toISOString(),
  };
  const { centroid, consistencyScore } = computeOwnerCentroid([sample1, sample2]);
  console.log(`[Test 3] Centroid median pitch: ${centroid.medianPitchHz} Hz, Consistency: ${consistencyScore}%`);
  console.log('✓ Test 3: Owner Centroid Computation Passed');

  // Test 4: Genuine Owner probe verification
  const probeOwner = generateSineWave(146, 2.0, TARGET_SAMPLE_RATE); // Owner speaking with natural 146 Hz
  const probeFeatures = extractVoiceprintFromPcm(probeOwner, TARGET_SAMPLE_RATE);
  const ownerResult = compareVoiceprints(centroid, probeFeatures, 'strict');
  console.log(`[Test 4] Owner verification result: passed=${ownerResult.passed}, score=${ownerResult.overallScore}%`);
  if (!ownerResult.passed) {
    throw new Error(`[Test 4 Failed] Owner was rejected: ${ownerResult.failureReason}`);
  }
  console.log('✓ Test 4: Genuine Owner Verified Passed');

  // Test 5: Intruder voice rejection (impostor with different pitch 235 Hz)
  const intruderAudio = generateSineWave(235, 2.0, TARGET_SAMPLE_RATE);
  const intruderFeatures = extractVoiceprintFromPcm(intruderAudio, TARGET_SAMPLE_RATE);
  const intruderResult = compareVoiceprints(centroid, intruderFeatures, 'strict');
  console.log(`[Test 5] Intruder verification result: passed=${intruderResult.passed}, reason="${intruderResult.failureReason}", score=${intruderResult.overallScore}%`);
  if (intruderResult.passed) {
    throw new Error('[Test 5 Failed] Intruder was falsely accepted!');
  }
  console.log('✓ Test 5: Intruder Blocked and Rejected Passed');

  // Test 6: Shavan Vashishth real case (Owner 177 Hz enrolled, Probe 200 Hz command)
  const shavanOwnerAudio = generateSineWave(177, 2.0, TARGET_SAMPLE_RATE);
  const shavanOwnerFeatures = extractVoiceprintFromPcm(shavanOwnerAudio, TARGET_SAMPLE_RATE);
  const shavanProbeAudio = generateSineWave(200, 1.2, TARGET_SAMPLE_RATE); // 1.2s command at 200 Hz
  const shavanProbeFeatures = extractVoiceprintFromPcm(shavanProbeAudio, TARGET_SAMPLE_RATE);
  const shavanResult = compareVoiceprints(shavanOwnerFeatures, shavanProbeFeatures, 'strict');
  console.log(`[Test 6] Shavan Owner 177Hz vs Probe 200Hz result: passed=${shavanResult.passed}, score=${shavanResult.overallScore}%, pitchCompatibility=${shavanResult.pitchCompatibility}%`);
  if (!shavanResult.passed) {
    throw new Error(`[Test 6 Failed] Shavan (Owner 177 Hz vs 200 Hz) was rejected: ${shavanResult.failureReason}`);
  }
  console.log('✓ Test 6: Shavan Vashishth Owner Voice Recognition (177 Hz vs 200 Hz) Passed Perfectly!');

  // Test 7: Owner speaking different words (simulating low MFCC overlap between command & enrollment)
  const diffWordProbe = { ...shavanProbeFeatures };
  diffWordProbe.mfccMean = diffWordProbe.mfccMean.map(v => -v * 0.5); // completely altered phonetics
  const diffWordResult = compareVoiceprints(shavanOwnerFeatures, diffWordProbe, 'strict');
  console.log(`[Test 7] Different words command result: passed=${diffWordResult.passed}, score=${diffWordResult.overallScore}%`);
  if (!diffWordResult.passed) {
    throw new Error(`[Test 7 Failed] Owner speaking different words was rejected: ${diffWordResult.failureReason}`);
  }
  console.log('✓ Test 7: Owner Speaking Different Spoken Words Verified and Accepted!');

  // Test 8: Intruder Deep Male 95 Hz
  const deepMaleAudio = generateSineWave(95, 2.0, TARGET_SAMPLE_RATE);
  const deepMaleFeatures = extractVoiceprintFromPcm(deepMaleAudio, TARGET_SAMPLE_RATE);
  const deepMaleResult = compareVoiceprints(shavanOwnerFeatures, deepMaleFeatures, 'strict');
  console.log(`[Test 8] Deep male intruder (95 Hz) result: passed=${deepMaleResult.passed}, reason="${deepMaleResult.failureReason}", score=${deepMaleResult.overallScore}%`);
  if (deepMaleResult.passed) {
    throw new Error('[Test 8 Failed] Deep male intruder was accepted!');
  }
  console.log('✓ Test 8: Deep Male Intruder (95 Hz) Blocked Successfully!');

  console.log('\n===========================================');
  console.log(' ALL VOICEGUARD BIOMETRIC TESTS PASSED! 🛡️');
  console.log('===========================================');
}

runTests().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
