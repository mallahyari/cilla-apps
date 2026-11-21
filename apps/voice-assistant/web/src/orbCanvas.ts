/**
 * 60fps HiDPI organic liquid Voice Orb canvas renderer.
 * Reacts in real time to microphone input (listening) and Cilla Mini TTS output (speaking).
 */

export type OrbVisualState = "idle" | "listening" | "thinking" | "speaking";

interface RGB {
  r: number;
  g: number;
  b: number;
}

interface Palette {
  c1: RGB;
  c2: RGB;
  c3: RGB;
  glow: RGB;
}

const PALETTES: Record<OrbVisualState, Palette> = {
  idle: {
    c1: { r: 20, g: 184, b: 166 }, // Persian turquoise
    c2: { r: 56, g: 189, b: 248 }, // luminous sky
    c3: { r: 99, g: 102, b: 241 }, // soft indigo
    glow: { r: 14, g: 165, b: 233 },
  },
  listening: {
    c1: { r: 244, g: 63, b: 94 }, // vivid rose
    c2: { r: 251, g: 113, b: 133 }, // warm coral
    c3: { r: 249, g: 115, b: 22 }, // sunlit tangerine
    glow: { r: 244, g: 63, b: 94 },
  },
  thinking: {
    c1: { r: 245, g: 158, b: 11 }, // Persian saffron
    c2: { r: 168, g: 85, b: 247 }, // soft violet
    c3: { r: 59, g: 130, b: 246 }, // azure
    glow: { r: 245, g: 158, b: 11 },
  },
  speaking: {
    c1: { r: 16, g: 185, b: 129 }, // emerald
    c2: { r: 6, g: 182, b: 212 }, // turquoise
    c3: { r: 20, g: 184, b: 166 }, // jade
    glow: { r: 16, g: 185, b: 129 },
  },
};

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function lerpRGB(a: RGB, b: RGB, t: number): RGB {
  return {
    r: lerp(a.r, b.r, t),
    g: lerp(a.g, b.g, t),
    b: lerp(a.b, b.b, t),
  };
}

function rgba(c: RGB, a: number) {
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${a})`;
}

interface Ripple {
  r: number;
  alpha: number;
  speed: number;
}

export class VoiceOrbCanvas {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private state: OrbVisualState = "idle";
  private cur: Palette = {
    c1: { ...PALETTES.idle.c1 },
    c2: { ...PALETTES.idle.c2 },
    c3: { ...PALETTES.idle.c3 },
    glow: { ...PALETTES.idle.glow },
  };
  private smoothEnergy = 0;
  private spectrum = new Uint8Array(64);
  private smoothBins = new Float32Array(48);
  private ripples: Ripple[] = [];
  private lastRippleAt = 0;
  private raf = 0;
  private energyProvider: () => { level: number; spectrum?: Uint8Array };

  constructor(
    canvas: HTMLCanvasElement,
    energyProvider: () => { level: number; spectrum?: Uint8Array }
  ) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
    this.energyProvider = energyProvider;
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.loop(performance.now());
  }

  setState(next: OrbVisualState) {
    this.state = next;
    if (next === "listening" || next === "speaking") {
      this.ripples.push({ r: 64, alpha: 0.45, speed: 1.4 });
    }
  }

  private resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth || 260;
    const h = this.canvas.clientHeight || 260;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
  }

  private loop = (now: number) => {
    this.draw(now * 0.001);
    this.raf = requestAnimationFrame(this.loop);
  };

  private draw(t: number) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;
    const cx = w / 2;
    const cy = h / 2;
    const ctx = this.ctx;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Smoothly blend palette toward active state
    const target = PALETTES[this.state];
    const blend = 0.07;
    this.cur.c1 = lerpRGB(this.cur.c1, target.c1, blend);
    this.cur.c2 = lerpRGB(this.cur.c2, target.c2, blend);
    this.cur.c3 = lerpRGB(this.cur.c3, target.c3, blend);
    this.cur.glow = lerpRGB(this.cur.glow, target.glow, blend);

    // Read live audio energy + spectrum
    const { level, spectrum } = this.energyProvider();
    const rawEnergy =
      this.state === "thinking"
        ? 0.25 + 0.14 * Math.sin(t * 4.2)
        : this.state === "idle"
          ? 0.05 + 0.03 * Math.sin(t * 1.6)
          : level;
    this.smoothEnergy = lerp(this.smoothEnergy, rawEnergy, 0.2);

    if (spectrum && spectrum.length > 0) {
      const step = Math.max(1, Math.floor(spectrum.length / this.smoothBins.length));
      for (let i = 0; i < this.smoothBins.length; i++) {
        const v = (spectrum[Math.min(spectrum.length - 1, i * step)] || 0) / 255;
        this.smoothBins[i] = lerp(this.smoothBins[i], v, 0.28);
      }
    } else {
      for (let i = 0; i < this.smoothBins.length; i++) {
        this.smoothBins[i] = lerp(this.smoothBins[i], 0, 0.15);
      }
    }

    // Spawn expanding ripples on voice peaks
    if (
      (this.state === "listening" || this.state === "speaking") &&
      this.smoothEnergy > 0.18 &&
      t - this.lastRippleAt > 0.52
    ) {
      this.lastRippleAt = t;
      this.ripples.push({
        r: 68 + this.smoothEnergy * 10,
        alpha: 0.38 + this.smoothEnergy * 0.25,
        speed: 1.05 + this.smoothEnergy * 0.9,
      });
    }

    // 1. Soft sunlit ambient halo behind orb
    const haloR = 112 + this.smoothEnergy * 24;
    const halo = ctx.createRadialGradient(cx, cy, 34, cx, cy, haloR);
    halo.addColorStop(0, rgba(this.cur.glow, 0.24 + this.smoothEnergy * 0.18));
    halo.addColorStop(0.6, rgba(this.cur.c2, 0.09 + this.smoothEnergy * 0.07));
    halo.addColorStop(1, rgba(this.cur.glow, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
    ctx.fill();

    // 2. Expanding harmonic ripples
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const rp = this.ripples[i];
      rp.r += rp.speed;
      rp.alpha *= 0.968;
      if (rp.alpha < 0.01 || rp.r > Math.min(w, h) * 0.5) {
        this.ripples.splice(i, 1);
        continue;
      }
      ctx.strokeStyle = rgba(this.cur.glow, rp.alpha);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(cx, cy, rp.r, 0, Math.PI * 2);
      ctx.fillStyle = "transparent";
      ctx.stroke();
    }

    // 3. Radial equalizer bars when listening or speaking
    if (this.state === "listening" || this.state === "speaking") {
      const n = this.smoothBins.length;
      const baseR = 77 + this.smoothEnergy * 6;
      ctx.lineCap = "round";
      for (let i = 0; i < n; i++) {
        const angle = (i / n) * Math.PI * 2 - Math.PI / 2 + t * 0.18;
        const bin = this.smoothBins[i];
        const barLen = 4 + bin * 26 + this.smoothEnergy * 6;
        const x1 = cx + Math.cos(angle) * baseR;
        const y1 = cy + Math.sin(angle) * baseR;
        const x2 = cx + Math.cos(angle) * (baseR + barLen);
        const y2 = cy + Math.sin(angle) * (baseR + barLen);
        ctx.strokeStyle = rgba(i % 2 === 0 ? this.cur.c1 : this.cur.c2, 0.25 + bin * 0.65);
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    }

    // 4. Thinking orbital sparks
    if (this.state === "thinking") {
      for (let k = 0; k < 3; k++) {
        const a = t * (2.2 + k * 0.55) + (k * Math.PI * 2) / 3;
        const rx = 82 + k * 6;
        const ry = 76 - k * 4;
        const px = cx + Math.cos(a) * rx;
        const py = cy + Math.sin(a) * ry;
        ctx.fillStyle = rgba(k === 0 ? this.cur.c1 : k === 1 ? this.cur.c2 : this.cur.c3, 0.85);
        ctx.beginPath();
        ctx.arc(px, py, 3.6 - k * 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 5. Organic morphing fluid sphere
    const baseRadius = 64 + this.smoothEnergy * 9;
    const points = 72;
    const speed =
      this.state === "thinking" ? 2.8 : this.state === "idle" ? 1.0 : 2.1 + this.smoothEnergy * 2.2;
    const wobble =
      this.state === "idle" ? 2.4 : this.state === "thinking" ? 4.2 : 3.5 + this.smoothEnergy * 11;

    ctx.save();
    ctx.beginPath();
    for (let i = 0; i <= points; i++) {
      const a = (i / points) * Math.PI * 2;
      const binIdx = Math.floor((i / points) * this.smoothBins.length) % this.smoothBins.length;
      const binBoost = this.smoothBins[binIdx] * 8;
      const wave1 = Math.sin(a * 3 + t * speed) * wobble * 0.55;
      const wave2 = Math.cos(a * 5 - t * speed * 1.3) * wobble * 0.32;
      const wave3 = Math.sin(a * 2 + t * speed * 0.7) * wobble * 0.25;
      const r = baseRadius + wave1 + wave2 + wave3 + binBoost;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();

    // Rich multi-stop liquid gradient inside the sphere
    const gx = cx - 22 + Math.cos(t * 0.9) * 12;
    const gy = cy - 22 + Math.sin(t * 1.1) * 12;
    const grad = ctx.createRadialGradient(gx, gy, 8, cx, cy, baseRadius + 18);
    grad.addColorStop(0, "rgba(255, 255, 255, 0.92)");
    grad.addColorStop(0.24, rgba(this.cur.c2, 0.95));
    grad.addColorStop(0.68, rgba(this.cur.c1, 0.96));
    grad.addColorStop(1, rgba(this.cur.c3, 0.98));

    ctx.shadowColor = rgba(this.cur.glow, 0.34);
    ctx.shadowBlur = 28;
    ctx.shadowOffsetY = 10;
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();

    // 6. Soft porcelain glass highlight crescent
    ctx.save();
    const spec = ctx.createRadialGradient(cx - 20, cy - 24, 2, cx - 16, cy - 18, 34);
    spec.addColorStop(0, "rgba(255, 255, 255, 0.65)");
    spec.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = spec;
    ctx.beginPath();
    ctx.ellipse(cx - 16, cy - 22, 26, 16, -0.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
  }
}
