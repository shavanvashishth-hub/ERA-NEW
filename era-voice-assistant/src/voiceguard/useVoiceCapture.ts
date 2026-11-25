import { useCallback, useEffect, useRef, useState } from 'react';
import {
  TARGET_SAMPLE_RATE,
  encodeWavBase64,
  estimatePitchHz,
  extractVoiceprintFromPcm,
  resampleTo16k,
} from './audioBiometrics';
import type { VoiceprintFeatures } from './types';

export interface CapturedVoiceClip {
  samples16k: Float32Array;
  wavBase64: string;
  features: VoiceprintFeatures;
  durationSec: number;
}

interface UseVoiceCaptureOptions {
  onAutoUtterance?: (clip: CapturedVoiceClip) => void;
  paused?: boolean;
}

export function useVoiceCapture(options?: UseVoiceCaptureOptions) {
  const [isRecordingManual, setIsRecordingManual] = useState(false);
  const [isAutoGuardActive, setIsAutoGuardActive] = useState(false);
  const [vadSpeaking, setVadSpeaking] = useState(false);
  const [livePitchHz, setLivePitchHz] = useState<number | null>(null);
  const [liveRmsDb, setLiveRmsDb] = useState<number>(-96);
  const [micError, setMicError] = useState<string | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const sampleRateRef = useRef<number>(48000);
  const modeRef = useRef<'idle' | 'manual' | 'auto'>('idle');
  const pausedRef = useRef<boolean>(false);
  const onAutoRef = useRef<UseVoiceCaptureOptions['onAutoUtterance']>(options?.onAutoUtterance);

  // Auto-guard VAD state
  const preRollRef = useRef<Float32Array[]>([]);
  const utteranceChunksRef = useRef<Float32Array[]>([]);
  const speakingActiveRef = useRef<boolean>(false);
  const speechStartMsRef = useRef<number>(0);
  const lastVoiceMsRef = useRef<number>(0);
  const noiseFloorRef = useRef<number>(0.012);
  const lastTelemetryMsRef = useRef<number>(0);

  useEffect(() => {
    onAutoRef.current = options?.onAutoUtterance;
  }, [options?.onAutoUtterance]);

  useEffect(() => {
    pausedRef.current = Boolean(options?.paused);
  }, [options?.paused]);

  const cleanupGraph = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    setAnalyser(null);
    setVadSpeaking(false);
    setLivePitchHz(null);
    setLiveRmsDb(-96);
  }, []);

  useEffect(() => {
    return () => {
      cleanupGraph();
    };
  }, [cleanupGraph]);

  const mergeFloatChunks = (list: Float32Array[]): Float32Array => {
    const total = list.reduce((acc, c) => acc + c.length, 0);
    const merged = new Float32Array(total);
    let offset = 0;
    for (const chunk of list) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged;
  };

  const buildClip = (rawMerged: Float32Array, inputRate: number): CapturedVoiceClip => {
    const samples16k = resampleTo16k(rawMerged, inputRate);
    const wavBase64 = encodeWavBase64(samples16k, TARGET_SAMPLE_RATE);
    const features = extractVoiceprintFromPcm(samples16k, TARGET_SAMPLE_RATE);
    return {
      samples16k,
      wavBase64,
      features,
      durationSec: Number((samples16k.length / TARGET_SAMPLE_RATE).toFixed(2)),
    };
  };

  const initMicGraph = useCallback(async () => {
    setMicError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Browser microphone API is unavailable in this context.');
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      },
    });
    streamRef.current = stream;

    const AudioCtx =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    audioCtxRef.current = ctx;
    sampleRateRef.current = ctx.sampleRate;

    const source = ctx.createMediaStreamSource(stream);
    const node = ctx.createAnalyser();
    node.fftSize = 1024;
    node.smoothingTimeConstant = 0.75;

    const processor = ctx.createScriptProcessor(2048, 1, 1);
    const silentGain = ctx.createGain();
    silentGain.gain.value = 0;

    source.connect(node);
    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(ctx.destination);

    processorRef.current = processor;
    setAnalyser(node);

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const copyChunk = new Float32Array(input);

      let sumSq = 0;
      for (let i = 0; i < copyChunk.length; i++) {
        sumSq += copyChunk[i] * copyChunk[i];
      }
      const rms = Math.sqrt(sumSq / copyChunk.length);
      const rmsDb = 20 * Math.log10(Math.max(rms, 1e-5));
      const now = performance.now();

      if (now - lastTelemetryMsRef.current > 90) {
        lastTelemetryMsRef.current = now;
        setLiveRmsDb(rmsDb);
        if (rms > 0.015) {
          const resampledFrame = resampleTo16k(copyChunk.subarray(0, Math.min(1536, copyChunk.length)), ctx.sampleRate);
          const pitch = estimatePitchHz(resampledFrame.subarray(0, Math.min(512, resampledFrame.length)), TARGET_SAMPLE_RATE);
          setLivePitchHz(pitch);
        } else {
          setLivePitchHz(null);
        }
      }

      if (modeRef.current === 'manual') {
        chunksRef.current.push(copyChunk);
        setVadSpeaking(rms > Math.max(0.014, noiseFloorRef.current * 2.2));
      } else if (modeRef.current === 'auto') {
        if (pausedRef.current) {
          speakingActiveRef.current = false;
          utteranceChunksRef.current = [];
          setVadSpeaking(false);
          return;
        }

        // Maintain ~400ms pre-roll
        preRollRef.current.push(copyChunk);
        const maxPreRollChunks = Math.max(3, Math.ceil((0.4 * ctx.sampleRate) / copyChunk.length));
        if (preRollRef.current.length > maxPreRollChunks) {
          preRollRef.current.shift();
        }

        const speechThreshold = Math.max(0.02, noiseFloorRef.current * 2.6);

        if (!speakingActiveRef.current) {
          // Smoothly track ambient noise floor when idle
          noiseFloorRef.current = noiseFloorRef.current * 0.96 + Math.min(rms, 0.04) * 0.04;
          if (rms > speechThreshold) {
            speakingActiveRef.current = true;
            speechStartMsRef.current = now;
            lastVoiceMsRef.current = now;
            utteranceChunksRef.current = [...preRollRef.current];
            setVadSpeaking(true);
          }
        } else {
          utteranceChunksRef.current.push(copyChunk);
          if (rms > speechThreshold * 0.72) {
            lastVoiceMsRef.current = now;
          }

          const silenceElapsed = now - lastVoiceMsRef.current;
          const totalElapsed = now - speechStartMsRef.current;

          if (silenceElapsed >= 900 || totalElapsed >= 5500) {
            const captured = utteranceChunksRef.current;
            speakingActiveRef.current = false;
            utteranceChunksRef.current = [];
            setVadSpeaking(false);

            const merged = mergeFloatChunks(captured);
            const clip = buildClip(merged, ctx.sampleRate);
            if (clip.features.voicedDurationSec >= 0.45 && onAutoRef.current) {
              onAutoRef.current(clip);
            }
          }
        }
      }
    };
  }, []);

  const startManualRecording = useCallback(async () => {
    try {
      if (modeRef.current === 'auto') {
        setIsAutoGuardActive(false);
      }
      cleanupGraph();
      chunksRef.current = [];
      modeRef.current = 'manual';
      await initMicGraph();
      setIsRecordingManual(true);
    } catch (err) {
      modeRef.current = 'idle';
      setIsRecordingManual(false);
      setMicError(err instanceof Error ? err.message : 'Microphone permission denied.');
    }
  }, [cleanupGraph, initMicGraph]);

  const stopManualRecording = useCallback((): CapturedVoiceClip | null => {
    if (modeRef.current !== 'manual') return null;
    const rawChunks = chunksRef.current;
    const rate = sampleRateRef.current;
    chunksRef.current = [];
    modeRef.current = 'idle';
    setIsRecordingManual(false);
    cleanupGraph();

    if (rawChunks.length === 0) return null;
    const merged = mergeFloatChunks(rawChunks);
    return buildClip(merged, rate);
  }, [cleanupGraph]);

  const startAutoGuard = useCallback(async () => {
    try {
      cleanupGraph();
      preRollRef.current = [];
      utteranceChunksRef.current = [];
      speakingActiveRef.current = false;
      noiseFloorRef.current = 0.012;
      modeRef.current = 'auto';
      await initMicGraph();
      setIsAutoGuardActive(true);
    } catch (err) {
      modeRef.current = 'idle';
      setIsAutoGuardActive(false);
      setMicError(err instanceof Error ? err.message : 'Microphone permission denied.');
    }
  }, [cleanupGraph, initMicGraph]);

  const stopAutoGuard = useCallback(() => {
    if (modeRef.current === 'auto') {
      modeRef.current = 'idle';
    }
    setIsAutoGuardActive(false);
    speakingActiveRef.current = false;
    utteranceChunksRef.current = [];
    cleanupGraph();
  }, [cleanupGraph]);

  return {
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
  };
}
