import type { AudioMetrics } from '../types/era';

const TARGET_INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const SPECTRUM_BINS = 32;

const WORKLET_PROCESSOR_CODE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      const channelData = input[0];
      const copy = new Float32Array(channelData.length);
      copy.set(channelData);
      this.port.postMessage(copy, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor('era-pcm-capture', PcmCaptureProcessor);
`;

export interface AudioStreamerCallbacks {
  onAudioData: (base64Pcm16: string) => void;
  onPlaybackStateChange?: (isPlaying: boolean) => void;
  onError?: (error: Error) => void;
}

export class AudioStreamer {
  private inputCtx: AudioContext | null = null;
  private outputCtx: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private scriptProcessorNode: ScriptProcessorNode | null = null;
  private silentGainNode: GainNode | null = null;
  private inputAnalyser: AnalyserNode | null = null;
  private outputAnalyser: AnalyserNode | null = null;
  private outputGainNode: GainNode | null = null;
  private workletUrl: string | null = null;

  private activeSources = new Set<AudioBufferSourceNode>();
  private nextStartTime = 0;
  private isPlaying = false;
  private muted = false;
  private disposed = false;

  private inputFreqData = new Uint8Array(SPECTRUM_BINS);
  private outputFreqData = new Uint8Array(SPECTRUM_BINS);
  private normalizedBins = new Float32Array(SPECTRUM_BINS);

  private callbacks: AudioStreamerCallbacks;

  constructor(callbacks: AudioStreamerCallbacks) {
    this.callbacks = callbacks;
  }

  public async start(): Promise<void> {
    this.disposed = false;

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: TARGET_INPUT_SAMPLE_RATE,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      throw new Error(
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'Microphone access was denied. Please allow mic permissions to talk to ERA.'
          : 'Unable to access microphone. Check your audio input device.'
      );
    }

    if (this.disposed) {
      this.stopMediaTracks();
      return;
    }

    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

    this.inputCtx = new AudioCtx({ sampleRate: TARGET_INPUT_SAMPLE_RATE });
    this.outputCtx = new AudioCtx({ sampleRate: OUTPUT_SAMPLE_RATE });

    if (this.inputCtx.state === 'suspended') {
      await this.inputCtx.resume();
    }
    if (this.outputCtx.state === 'suspended') {
      await this.outputCtx.resume();
    }

    // Output graph: sources -> outputAnalyser -> outputGain -> destination
    this.outputAnalyser = this.outputCtx.createAnalyser();
    this.outputAnalyser.fftSize = 64;
    this.outputAnalyser.smoothingTimeConstant = 0.72;
    this.outputFreqData = new Uint8Array(this.outputAnalyser.frequencyBinCount);

    this.outputGainNode = this.outputCtx.createGain();
    this.outputGainNode.gain.value = 1;
    this.outputAnalyser.connect(this.outputGainNode);
    this.outputGainNode.connect(this.outputCtx.destination);

    // Input graph: mic -> inputAnalyser -> capture node -> silentGain -> destination
    this.sourceNode = this.inputCtx.createMediaStreamSource(this.mediaStream);
    this.inputAnalyser = this.inputCtx.createAnalyser();
    this.inputAnalyser.fftSize = 64;
    this.inputAnalyser.smoothingTimeConstant = 0.72;
    this.inputFreqData = new Uint8Array(this.inputAnalyser.frequencyBinCount);

    this.silentGainNode = this.inputCtx.createGain();
    this.silentGainNode.gain.value = 0;

    this.sourceNode.connect(this.inputAnalyser);

    const inputSampleRate = this.inputCtx.sampleRate;
    const handleFloatChunk = (samples: Float32Array) => {
      if (this.disposed || this.muted) return;
      const resampled =
        inputSampleRate === TARGET_INPUT_SAMPLE_RATE
          ? samples
          : this.downsampleLinear(samples, inputSampleRate, TARGET_INPUT_SAMPLE_RATE);
      const base64 = this.float32ToPcm16Base64(resampled);
      this.callbacks.onAudioData(base64);
    };

    if (this.inputCtx.audioWorklet) {
      try {
        const blob = new Blob([WORKLET_PROCESSOR_CODE], { type: 'application/javascript' });
        this.workletUrl = URL.createObjectURL(blob);
        await this.inputCtx.audioWorklet.addModule(this.workletUrl);

        if (this.disposed) return;

        this.workletNode = new AudioWorkletNode(this.inputCtx, 'era-pcm-capture');
        this.workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
          handleFloatChunk(event.data);
        };
        this.inputAnalyser.connect(this.workletNode);
        this.workletNode.connect(this.silentGainNode);
        this.silentGainNode.connect(this.inputCtx.destination);
        return;
      } catch {
        // Fallback cleanly to ScriptProcessorNode below
      }
    }

    const bufferSize = 4096;
    this.scriptProcessorNode = this.inputCtx.createScriptProcessor(bufferSize, 1, 1);
    this.scriptProcessorNode.onaudioprocess = (event: AudioProcessingEvent) => {
      handleFloatChunk(event.inputBuffer.getChannelData(0));
    };
    this.inputAnalyser.connect(this.scriptProcessorNode);
    this.scriptProcessorNode.connect(this.silentGainNode);
    this.silentGainNode.connect(this.inputCtx.destination);
  }

  public playPcm24kChunk(base64Pcm16: string): void {
    if (this.disposed || !this.outputCtx || !this.outputAnalyser) return;

    if (this.outputCtx.state === 'suspended') {
      void this.outputCtx.resume();
    }

    const floatSamples = this.base64Pcm16ToFloat32(base64Pcm16);
    if (floatSamples.length === 0) return;

    const audioBuffer = this.outputCtx.createBuffer(1, floatSamples.length, OUTPUT_SAMPLE_RATE);
    audioBuffer.copyToChannel(floatSamples, 0);

    const source = this.outputCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.outputAnalyser);

    const now = this.outputCtx.currentTime;
    if (this.nextStartTime < now + 0.015) {
      this.nextStartTime = now + 0.02;
    }

    const startTime = this.nextStartTime;
    this.nextStartTime += audioBuffer.duration;

    this.activeSources.add(source);
    if (!this.isPlaying) {
      this.isPlaying = true;
      this.callbacks.onPlaybackStateChange?.(true);
    }

    source.onended = () => {
      source.disconnect();
      this.activeSources.delete(source);
      if (this.activeSources.size === 0 && this.isPlaying) {
        this.isPlaying = false;
        this.nextStartTime = 0;
        this.callbacks.onPlaybackStateChange?.(false);
      }
    };

    source.start(startTime);
  }

  public interrupt(): void {
    for (const source of this.activeSources) {
      try {
        source.onended = null;
        source.stop();
        source.disconnect();
      } catch {
        // Ignore nodes that have already stopped
      }
    }
    this.activeSources.clear();
    this.nextStartTime = 0;
    if (this.isPlaying) {
      this.isPlaying = false;
      this.callbacks.onPlaybackStateChange?.(false);
    }
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public getMetrics(): AudioMetrics {
    let inputSum = 0;
    let outputSum = 0;

    if (this.inputAnalyser && !this.muted) {
      this.inputAnalyser.getByteFrequencyData(this.inputFreqData);
      for (let i = 0; i < this.inputFreqData.length; i++) {
        inputSum += this.inputFreqData[i];
      }
    } else {
      this.inputFreqData.fill(0);
    }

    if (this.outputAnalyser && this.isPlaying) {
      this.outputAnalyser.getByteFrequencyData(this.outputFreqData);
      for (let i = 0; i < this.outputFreqData.length; i++) {
        outputSum += this.outputFreqData[i];
      }
    } else {
      this.outputFreqData.fill(0);
    }

    const inputLevel = this.inputFreqData.length
      ? Math.min(1, inputSum / (this.inputFreqData.length * 140))
      : 0;
    const outputLevel = this.outputFreqData.length
      ? Math.min(1, outputSum / (this.outputFreqData.length * 140))
      : 0;

    const activeSource = this.isPlaying ? this.outputFreqData : this.inputFreqData;
    const binCount = Math.min(SPECTRUM_BINS, activeSource.length);
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const sample = i < binCount ? activeSource[i] / 255 : 0;
      this.normalizedBins[i] = this.normalizedBins[i] * 0.55 + sample * 0.45;
    }

    return {
      inputLevel,
      outputLevel,
      bins: this.normalizedBins,
    };
  }

  public dispose(): void {
    this.disposed = true;
    this.interrupt();

    try {
      this.workletNode?.port.close();
      this.workletNode?.disconnect();
    } catch {
      // Ignore
    }
    this.workletNode = null;

    try {
      this.scriptProcessorNode?.disconnect();
    } catch {
      // Ignore
    }
    this.scriptProcessorNode = null;

    try {
      this.sourceNode?.disconnect();
      this.inputAnalyser?.disconnect();
      this.silentGainNode?.disconnect();
      this.outputAnalyser?.disconnect();
      this.outputGainNode?.disconnect();
    } catch {
      // Ignore
    }

    this.stopMediaTracks();

    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl);
      this.workletUrl = null;
    }

    void this.inputCtx?.close().catch(() => {});
    void this.outputCtx?.close().catch(() => {});
    this.inputCtx = null;
    this.outputCtx = null;
  }

  private stopMediaTracks(): void {
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }
  }

  private downsampleLinear(
    buffer: Float32Array,
    sourceRate: number,
    targetRate: number
  ): Float32Array {
    if (targetRate >= sourceRate) return buffer;
    const ratio = sourceRate / targetRate;
    const outputLength = Math.floor(buffer.length / ratio);
    const result = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      const srcIndex = i * ratio;
      const lower = Math.floor(srcIndex);
      const upper = Math.min(lower + 1, buffer.length - 1);
      const weight = srcIndex - lower;
      result[i] = buffer[lower] * (1 - weight) + buffer[upper] * weight;
    }
    return result;
  }

  private float32ToPcm16Base64(float32: Float32Array): string {
    const pcm16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const clamped = Math.max(-1, Math.min(1, float32[i]));
      pcm16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }
    const bytes = new Uint8Array(pcm16.buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const sub = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...sub);
    }
    return btoa(binary);
  }

  private base64Pcm16ToFloat32(base64: string): Float32Array<ArrayBuffer> {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const pcm16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    const float32 = new Float32Array(new ArrayBuffer(pcm16.length * 4));
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32768;
    }
    return float32;
  }
}
