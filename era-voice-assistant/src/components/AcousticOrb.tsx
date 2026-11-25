import { useEffect, useRef } from 'react';
import { Loader2, Mic, MicOff, Power } from 'lucide-react';
import { VIBE_PALETTES, type AudioMetrics, type SessionState, type VibeTheme } from '../types/era';

interface AcousticOrbProps {
  state: SessionState;
  theme: VibeTheme;
  isMuted: boolean;
  getAudioMetrics: () => AudioMetrics | null;
  onTogglePower: () => void;
}

export function AcousticOrb({
  state,
  theme,
  isMuted,
  getAudioMetrics,
  onTogglePower,
}: AcousticOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<SessionState>(state);
  const themeRef = useRef<VibeTheme>(theme);
  const mutedRef = useRef<boolean>(isMuted);

  stateRef.current = state;
  themeRef.current = theme;
  mutedRef.current = isMuted;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let animationId = 0;
    let phase = 0;
    let smoothedEnergy = 0;
    const smoothedBins = new Float32Array(32);

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const targetW = Math.max(1, Math.floor(rect.width * dpr));
      const targetH = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const render = () => {
      const rect = canvas.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      const cx = width / 2;
      const cy = height / 2;
      const minDim = Math.min(width, height);

      ctx.clearRect(0, 0, width, height);

      const currentState = stateRef.current;
      const palette = VIBE_PALETTES[themeRef.current];
      const [r1, g1, b1] = palette.rgb;
      const [r2, g2, b2] = palette.secondaryRgb;

      const metrics = getAudioMetrics();
      let targetEnergy = 0;

      if (currentState === 'speaking' && metrics) {
        targetEnergy = 0.22 + metrics.outputLevel * 0.95;
      } else if (currentState === 'listening' && metrics && !mutedRef.current) {
        targetEnergy = 0.08 + metrics.inputLevel * 0.85;
      } else if (currentState === 'connecting') {
        targetEnergy = 0.16;
      } else {
        targetEnergy = 0.03;
      }

      smoothedEnergy += (targetEnergy - smoothedEnergy) * 0.14;
      phase += prefersReducedMotion
        ? 0.004
        : currentState === 'speaking'
          ? 0.042
          : currentState === 'connecting'
            ? 0.055
            : 0.018;

      for (let i = 0; i < 32; i++) {
        const raw = metrics ? metrics.bins[i] ?? 0 : 0;
        const activeTarget =
          currentState === 'listening' && mutedRef.current
            ? 0
            : currentState === 'disconnected'
              ? 0
              : raw;
        smoothedBins[i] += (activeTarget - smoothedBins[i]) * 0.22;
      }

      const baseRadius = minDim * 0.265;

      // 1. Atmospheric outer radial glow
      const glowRadius = baseRadius * (1.85 + smoothedEnergy * 0.65);
      const glowGrad = ctx.createRadialGradient(cx, cy, baseRadius * 0.4, cx, cy, glowRadius);
      const glowAlpha =
        currentState === 'disconnected'
          ? 0.10
          : currentState === 'speaking'
            ? 0.34 + smoothedEnergy * 0.18
            : 0.20 + smoothedEnergy * 0.16;

      glowGrad.addColorStop(0, `rgba(${r1}, ${g1}, ${b1}, ${glowAlpha})`);
      glowGrad.addColorStop(0.55, `rgba(${r2}, ${g2}, ${b2}, ${glowAlpha * 0.35})`);
      glowGrad.addColorStop(1, 'rgba(7, 7, 10, 0)');
      ctx.fillStyle = glowGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, glowRadius, 0, Math.PI * 2);
      ctx.fill();

      // 2. Subtle outer reference ring
      ctx.strokeStyle = `rgba(255, 255, 255, ${currentState === 'disconnected' ? 0.07 : 0.11})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, baseRadius * 1.48, 0, Math.PI * 2);
      ctx.stroke();

      // 3. Connecting orbital sweep arc
      if (currentState === 'connecting') {
        ctx.save();
        ctx.strokeStyle = `rgba(${r2}, ${g2}, ${b2}, 0.85)`;
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(cx, cy, baseRadius * 1.24, phase * 1.6, phase * 1.6 + Math.PI * 0.72);
        ctx.stroke();

        ctx.strokeStyle = `rgba(${r1}, ${g1}, ${b1}, 0.45)`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, baseRadius * 1.34, -phase * 1.2, -phase * 1.2 + Math.PI * 0.5);
        ctx.stroke();
        ctx.restore();
      }

      // 4. Harmonic fluid waveform rings (3 layered closed splines)
      const layers = currentState === 'disconnected' ? 1 : 3;
      const points = 96;

      for (let layer = 0; layer < layers; layer++) {
        const layerScale = 1 + layer * 0.12;
        const layerOpacity =
          currentState === 'disconnected'
            ? 0.28
            : layer === 0
              ? 0.88
              : layer === 1
                ? 0.46
                : 0.22;

        ctx.beginPath();
        for (let i = 0; i <= points; i++) {
          const t = (i / points) * Math.PI * 2;
          const binIdx = Math.floor(((i % points) / points) * 32);
          const binMirrorIdx = binIdx < 16 ? binIdx * 2 : (31 - binIdx) * 2;
          const freqAmp = smoothedBins[binMirrorIdx % 32] ?? 0;

          const harmonic1 = Math.sin(t * 3 + phase * (1.2 + layer * 0.35));
          const harmonic2 = Math.cos(t * 5 - phase * (0.9 + layer * 0.25));
          const harmonic3 = Math.sin(t * 8 + phase * 1.8);

          const idleBreath = Math.sin(phase * 0.7 + layer) * (minDim * 0.008);
          const dynamicDisp =
            (harmonic1 * 0.45 + harmonic2 * 0.35 + harmonic3 * 0.2) *
              (smoothedEnergy * minDim * 0.068) +
            freqAmp * (minDim * 0.055) * (1 - layer * 0.22);

          const radius =
            baseRadius * layerScale +
            (currentState === 'disconnected' ? idleBreath : idleBreath + dynamicDisp);

          const x = cx + Math.cos(t) * radius;
          const y = cy + Math.sin(t) * radius;

          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.closePath();

        const strokeGrad = ctx.createLinearGradient(
          cx - baseRadius,
          cy - baseRadius,
          cx + baseRadius,
          cy + baseRadius
        );
        strokeGrad.addColorStop(0, `rgba(${r1}, ${g1}, ${b1}, ${layerOpacity})`);
        strokeGrad.addColorStop(0.5, `rgba(${r2}, ${g2}, ${b2}, ${layerOpacity})`);
        strokeGrad.addColorStop(1, `rgba(${r1}, ${g1}, ${b1}, ${layerOpacity})`);

        ctx.strokeStyle = strokeGrad;
        ctx.lineWidth = layer === 0 ? 2.25 : 1.35;
        ctx.stroke();

        if (layer === 0 && currentState !== 'disconnected') {
          ctx.fillStyle = `rgba(${r1}, ${g1}, ${b1}, ${0.06 + smoothedEnergy * 0.08})`;
          ctx.fill();
        }
      }

      // 5. Radial spectrum ticks during active speaking/listening
      if (currentState === 'listening' || currentState === 'speaking') {
        const tickCount = 48;
        const tickBase = baseRadius * 1.48;
        ctx.lineCap = 'round';
        for (let i = 0; i < tickCount; i++) {
          const angle = (i / tickCount) * Math.PI * 2 - Math.PI / 2;
          const bin = smoothedBins[(i * 2) % 32] ?? 0;
          const tickLen = 3 + bin * (currentState === 'speaking' ? 18 : 13);
          const alpha = 0.16 + bin * 0.65;
          ctx.strokeStyle = `rgba(${r2}, ${g2}, ${b2}, ${alpha})`;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(angle) * tickBase, cy + Math.sin(angle) * tickBase);
          ctx.lineTo(
            cx + Math.cos(angle) * (tickBase + tickLen),
            cy + Math.sin(angle) * (tickBase + tickLen)
          );
          ctx.stroke();
        }
      }

      animationId = requestAnimationFrame(render);
    };

    animationId = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(animationId);
      observer.disconnect();
    };
  }, [getAudioMetrics]);

  const palette = VIBE_PALETTES[theme];
  const isActive = state === 'listening' || state === 'speaking';

  const buttonLabel =
    state === 'disconnected'
      ? 'Start voice session with ERA'
      : state === 'connecting'
        ? 'Cancel connecting to ERA'
        : 'End voice session with ERA';

  return (
    <div className="relative flex items-center justify-center w-[min(84vw,340px)] h-[min(84vw,340px)] sm:w-[380px] sm:h-[380px] lg:w-[420px] lg:h-[420px] select-none">
      <canvas
        ref={canvasRef}
        className="w-full h-full pointer-events-none"
        aria-hidden="true"
      />

      <button
        type="button"
        onClick={onTogglePower}
        aria-label={buttonLabel}
        style={{
          boxShadow: isActive
            ? `0 0 42px -6px ${palette.glow}, inset 0 1px 1px rgba(255,255,255,0.22)`
            : '0 12px 32px rgba(0, 0, 0, 0.6), inset 0 1px 1px rgba(255,255,255,0.12)',
        }}
        className="absolute z-10 flex items-center justify-center w-[88px] h-[88px] sm:w-[96px] sm:h-[96px] rounded-full bg-[#111118]/90 backdrop-blur-xl border border-white/15 text-white transition-transform duration-150 ease-out hover:scale-105 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-4 focus-visible:ring-offset-[#07070A] cursor-pointer"
      >
        {state === 'connecting' ? (
          <Loader2 className="w-8 h-8 animate-spin text-white/90" strokeWidth={1.8} />
        ) : state === 'disconnected' ? (
          <Power className="w-8 h-8 text-white/90" strokeWidth={1.75} />
        ) : isMuted ? (
          <MicOff className="w-8 h-8 text-white/60" strokeWidth={1.75} />
        ) : (
          <Mic
            className="w-8 h-8 transition-colors duration-200"
            style={{ color: state === 'speaking' ? palette.secondary : '#FFFFFF' }}
            strokeWidth={1.85}
          />
        )}
      </button>
    </div>
  );
}
