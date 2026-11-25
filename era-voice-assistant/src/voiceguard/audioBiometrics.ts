import type { DspComparisonResult, EnrolledSample, SecurityStrictness, VoiceprintFeatures } from './types';

export const TARGET_SAMPLE_RATE = 16000;

export function resampleTo16k(input: Float32Array, inputSampleRate: number): Float32Array {
  if (inputSampleRate === TARGET_SAMPLE_RATE) {
    return input;
  }
  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const newLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = input[Math.min(idx, input.length - 1)];
    const s1 = input[Math.min(idx + 1, input.length - 1)];
    output[i] = s0 + (s1 - s0) * frac;
  }
  return output;
}

export function encodeWavBase64(samples16k: Float32Array, sampleRate = TARGET_SAMPLE_RATE): string {
  const numSamples = samples16k.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const clamped = Math.max(-1, Math.min(1, samples16k[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export async function decodeAudioFileTo16kPcm(file: File): Promise<Float32Array> {
  const arrayBuffer = await file.arrayBuffer();
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  try {
    const decoded = await ctx.decodeAudioData(arrayBuffer);
    const numChannels = decoded.numberOfChannels;
    const len = decoded.length;
    const mono = new Float32Array(len);
    for (let ch = 0; ch < numChannels; ch++) {
      const chData = decoded.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        mono[i] += chData[i] / numChannels;
      }
    }
    const resampled = resampleTo16k(mono, decoded.sampleRate);
    // Cap uploaded test clip at 12 seconds for fast verification
    const maxSamples = TARGET_SAMPLE_RATE * 12;
    return resampled.length > maxSamples ? resampled.subarray(0, maxSamples) : resampled;
  } finally {
    await ctx.close();
  }
}

// Radix-2 Cooley-Tukey in-place FFT (n must be power of 2)
function fftMagnitude(realInput: Float32Array): Float32Array {
  const n = realInput.length;
  const real = new Float32Array(realInput);
  const imag = new Float32Array(n);

  let j = 0;
  for (let i = 0; i < n; i++) {
    if (i < j) {
      const tr = real[i];
      real[i] = real[j];
      real[j] = tr;
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }

  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = (-2 * Math.PI) / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < half; k++) {
        const angle = k * step;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const idx1 = i + k;
        const idx2 = idx1 + half;
        const tReal = cos * real[idx2] - sin * imag[idx2];
        const tImag = sin * real[idx2] + cos * imag[idx2];
        real[idx2] = real[idx1] - tReal;
        imag[idx2] = imag[idx1] - tImag;
        real[idx1] += tReal;
        imag[idx1] += tImag;
      }
    }
  }

  const bins = n >> 1;
  const mag = new Float32Array(bins);
  for (let i = 0; i < bins; i++) {
    mag[i] = Math.hypot(real[i], imag[i]);
  }
  return mag;
}

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel: number): number {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

function buildMelFilterbank(numFilters: number, fftSize: number, sampleRate: number): Float32Array[] {
  const minMel = hzToMel(80);
  const maxMel = hzToMel(Math.min(7600, sampleRate / 2));
  const melPoints: number[] = [];
  for (let i = 0; i < numFilters + 2; i++) {
    melPoints.push(minMel + ((maxMel - minMel) * i) / (numFilters + 1));
  }
  const binPoints = melPoints.map((m) => Math.floor(((fftSize + 1) * melToHz(m)) / sampleRate));
  const numBins = fftSize >> 1;
  const banks: Float32Array[] = [];

  for (let m = 1; m <= numFilters; m++) {
    const bank = new Float32Array(numBins);
    const left = binPoints[m - 1];
    const center = binPoints[m];
    const right = binPoints[m + 1];

    for (let k = left; k < center; k++) {
      if (k >= 0 && k < numBins && center > left) {
        bank[k] = (k - left) / (center - left);
      }
    }
    for (let k = center; k <= right; k++) {
      if (k >= 0 && k < numBins && right > center) {
        bank[k] = (right - k) / (right - center);
      }
    }
    banks.push(bank);
  }
  return banks;
}

let cachedFilterbank: Float32Array[] | null = null;
let cachedFilterbankKey = "";

function getCachedMelFilterbank(numFilters: number, fftSize: number, sampleRate: number): Float32Array[] {
  const key = `${numFilters}_${fftSize}_${sampleRate}`;
  if (!cachedFilterbank || cachedFilterbankKey !== key) {
    cachedFilterbank = buildMelFilterbank(numFilters, fftSize, sampleRate);
    cachedFilterbankKey = key;
  }
  return cachedFilterbank;
}

let cachedHammingWindow: Float32Array | null = null;
function getCachedHammingWindow(size: number): Float32Array {
  if (!cachedHammingWindow || cachedHammingWindow.length !== size) {
    cachedHammingWindow = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      cachedHammingWindow[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (size - 1));
    }
  }
  return cachedHammingWindow;
}

export function estimatePitchHz(frame: Float32Array, sampleRate = TARGET_SAMPLE_RATE): number | null {
  const n = frame.length;
  // Prefix sum of squares for instantaneous O(1) energy lookup of any slice
  const cumEnergy = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const s = frame[i];
    cumEnergy[i + 1] = cumEnergy[i] + s * s;
  }
  if (cumEnergy[n] < 1e-6) return null;

  const minLag = Math.floor(sampleRate / 380); // 380 Hz max (~42)
  const maxLag = Math.min(n - 2, Math.floor(sampleRate / 65)); // 65 Hz min (~246)

  const corrBuffer = new Float32Array(maxLag + 2);
  let maxCorr = 0;

  for (let lag = minLag; lag <= maxLag; lag++) {
    const len = n - lag;
    let sum = 0;
    for (let i = 0; i < len; i++) {
      sum += frame[i] * frame[i + lag];
    }
    const normA = cumEnergy[len];
    const normB = cumEnergy[n] - cumEnergy[lag];
    const denom = Math.sqrt(normA * normB);
    const corr = denom > 0 ? sum / denom : 0;
    corrBuffer[lag] = corr;
    if (corr > maxCorr) {
      maxCorr = corr;
    }
  }

  if (maxCorr < 0.36) return null;

  // Pick the first strong local maximum (>= 85% of maxCorr) to prevent octave jump (halving) errors
  let bestLag = -1;
  const threshold = maxCorr * 0.85;

  for (let lag = minLag + 1; lag < maxLag; lag++) {
    const val = corrBuffer[lag];
    if (val >= threshold && val >= corrBuffer[lag - 1] && val >= corrBuffer[lag + 1]) {
      bestLag = lag;
      break;
    }
  }

  if (bestLag <= 0) {
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (corrBuffer[lag] === maxCorr) {
        bestLag = lag;
        break;
      }
    }
  }

  if (bestLag <= 0) return null;
  return sampleRate / bestLag;
}

export function extractVoiceprintFromPcm(
  samples: Float32Array,
  sampleRate = TARGET_SAMPLE_RATE
): VoiceprintFeatures {
  const frameSize = 512;
  const hopSize = 256;
  const numMelBands = 24;
  const numMfcc = 13;

  // Use cached precomputed window & mel filterbank (zero allocation overhead)
  const windowFn = getCachedHammingWindow(frameSize);
  const filterbank = getCachedMelFilterbank(numMelBands, frameSize, sampleRate);

  // First pass: find peak RMS energy for adaptive VAD
  const frameRms: number[] = [];
  for (let start = 0; start + frameSize <= samples.length; start += hopSize) {
    let sumSq = 0;
    for (let i = 0; i < frameSize; i++) {
      const s = samples[start + i];
      sumSq += s * s;
    }
    frameRms.push(Math.sqrt(sumSq / frameSize));
  }

  const sortedRms = [...frameRms].sort((a, b) => a - b);
  const noiseFloor = sortedRms.length > 0 ? sortedRms[Math.floor(sortedRms.length * 0.15)] : 0.001;
  const peakRms = sortedRms.length > 0 ? sortedRms[Math.floor(sortedRms.length * 0.95)] : 0.01;
  const vadThreshold = Math.min(Math.max(0.008, peakRms * 0.3), Math.max(0.006, noiseFloor * 1.8));

  const pitchValues: number[] = [];
  const centroids: number[] = [];
  const rolloffs: number[] = [];
  const flatnesses: number[] = [];
  const zcrs: number[] = [];
  const melFrames: number[][] = [];
  const mfccFrames: number[][] = [];
  let voicedRmsSum = 0;
  let voicedFrameCount = 0;

  const freqPerBin = sampleRate / frameSize;

  for (let frameIdx = 0, start = 0; start + frameSize <= samples.length; frameIdx++, start += hopSize) {
    const rms = frameRms[frameIdx];
    if (rms < vadThreshold) continue;

    // ZCR check to skip unvoiced static hiss
    let zc = 0;
    for (let i = 1; i < frameSize; i++) {
      if ((samples[start + i - 1] >= 0) !== (samples[start + i] >= 0)) {
        zc++;
      }
    }
    const zcr = zc / frameSize;
    if (zcr > 0.42) continue;

    voicedFrameCount++;
    voicedRmsSum += rms;
    zcrs.push(zcr);

    const rawFrame = samples.subarray(start, start + frameSize);
    const pitch = estimatePitchHz(rawFrame, sampleRate);
    if (pitch !== null) {
      pitchValues.push(pitch);
    }

    // Apply pre-emphasis + Hamming window
    const windowed = new Float32Array(frameSize);
    windowed[0] = rawFrame[0] * windowFn[0];
    for (let i = 1; i < frameSize; i++) {
      windowed[i] = (rawFrame[i] - 0.97 * rawFrame[i - 1]) * windowFn[i];
    }

    const mag = fftMagnitude(windowed);
    const power = new Float32Array(mag.length);
    let totalMag = 0;
    let weightedFreq = 0;
    let logSum = 0;
    let arithSum = 0;

    for (let k = 1; k < mag.length; k++) {
      const m = mag[k];
      power[k] = m * m;
      totalMag += m;
      weightedFreq += k * freqPerBin * m;
      logSum += Math.log(m + 1e-9);
      arithSum += m + 1e-9;
    }

    const centroid = totalMag > 0 ? weightedFreq / totalMag : 0;
    centroids.push(centroid);

    // 85% Spectral Rolloff
    let cumMag = 0;
    let rolloffHz = sampleRate / 2;
    for (let k = 1; k < mag.length; k++) {
      cumMag += mag[k];
      if (cumMag >= totalMag * 0.85) {
        rolloffHz = k * freqPerBin;
        break;
      }
    }
    rolloffs.push(rolloffHz);

    const binsCount = Math.max(1, mag.length - 1);
    const geoMean = Math.exp(logSum / binsCount);
    const arithMean = arithSum / binsCount;
    flatnesses.push(arithMean > 0 ? geoMean / arithMean : 0);

    // Mel filterbank energies
    const logMel = new Array<number>(numMelBands);
    for (let m = 0; m < numMelBands; m++) {
      const bank = filterbank[m];
      let energy = 1e-9;
      for (let k = 0; k < bank.length; k++) {
        energy += power[k] * bank[k];
      }
      logMel[m] = Math.log(energy);
    }
    melFrames.push(logMel);

    // DCT-II for MFCCs c1..c13 (skipping c0 energy so volume doesn't skew timbre)
    const mfcc = new Array<number>(numMfcc);
    for (let c = 1; c <= numMfcc; c++) {
      let sum = 0;
      for (let m = 0; m < numMelBands; m++) {
        sum += logMel[m] * Math.cos((Math.PI * c * (m + 0.5)) / numMelBands);
      }
      mfcc[c - 1] = sum;
    }
    mfccFrames.push(mfcc);
  }

  const avg = (arr: number[]) => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const std = (arr: number[], meanVal: number) =>
    arr.length > 1
      ? Math.sqrt(arr.reduce((acc, v) => acc + (v - meanVal) * (v - meanVal), 0) / arr.length)
      : 0;

  const sortedPitches = [...pitchValues].sort((a, b) => a - b);
  const medianPitchHz =
    sortedPitches.length > 0 ? sortedPitches[Math.floor(sortedPitches.length / 2)] : 0;
  const meanPitchHz = avg(pitchValues);
  const pitchStdHz = std(pitchValues, meanPitchHz);

  // Average & L2-normalize Mel profile
  const melProfile = new Array<number>(numMelBands).fill(0);
  if (melFrames.length > 0) {
    for (const frame of melFrames) {
      for (let m = 0; m < numMelBands; m++) melProfile[m] += frame[m] / melFrames.length;
    }
    // Zero-mean + unit norm across bands to preserve relative formant shape
    const melMean = avg(melProfile);
    let normSq = 0;
    for (let m = 0; m < numMelBands; m++) {
      melProfile[m] -= melMean;
      normSq += melProfile[m] * melProfile[m];
    }
    const norm = Math.sqrt(normSq) || 1;
    for (let m = 0; m < numMelBands; m++) melProfile[m] /= norm;
  }

  const mfccMean = new Array<number>(numMfcc).fill(0);
  const mfccStd = new Array<number>(numMfcc).fill(0);
  if (mfccFrames.length > 0) {
    for (const frame of mfccFrames) {
      for (let c = 0; c < numMfcc; c++) mfccMean[c] += frame[c] / mfccFrames.length;
    }
    for (const frame of mfccFrames) {
      for (let c = 0; c < numMfcc; c++) {
        const diff = frame[c] - mfccMean[c];
        mfccStd[c] += diff * diff;
      }
    }
    for (let c = 0; c < numMfcc; c++) {
      mfccStd[c] = Math.sqrt(mfccStd[c] / mfccFrames.length);
    }
  }

  const voicedDurationSec = (voicedFrameCount * hopSize) / sampleRate;
  const totalDurationSec = samples.length / sampleRate;
  const meanRms = voicedFrameCount > 0 ? voicedRmsSum / voicedFrameCount : 0;
  const snrDb = noiseFloor > 0 ? Math.max(0, 20 * Math.log10((meanRms + 1e-6) / (noiseFloor + 1e-6))) : 0;

  return {
    meanPitchHz: Number(meanPitchHz.toFixed(1)),
    medianPitchHz: Number(medianPitchHz.toFixed(1)),
    pitchStdHz: Number(pitchStdHz.toFixed(1)),
    spectralCentroidHz: Number(avg(centroids).toFixed(1)),
    spectralRolloffHz: Number(avg(rolloffs).toFixed(1)),
    spectralFlatness: Number(avg(flatnesses).toFixed(4)),
    zeroCrossingRate: Number(avg(zcrs).toFixed(4)),
    melProfile,
    mfccMean,
    mfccStd,
    voicedDurationSec: Number(voicedDurationSec.toFixed(2)),
    totalDurationSec: Number(totalDurationSec.toFixed(2)),
    rmsEnergy: Number(meanRms.toFixed(4)),
    snrDb: Number(snrDb.toFixed(1)),
    voicedFrameCount,
  };
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

export function computeOwnerCentroid(samples: EnrolledSample[]): {
  centroid: VoiceprintFeatures;
  consistencyScore: number;
} {
  const count = samples.length;
  const avgNum = (fn: (f: VoiceprintFeatures) => number) =>
    samples.reduce((acc, s) => acc + fn(s.features), 0) / count;

  const numMel = samples[0].features.melProfile.length;
  const melProfile = new Array<number>(numMel).fill(0);
  for (const s of samples) {
    for (let i = 0; i < numMel; i++) melProfile[i] += s.features.melProfile[i] / count;
  }

  const numMfcc = samples[0].features.mfccMean.length;
  const mfccMean = new Array<number>(numMfcc).fill(0);
  const mfccStd = new Array<number>(numMfcc).fill(0);
  for (const s of samples) {
    for (let i = 0; i < numMfcc; i++) {
      mfccMean[i] += s.features.mfccMean[i] / count;
      mfccStd[i] += s.features.mfccStd[i] / count;
    }
  }

  const centroid: VoiceprintFeatures = {
    meanPitchHz: Number(avgNum((f) => f.meanPitchHz).toFixed(1)),
    medianPitchHz: Number(avgNum((f) => f.medianPitchHz).toFixed(1)),
    pitchStdHz: Number(avgNum((f) => f.pitchStdHz).toFixed(1)),
    spectralCentroidHz: Number(avgNum((f) => f.spectralCentroidHz).toFixed(1)),
    spectralRolloffHz: Number(avgNum((f) => f.spectralRolloffHz).toFixed(1)),
    spectralFlatness: Number(avgNum((f) => f.spectralFlatness).toFixed(4)),
    zeroCrossingRate: Number(avgNum((f) => f.zeroCrossingRate).toFixed(4)),
    melProfile,
    mfccMean,
    mfccStd,
    voicedDurationSec: Number(avgNum((f) => f.voicedDurationSec).toFixed(2)),
    totalDurationSec: Number(avgNum((f) => f.totalDurationSec).toFixed(2)),
    rmsEnergy: Number(avgNum((f) => f.rmsEnergy).toFixed(4)),
    snrDb: Number(avgNum((f) => f.snrDb).toFixed(1)),
    voicedFrameCount: Math.round(avgNum((f) => f.voicedFrameCount)),
  };

  // Measure intra-speaker consistency across samples
  const scores = samples.map((s) => compareVoiceprints(centroid, s.features, 'strict').overallScore);
  const consistencyScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);

  return { centroid, consistencyScore };
}

export function compareVoiceprints(
  owner: VoiceprintFeatures,
  probe: VoiceprintFeatures,
  strictness: SecurityStrictness
): DspComparisonResult {
  const ownerPitch = owner.medianPitchHz > 0 ? owner.medianPitchHz : owner.meanPitchHz;
  const probePitch = probe.medianPitchHz > 0 ? probe.medianPitchHz : probe.meanPitchHz;
  const pitchDeltaHz = Math.abs(probePitch - ownerPitch);

  if (probe.voicedDurationSec < 0.16 || probe.voicedFrameCount < 4) {
    return {
      overallScore: 0,
      mfccCosineScore: 0,
      melCosineScore: 0,
      pitchCompatibility: 0,
      timbreScore: 0,
      pitchDeltaHz: Number(pitchDeltaHz.toFixed(1)),
      ownerMeanPitchHz: ownerPitch,
      probeMeanPitchHz: probePitch,
      voicedDurationSec: probe.voicedDurationSec,
      passed: false,
      failureReason: 'Insufficient clear voiced speech detected (silence or background noise).',
    };
  }

  // MFCC cosine similarity (normalized for text-independent command verification)
  const mfccCos = cosineSimilarity(owner.mfccMean, probe.mfccMean);
  const mfccCosineScore = Math.max(0, Math.min(100, Math.round(mfccCos * 100)));

  // Mel formant envelope cosine similarity
  const melCos = cosineSimilarity(owner.melProfile, probe.melProfile);
  const melCosineScore = Math.max(0, Math.min(100, Math.round(melCos * 100)));

  // Pitch compatibility (calibrated with 0.22 spread to accurately verify owner voice and reject different speakers)
  let pitchCompatibility = 0;
  if (ownerPitch > 0 && probePitch > 0) {
    const relDiff = pitchDeltaHz / ownerPitch;
    pitchCompatibility = Math.round(100 * Math.exp(-Math.pow(relDiff / 0.22, 2)));
  } else if (ownerPitch === 0 && probePitch === 0) {
    pitchCompatibility = 50;
  }

  // Spectral centroid & rolloff similarity
  const centroidRatio =
    owner.spectralCentroidHz > 0 && probe.spectralCentroidHz > 0
      ? Math.min(owner.spectralCentroidHz, probe.spectralCentroidHz) /
        Math.max(owner.spectralCentroidHz, probe.spectralCentroidHz)
      : 0.5;
  const rolloffRatio =
    owner.spectralRolloffHz > 0 && probe.spectralRolloffHz > 0
      ? Math.min(owner.spectralRolloffHz, probe.spectralRolloffHz) /
        Math.max(owner.spectralRolloffHz, probe.spectralRolloffHz)
      : 0.5;

  const timbreScore = Math.round(
    0.50 * melCosineScore + 0.30 * (centroidRatio * 100) + 0.20 * (rolloffRatio * 100)
  );

  // Holistic overall confidence score: 40% Pitch + 35% Vocal Tract Timbre + 25% MFCC Formants
  const overallScore = Math.round(
    0.40 * pitchCompatibility + 0.35 * timbreScore + 0.25 * mfccCosineScore
  );

  // Verification thresholds (calibrated to accurately verify owner Shavan ~165 Hz and reject other speakers):
  // 'maximum': minOverall=75%, maxDelta=16Hz, minMfcc=55%, minTimbre=55%, minPitch=60%
  // 'strict': minOverall=65%, maxDelta=22Hz, minMfcc=45%, minTimbre=45%, minPitch=45%
  // 'balanced': minOverall=55%, maxDelta=30Hz, minMfcc=35%, minTimbre=35%, minPitch=35%
  const minOverall = strictness === 'maximum' ? 75 : (strictness === 'strict' ? 65 : 55);
  const minPitch = strictness === 'maximum' ? 60 : (strictness === 'strict' ? 45 : 35);
  const maxAllowedPitchDelta = strictness === 'maximum' ? 16 : (strictness === 'strict' ? 22 : 30);
  const minMfcc = strictness === 'maximum' ? 55 : (strictness === 'strict' ? 45 : 35);
  const minTimbre = strictness === 'maximum' ? 55 : (strictness === 'strict' ? 45 : 35);

  // Strict biometric gating: MUST meet overall score, pitch delta, pitch compatibility, MFCC formants, and timbre
  let passed =
    overallScore >= minOverall &&
    pitchDeltaHz <= maxAllowedPitchDelta &&
    pitchCompatibility >= minPitch &&
    mfccCosineScore >= minMfcc &&
    timbreScore >= minTimbre;
  let failureReason: string | null = null;

  if (!passed) {
    if (pitchDeltaHz > maxAllowedPitchDelta) {
      failureReason = `Fundamental pitch mismatch (${probePitch.toFixed(0)} Hz vs owner ${ownerPitch.toFixed(0)} Hz, delta ${pitchDeltaHz.toFixed(0)} Hz > ${maxAllowedPitchDelta} Hz).`;
    } else if (mfccCosineScore < minMfcc) {
      failureReason = `Vocal tract MFCC mismatch (${mfccCosineScore}% < ${minMfcc}%).`;
    } else if (timbreScore < minTimbre) {
      failureReason = `Vocal tract spectral timbre mismatch (${timbreScore}% < ${minTimbre}%).`;
    } else if (overallScore < minOverall) {
      failureReason = `Acoustic voiceprint confidence score below ${minOverall}% threshold (${overallScore}%).`;
    } else {
      failureReason = `Vocal tract timbre mismatch (pitch compatibility ${pitchCompatibility}% < ${minPitch}%).`;
    }
  }

  return {
    overallScore,
    mfccCosineScore,
    melCosineScore,
    pitchCompatibility,
    timbreScore,
    pitchDeltaHz: Number(pitchDeltaHz.toFixed(1)),
    ownerMeanPitchHz: ownerPitch,
    probeMeanPitchHz: probePitch,
    voicedDurationSec: probe.voicedDurationSec,
    passed,
    failureReason,
  };
}
