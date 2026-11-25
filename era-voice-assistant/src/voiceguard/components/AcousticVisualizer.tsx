import { useEffect, useRef } from 'react';
import type { LockState } from '../types';

interface AcousticVisualizerProps {
  analyser: AnalyserNode | null;
  isActive: boolean;
  lockState: LockState;
  livePitchHz: number | null;
  liveRmsDb: number;
  vadSpeaking: boolean;
}

export function AcousticVisualizer({
  analyser,
  isActive,
  lockState,
  livePitchHz,
  liveRmsDb,
  vadSpeaking,
}: AcousticVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let rafId = 0;

    const strokeColor =
      lockState === 'LOCKED_INTRUDER_ALERT'
        ? '#ef4444'
        : lockState === 'UNLOCKED_OWNER_VERIFIED'
          ? '#10b981'
          : '#06b6d4';

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      if (canvas.width !== Math.floor(rect.width * dpr) || canvas.height !== Math.floor(rect.height * dpr)) {
        canvas.width = Math.floor(rect.width * dpr);
        canvas.height = Math.floor(rect.height * dpr);
      }

      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      // Background calibration grid
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
      ctx.lineWidth = 1;
      const cols = 12;
      const rows = 4;
      for (let c = 1; c < cols; c++) {
        const x = (w / cols) * c;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let r = 1; r < rows; r++) {
        const y = (h / rows) * r;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // Center zero-axis
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();

      if (analyser && isActive) {
        const freqData = new Uint8Array(analyser.frequencyBinCount);
        const timeData = new Float32Array(analyser.fftSize);
        analyser.getByteFrequencyData(freqData);
        analyser.getFloatTimeDomainData(timeData);

        // Spectrum bars (lower half subtle backdrop)
        const barCount = 48;
        const step = Math.max(1, Math.floor((freqData.length * 0.45) / barCount));
        const barW = w / barCount;
        ctx.fillStyle =
          lockState === 'LOCKED_INTRUDER_ALERT'
            ? 'rgba(239, 68, 68, 0.18)'
            : lockState === 'UNLOCKED_OWNER_VERIFIED'
              ? 'rgba(16, 185, 129, 0.18)'
              : 'rgba(6, 182, 212, 0.16)';

        for (let i = 0; i < barCount; i++) {
          const val = freqData[i * step] / 255;
          const barH = val * (h * 0.42);
          ctx.fillRect(i * barW + 1, h - barH, Math.max(1, barW - 2), barH);
        }

        // Time-domain oscilloscope waveform
        ctx.strokeStyle = vadSpeaking ? '#22d3ee' : strokeColor;
        ctx.lineWidth = 2 * dpr;
        ctx.beginPath();
        const sliceW = w / timeData.length;
        for (let i = 0; i < timeData.length; i++) {
          const x = i * sliceW;
          const y = h / 2 + timeData[i] * (h * 0.42);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      } else {
        // Idle flat calibration trace
        ctx.strokeStyle =
          lockState === 'LOCKED_INTRUDER_ALERT'
            ? 'rgba(239, 68, 68, 0.45)'
            : lockState === 'UNLOCKED_OWNER_VERIFIED'
              ? 'rgba(16, 185, 129, 0.45)'
              : 'rgba(6, 182, 212, 0.35)';
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath();
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
        ctx.stroke();
      }

      rafId = requestAnimationFrame(draw);
    };

    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [analyser, isActive, lockState, vadSpeaking]);

  return (
    <div className="relative border border-slate-800 bg-[#0B0F17] rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-800/80 text-xs font-mono text-slate-400">
        <div className="flex items-center gap-3">
          <span className="text-slate-300 font-medium">Acoustic Waveform · 16 kHz PCM</span>
          <span aria-hidden="true">/</span>
          <span className={vadSpeaking ? 'text-cyan-400' : 'text-slate-500'}>
            {isActive ? (vadSpeaking ? 'Speech Active' : 'Mic Armed') : 'Standby'}
          </span>
        </div>
        <div className="flex items-center gap-4 tabular-nums">
          <span>
            F0: <strong className="text-slate-200">{livePitchHz ? `${livePitchHz.toFixed(0)} Hz` : '--- Hz'}</strong>
          </span>
          <span>
            Level: <strong className="text-slate-200">{liveRmsDb > -90 ? `${liveRmsDb.toFixed(1)} dB` : '-inf dB'}</strong>
          </span>
        </div>
      </div>
      <canvas ref={canvasRef} className="block w-full h-44" />
    </div>
  );
}
