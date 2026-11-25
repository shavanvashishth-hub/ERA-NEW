import { useEffect, useRef } from "react";

/**
 * VoiceOrb
 * ------------------------------------------------------------------
 * The application's primary control. A 3D point-cloud rendered on a
 * canvas — no WebGL, no libraries — that changes both shape and motion
 * with the session state:
 *
 *   idle       dotted globe, slow rotation, warm gold
 *   listening  globe breathes outward with ripples, rose
 *   processing half-formed gyroscope, fast spin
 *   speaking   three intersecting gyroscope rings, warm gold
 *
 * Purely presentational: it renders whatever `state` it is given and
 * reports clicks. All session logic stays with the caller.
 */

export type OrbState = "idle" | "listening" | "processing" | "speaking";

type Look = {
  r: number;
  spin: number;
  spikes: number;
  ringMix: number;
  glow: number;
  a: [number, number, number];
  b: [number, number, number];
};

const LOOKS: Record<OrbState, Look> = {
  idle: { r: 124, spin: 0.18, spikes: 0.035, ringMix: 0, glow: 0.62, a: [230, 169, 74], b: [255, 231, 191] },
  listening: { r: 136, spin: 0.55, spikes: 0.3, ringMix: 0, glow: 0.92, a: [239, 90, 96], b: [255, 214, 214] },
  processing: { r: 108, spin: 1.05, spikes: 0.05, ringMix: 0.45, glow: 0.65, a: [230, 169, 74], b: [255, 236, 200] },
  speaking: { r: 126, spin: 0.3, spikes: 0.04, ringMix: 1, glow: 0.86, a: [245, 196, 110], b: [255, 244, 224] },
};

type Props = {
  state: OrbState;
  onClick?: () => void;
  /** rendered pixel size of the square canvas */
  size?: number;
  className?: string;
  title?: string;
};

const POINTS = 1180;
const TAU = Math.PI * 2;

export function VoiceOrb({ state, onClick, size = 340, className = "", title }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<OrbState>(state);
  stateRef.current = state;

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let W = size;
    let H = size;
    let DPR = 1;

    const fit = () => {
      DPR = Math.min(2, window.devicePixelRatio || 1);
      const rect = cv.getBoundingClientRect();
      W = rect.width || size;
      H = rect.height || size;
      cv.width = Math.round(W * DPR);
      cv.height = Math.round(H * DPR);
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    };
    fit();
    window.addEventListener("resize", fit);

    // ---- point cloud: fibonacci sphere, tagged into 3 rings for the speaking shape
    const pts: { dir: [number, number, number]; ring: number; phase: number; speed: number }[] = [];
    for (let i = 0; i < POINTS; i++) {
      const y = 1 - (i / (POINTS - 1)) * 2;
      const rad = Math.sqrt(Math.max(0, 1 - y * y));
      const th = i * 2.399963229728653;
      pts.push({
        dir: [Math.cos(th) * rad, y, Math.sin(th) * rad],
        ring: i % 3,
        phase: (i * 0.7) % TAU,
        speed: 0.6 + ((i * 37) % 100) / 160,
      });
    }

    const cur = {
      r: 124,
      spin: 0.18,
      spikes: 0.035,
      ringMix: 0,
      glow: 0.62,
      a: [230, 169, 74] as [number, number, number],
      b: [255, 231, 191] as [number, number, number],
    };

    let t = 0;
    let last = performance.now();
    let raf = 0;

    const lerp = (x: number, y: number, e: number) => x + (y - x) * e;
    const rgba = (c: number[], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`;

    const draw = (now: number) => {
      const dt = Math.min(48, now - last) / 1000;
      last = now;
      t += dt;

      const tg = LOOKS[stateRef.current] || LOOKS.idle;
      const e = 1 - Math.exp(-dt * 5.5);
      cur.r = lerp(cur.r, tg.r, e);
      cur.spin = lerp(cur.spin, tg.spin, e);
      cur.spikes = lerp(cur.spikes, tg.spikes, e);
      cur.ringMix = lerp(cur.ringMix, tg.ringMix, e);
      cur.glow = lerp(cur.glow, tg.glow, e);
      for (let k = 0; k < 3; k++) {
        cur.a[k] = lerp(cur.a[k], tg.a[k], e);
        cur.b[k] = lerp(cur.b[k], tg.b[k], e);
      }

      const cx = W / 2;
      const cy = H / 2;
      const R = cur.r * (Math.min(W, H) / 340);

      ctx.clearRect(0, 0, W, H);

      // ripples while listening
      if (stateRef.current === "listening") {
        for (let k = 0; k < 3; k++) {
          const ph = ((t * 0.55) + k / 3) % 1;
          const rippleR = Math.min(Math.min(cx, cy) - 4, R * (0.9 + ph * 0.95));
          ctx.strokeStyle = rgba(cur.a, (1 - ph) * 0.22);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(cx, cy, rippleR, 0, TAU);
          ctx.stroke();
        }
      }

      const ry = t * cur.spin;
      const rx = 0.4 + Math.sin(t * 0.33) * 0.1;
      const cosY = Math.cos(ry);
      const sinY = Math.sin(ry);
      const cosX = Math.cos(rx);
      const sinX = Math.sin(rx);
      const f = 660;
      const spikeAmp =
        cur.spikes * (stateRef.current === "listening" ? 1 + 0.55 * Math.sin(t * 6.5) : 1);

      ctx.globalCompositeOperation = "lighter";

      for (let i = 0; i < POINTS; i++) {
        const p = pts[i];

        // sphere
        const d = 1 + spikeAmp * Math.sin(t * 3.2 * p.speed + p.phase);
        const sx = p.dir[0] * d;
        const sy = p.dir[1] * d;
        const sz = p.dir[2] * d;

        // ring / gyroscope
        const ringR = [0.62, 0.85, 1.03][p.ring];
        const dirSign = p.ring === 1 ? -1 : 1;
        const ang = p.phase + t * dirSign * (0.75 + p.ring * 0.28);
        const bx = Math.cos(ang) * ringR;
        const bz = Math.sin(ang) * ringR;
        const tilt = [0, 1.02, -0.72][p.ring];
        const ct = Math.cos(tilt);
        const st = Math.sin(tilt);
        const ry1 = -bz * st;
        const rz1 = bz * ct;
        const prec = t * (0.22 + p.ring * 0.1);
        const gx0 = bx * Math.cos(prec) - rz1 * Math.sin(prec);
        const gz0 = bx * Math.sin(prec) + rz1 * Math.cos(prec);
        const wob = 1 + 0.06 * Math.sin(t * 2.2 + p.phase);
        const gx = gx0 * wob;
        const gy = ry1 * wob;
        const gz = gz0 * wob;

        const m = cur.ringMix;
        const x = sx * (1 - m) + gx * m;
        const y = sy * (1 - m) + gy * m;
        const z = sz * (1 - m) + gz * m;

        const x1 = x * cosY - z * sinY;
        const z1 = x * sinY + z * cosY;
        const y1 = y * cosX - z1 * sinX;
        const z2 = y * sinX + z1 * cosX;

        const wx = x1 * R;
        const wy = y1 * R;
        const wz = z2 * R;
        const persp = f / (f - wz);
        const px = cx + wx * persp;
        const py = cy + wy * persp;

        const depth = (wz + R) / (2 * R);
        const alpha = 0.1 + 0.82 * Math.pow(depth, 1.25);
        const radius = (0.55 + 1.55 * depth) * persp;

        const c = [
          cur.a[0] + (cur.b[0] - cur.a[0]) * depth * depth,
          cur.a[1] + (cur.b[1] - cur.a[1]) * depth * depth,
          cur.a[2] + (cur.b[2] - cur.a[2]) * depth * depth,
        ];
        ctx.fillStyle = rgba(c, alpha);
        ctx.beginPath();
        ctx.arc(px, py, radius, 0, TAU);
        ctx.fill();
      }

      const coreR = stateRef.current === "listening" ? 16 + 4 * Math.sin(t * 5) : 13;
      const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 3.4);
      cg.addColorStop(0, rgba(cur.b, 0.85 * cur.glow));
      cg.addColorStop(0.35, rgba(cur.a, 0.3 * cur.glow));
      cg.addColorStop(1, rgba(cur.a, 0));
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR * 3.4, 0, TAU);
      ctx.fill();

      ctx.globalCompositeOperation = "source-over";

      if (!reduce) raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", fit);
    };
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-label={title || "Start or stop voice session"}
      title={title}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.();
        }
      }}
      style={{ width: size, height: size, maxWidth: "100%", cursor: "pointer", outline: "none", background: "transparent" }}
      className={`bg-transparent ${className}`}
    />
  );
}

export default VoiceOrb;
