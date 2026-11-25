export class AudioStreamer {
  private inputCtx: AudioContext | null = null;
  private outputCtx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private playbackAnalyser: AnalyserNode | null = null;
  private activeSources: AudioBufferSourceNode[] = [];
  private nextStartTime = 0;
  private isRecording = false;
  private isMuted = false;
  private selectedDeviceId: string | null = null;
  private rollingPcmChunks: Float32Array[] = [];
  private readonly maxRollingChunks = 40; // 40 chunks * 2048 samples = 81,920 samples (~5.1 seconds @ 16kHz)
  private onPcmListeners: Set<(chunk: Float32Array, rms: number) => void> = new Set();


  constructor() {}

  static async listMicrophones(): Promise<Array<{ deviceId: string; label: string }>> {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter(d => d.kind === "audioinput")
        .map(d => ({ deviceId: d.deviceId, label: d.label || `Microphone ${d.deviceId.slice(0, 5)}` }));
    } catch {
      return [];
    }
  }

  setMicrophone(deviceId: string): void {
    this.selectedDeviceId = deviceId;
  }

  setMuted(muted: boolean): void {
    this.isMuted = muted;
    if (this.micStream) {
      try {
        this.micStream.getAudioTracks().forEach(track => {
          track.enabled = !muted;
        });
      } catch (e) {}
    }
  }

  getMuted(): boolean {
    return this.isMuted;
  }

  addPcmListener(cb: (chunk: Float32Array, rms: number) => void): () => void {
    this.onPcmListeners.add(cb);
    return () => this.onPcmListeners.delete(cb);
  }

  getRecentPcm(seconds = 4): Float32Array {
    const targetSamples = Math.round(seconds * 16000);
    const totalSamples = this.rollingPcmChunks.reduce((acc, c) => acc + c.length, 0);
    const needed = Math.min(totalSamples, targetSamples);
    if (needed <= 0) return new Float32Array(0);

    const merged = new Float32Array(needed);
    let offset = needed;
    for (let i = this.rollingPcmChunks.length - 1; i >= 0 && offset > 0; i--) {
      const chunk = this.rollingPcmChunks[i];
      const take = Math.min(chunk.length, offset);
      offset -= take;
      merged.set(chunk.subarray(chunk.length - take), offset);
    }
    return merged;
  }

  async startRecording(
    onAudioChunk: (base64PCM: string) => void,
    onUserVolume: (vol: number) => void
  ): Promise<void> {
    if (this.isRecording) return;
    
    // Initialize Input AudioContext using native hardware sample rate (e.g. 48000 Hz)
    // so Windows WASAPI driver runs jitter-free without hardware clock mismatch or buffer underruns.
    // Software resampleTo16k handles clean downsampling to 16kHz for ASR.
    const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
    this.inputCtx = new AudioCtxClass();
    
    // Initialize Output AudioContext (prefer 24000 Hz to match Gemini Live 24k PCM stream)
    try {
      this.outputCtx = new AudioCtxClass({ sampleRate: 24000 });
    } catch {
      this.outputCtx = new AudioCtxClass();
    }
    
    // Create Playback Analyser to read volume of played audio
    this.playbackAnalyser = this.outputCtx.createAnalyser();
    this.playbackAnalyser.fftSize = 128;
    this.playbackAnalyser.connect(this.outputCtx.destination);

    if (this.inputCtx.state === 'suspended') {
      this.inputCtx.resume().catch(() => {});
    }
    if (this.outputCtx.state === 'suspended') {
      this.outputCtx.resume().catch(() => {});
    }

    // Get microphone permission with native hardware fidelity (AEC, noise suppression, AGC)
    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (this.selectedDeviceId) {
      audioConstraints.deviceId = { exact: this.selectedDeviceId };
    }

    const stream = await navigator.mediaDevices.getUserMedia({ 
      audio: audioConstraints 
    });

    if (!this.inputCtx) {
      // If context was cleaned up while waiting for permission, stop the tracks and abort gracefully
      stream.getTracks().forEach(track => track.stop());
      return;
    }

    this.micStream = stream;
    if (this.isMuted) {
      try {
        this.micStream.getAudioTracks().forEach(track => {
          track.enabled = false;
        });
      } catch (e) {}
    }
    this.micSource = this.inputCtx.createMediaStreamSource(this.micStream);
    
    // Create Mic Analyser to read volume of mic audio
    this.micAnalyser = this.inputCtx.createAnalyser();
    this.micAnalyser.fftSize = 128;
    this.micSource.connect(this.micAnalyser);

    // Create processor for capturing raw PCM chunk
    this.processor = this.inputCtx.createScriptProcessor(2048, 1, 1);
    this.micAnalyser.connect(this.processor);
    // Route processor output through a zero-gain node so the Web Audio node keeps firing
    // without leaking microphone audio into speakers/headphones (preventing echo/feedback)
    const silentSink = this.inputCtx.createGain();
    silentSink.gain.value = 0;
    this.processor.connect(silentSink);
    silentSink.connect(this.inputCtx.destination);

    this.processor.onaudioprocess = (e) => {
      if (!this.isRecording || this.isMuted) {
        onUserVolume(0);
        return;
      }
      const rawChannelData = e.inputBuffer.getChannelData(0);
      const inputRate = this.inputCtx ? this.inputCtx.sampleRate : 16000;
      const channelData = this.resampleTo16k(rawChannelData, inputRate);

      // Software Preamp with soft-knee compression:
      // Boosts quiet conversational speech from laptop array microphones (at 1.5-2.5 ft distance)
      // to optimal ASR SNR range without harsh digital clipping distortion.
      const PREAMP_GAIN = 2.2;
      for (let i = 0; i < channelData.length; i++) {
        channelData[i] = Math.tanh(channelData[i] * PREAMP_GAIN);
      }
      
      // Save copy to rolling PCM buffer for continuous VoiceGuard biometric verification
      const rawCopy = new Float32Array(channelData);
      this.rollingPcmChunks.push(rawCopy);
      if (this.rollingPcmChunks.length > this.maxRollingChunks) {
        this.rollingPcmChunks.shift();
      }

      // Calculate average volume / RMS
      let sum = 0;
      for (let i = 0; i < channelData.length; i++) {
        sum += channelData[i] * channelData[i];
      }
      const rms = Math.sqrt(sum / channelData.length);
      // Map to 0-100 range
      onUserVolume(Math.min(100, Math.round(rms * 300)));

      this.onPcmListeners.forEach(listener => {
        try { listener(rawCopy, rms); } catch {}
      });

      // Note: Assistant playback interruption is handled authoritatively by Gemini Live's
      // server-side VAD (sending 'interrupted' event). We do not prematurely cut off playback
      // based on client-side mic RMS because speaker acoustic bleed (amplified by preamp)
      // would cause ERA to cut herself off while speaking.

      // Convert to 16-bit PCM little endian at guaranteed 16kHz
      const pcm16Buffer = this.floatTo16BitPCM(channelData);
      const base64PCM = this.arrayBufferToBase64(pcm16Buffer);

      // CONTINUOUS STREAMING: Send 100% of audio frames without artificial gating or dropped pauses.
      // Modern ASR (Faster-Whisper and Gemini Live) have internal deep-learning VADs that
      // require uninterrupted acoustic continuity to correctly transcribe phonemes and natural speech pauses.
      onAudioChunk(base64PCM);
    };

    this.isRecording = true;
    this.nextStartTime = 0;
  }

  stopRecording(): void {
    this.isRecording = false;
    
    if (this.processor) {
      try {
        this.processor.disconnect();
      } catch (e) {}
      this.processor = null;
    }
    if (this.micSource) {
      try {
        this.micSource.disconnect();
      } catch (e) {}
      this.micSource = null;
    }
    if (this.micStream) {
      try {
        this.micStream.getTracks().forEach(track => track.stop());
      } catch (e) {}
      this.micStream = null;
    }
    if (this.inputCtx) {
      try {
        this.inputCtx.close();
      } catch (e) {}
      this.inputCtx = null;
    }
    this.micAnalyser = null;
    this.stopPlayback();
  }

  playChunk(base64Audio: string, onOutputVolume?: (vol: number) => void): void {
    if (!this.outputCtx || !this.playbackAnalyser) return;
    
    try {
      if (this.outputCtx.state === 'suspended') {
        this.outputCtx.resume().catch(() => {});
      }
      const pcm16 = this.base64To16BitPCM(base64Audio);
      const float32 = this.pcmToFloat32(pcm16);
      
      const audioBuffer = this.outputCtx.createBuffer(1, float32.length, 24000);
      audioBuffer.copyToChannel(float32, 0);
      
      const sourceNode = this.outputCtx.createBufferSource();
      sourceNode.buffer = audioBuffer;
      sourceNode.connect(this.playbackAnalyser);
      
      const currentTime = this.outputCtx.currentTime;
      if (this.nextStartTime < currentTime + 0.005) {
        this.nextStartTime = currentTime + 0.01;
      }
      
      sourceNode.start(this.nextStartTime);
      this.nextStartTime += audioBuffer.duration;
      
      this.activeSources.push(sourceNode);
      sourceNode.onended = () => {
        try {
          sourceNode.disconnect();
        } catch (e) {}
        this.activeSources = this.activeSources.filter(n => n !== sourceNode);
        if (this.activeSources.length === 0) {
          this.nextStartTime = 0;
        }
      };

      if (onOutputVolume) {
        let sum = 0;
        for (let i = 0; i < float32.length; i++) {
          sum += float32[i] * float32[i];
        }
        const rms = Math.sqrt(sum / float32.length);
        onOutputVolume(Math.min(100, Math.round(rms * 250)));
      }
    } catch (err) {
      console.error("Error playing audio chunk:", err);
    }
  }

  stopPlayback(): void {
    this.activeSources.forEach(node => {
      try {
        node.onended = null;
        node.stop();
        node.disconnect();
      } catch (e) {}
    });
    this.activeSources = [];
    this.nextStartTime = 0;
  }

  isPlaying(): boolean {
    return this.activeSources.length > 0;
  }

  getMicAnalyser(): AnalyserNode | null {
    return this.micAnalyser;
  }

  getPlaybackAnalyser(): AnalyserNode | null {
    return this.playbackAnalyser;
  }

  cleanup(): void {
    this.stopRecording();
    if (this.outputCtx) {
      try {
        this.outputCtx.close();
      } catch (e) {}
      this.outputCtx = null;
    }
    this.playbackAnalyser = null;
  }

  // Conversions
  private resampleTo16k(input: Float32Array, inputRate: number): Float32Array {
    if (!input || input.length === 0 || inputRate === 16000) {
      return input;
    }
    const ratio = inputRate / 16000;
    const outputLength = Math.round(input.length / ratio);
    const output = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      const srcPos = i * ratio;
      const srcIdx = Math.floor(srcPos);
      const frac = srcPos - srcIdx;
      const s0 = input[srcIdx] !== undefined ? input[srcIdx] : 0;
      const s1 = input[srcIdx + 1] !== undefined ? input[srcIdx + 1] : s0;
      output[i] = s0 + frac * (s1 - s0);
    }
    return output;
  }

  private floatTo16BitPCM(float32Array: Float32Array): ArrayBuffer {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);
    let offset = 0;
    for (let i = 0; i < float32Array.length; i++, offset += 2) {
      let s = Math.max(-1, Math.min(1, float32Array[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return buffer;
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private base64To16BitPCM(base64: string): Int16Array {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const samplesCount = Math.floor(bytes.byteLength / 2);
    return new Int16Array(bytes.buffer, bytes.byteOffset, samplesCount);
  }

  private pcmToFloat32(pcm16: Int16Array): Float32Array {
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32768.0;
    }
    return float32;
  }
}
