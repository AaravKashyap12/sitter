// Painterly round brush: a per-stroke bristle tip stamped along the path.
// Everything is a pure function of (stroke id, size, colour, points), so live painting,
// undo rebuilds and replay all produce the same pixels.

export const CANVAS_W = 810; // logical canvas units == frame units in the 1160x1200 studio
export const CANVAS_H = 1080;
// Backing pixels per logical unit: 1215x1620, so a 1.5x (1740x1800) capture maps the canvas 1:1.
export const BACKING = 1.5;
export const GROUND = '#e9e3d6';

export interface Dab { x: number; y: number; s: number; a: number; rot: number; sc: number }

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0: number, e1: number, v: number) => { const t = clamp01((v - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
function lerpAngle(a: number, b: number, k: number) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * k;
}

export function parseHex(raw: string): string | null {
  const v = raw.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{6}$/.test(v)) return v;
  if (/^[0-9a-f]{3}$/.test(v)) return v.split('').map((c) => c + c).join('');
  return null;
}

// Tips are deterministic, so a small LRU is enough; keeping one per stroke would grow without bound.
const MAX_TIPS = 96;
const tips = new Map<number, HTMLCanvasElement>();

export class Stroke {
  readonly dabs: Dab[] = [];
  readonly pts: { x: number; y: number }[] = [];
  readonly cum: number[] = [0]; // arc length at each point
  complete = false;
  private next = 0;
  private angle = NaN;
  private readonly rand: () => number;
  private readonly spacing: number;
  private readonly alpha: number;

  constructor(
    readonly id: number,
    readonly parent: number,
    readonly depth: number,
    readonly size: number,
    readonly color: string,
    x: number,
    y: number,
  ) {
    this.rand = mulberry32(id * 2654435761 + 17);
    this.spacing = Math.max(0.3, size * 0.075);
    const overlaps = size / this.spacing;
    const coverage = 0.985 - 0.025 * smooth(4, 60, size);
    this.alpha = 1 - Math.pow(1 - coverage, 1 / overlaps);
    this.pts.push({ x, y });
  }

  get length() { return this.cum[this.cum.length - 1]; }

  add(x: number, y: number) {
    if (this.complete) return;
    const a = this.pts[this.pts.length - 1];
    const len = Math.hypot(x - a.x, y - a.y);
    if (len < 1e-3) return;
    const c0 = this.length, c1 = c0 + len;
    this.pts.push({ x, y });
    this.cum.push(c1);
    const theta = Math.atan2(y - a.y, x - a.x);
    if (Number.isNaN(this.angle)) this.angle = theta;
    const r = this.rand, size = this.size;
    while (this.next <= c1) {
      const f = (this.next - c0) / len;
      this.angle = lerpAngle(this.angle, theta, 0.35);
      const jit = (r() - 0.5) * size * 0.05;
      const ramp = 0.6 + 0.4 * smooth(0, Math.max(2, size * 0.35), this.next);
      const load = 0.72 + 0.28 * Math.exp(-this.next / (size * 9 + 300));
      this.dabs.push({
        x: a.x + (x - a.x) * f - Math.sin(theta) * jit,
        y: a.y + (y - a.y) * f + Math.cos(theta) * jit,
        s: this.next,
        a: this.alpha * (0.85 + 0.15 * r()) * ramp * load,
        rot: this.angle + (r() - 0.5) * 0.12,
        sc: 0.96 + 0.08 * r(),
      });
      this.next += this.spacing;
    }
  }

  // A click without movement becomes one loaded dab: a small cluster of rotated stamps.
  finish() {
    if (this.complete) return;
    this.complete = true;
    if (this.length >= 1) return;
    const r = this.rand, p = this.pts[0], size = this.size;
    const n = Math.max(4, Math.round(size / this.spacing));
    for (let i = 0; i < n; i++) {
      const ang = r() * Math.PI * 2, d = r() * size * 0.05;
      this.dabs.push({
        x: p.x + Math.cos(ang) * d, y: p.y + Math.sin(ang) * d, s: 0,
        a: this.alpha * (0.85 + 0.15 * r()), rot: r() * Math.PI * 2, sc: 0.9 + 0.14 * r(),
      });
    }
  }

  // Number of dabs laid down once the brush has travelled `arc` along the path.
  dabsUpTo(arc: number): number {
    let lo = 0, hi = this.dabs.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.dabs[m].s <= arc + 1e-6) lo = m + 1; else hi = m; }
    return lo;
  }

  tip(): HTMLCanvasElement {
    let t = tips.get(this.id);
    if (t) tips.delete(this.id);
    else t = makeTip(this.id, this.size, this.color);
    tips.set(this.id, t); // most recent last
    if (tips.size > MAX_TIPS) tips.delete(tips.keys().next().value as number);
    return t;
  }

  stamp(ctx: CanvasRenderingContext2D, from: number, to: number) {
    if (to <= from) return;
    const tip = this.tip(), h = tip.width / 2;
    for (let i = from; i < to; i++) {
      const d = this.dabs[i];
      const c = Math.cos(d.rot) * d.sc, s = Math.sin(d.rot) * d.sc;
      ctx.setTransform(c, s, -s, c, d.x * BACKING, d.y * BACKING);
      ctx.globalAlpha = d.a;
      ctx.drawImage(tip, -h, -h);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
  }
}

// The tip's x axis is the travel direction, so per-bristle variation across y draws streaks.
function makeTip(id: number, size: number, hex: string): HTMLCanvasElement {
  const r = mulberry32(id * 7919 + 3);
  const R = (size * BACKING) / 2;
  const D = Math.ceil(R * 2 * 1.1) + 4;
  const cv = document.createElement('canvas');
  cv.width = cv.height = D;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(D, D);
  const base = [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];

  const strength = smooth(5, 30, size); // tiny brushes are just soft round points
  const nB = Math.round(Math.min(64, Math.max(6, size * 0.55)));
  const bristle: number[] = [], shade: number[] = [];
  for (let i = 0; i < nB + 2; i++) {
    // Mostly full bristles with the odd dry one; the visible streaks come from tone, like ridges in paint.
    const gap = r() < 0.07;
    bristle.push(gap ? 0.35 : 0.8 + 0.2 * r());
    shade.push((r() - 0.5) * 2);
  }
  const ph = [r() * 6.283, r() * 6.283, r() * 6.283];
  const soft = 0.5 - 0.32 * smooth(4, 40, size);

  for (let py = 0; py < D; py++) {
    const v = (py + 0.5 - D / 2) / R;
    const bf = clamp01((v + 1) / 2) * nB;
    const bi = Math.floor(bf), bt = bf - bi;
    const k = (1 - Math.cos(bt * Math.PI)) / 2;
    const bVal = bristle[bi] * (1 - k) + bristle[bi + 1] * k;
    const sVal = shade[bi] * (1 - k) + shade[bi + 1] * k;
    for (let px = 0; px < D; px++) {
      const u = (px + 0.5 - D / 2) / R;
      const rad = Math.hypot(u, v);
      if (rad > 1.12) continue;
      const th = Math.atan2(v, u);
      const edge = 1 - 0.07 * strength * (0.5 + 0.25 * Math.sin(3 * th + ph[0]) + 0.15 * Math.sin(7 * th + ph[1]) + 0.1 * Math.sin(13 * th + ph[2]));
      const fall = smooth(edge, edge * (1 - soft), rad);
      if (fall <= 0) continue;
      const grain = 1 - 0.08 * strength * r();
      const alpha = fall * (1 - strength * (1 - bVal)) * grain;
      const o = (py * D + px) * 4;
      const tint = sVal * 14 * strength + (r() - 0.5) * 6 * strength;
      img.data[o] = base[0] + tint;
      img.data[o + 1] = base[1] + tint;
      img.data[o + 2] = base[2] + tint;
      img.data[o + 3] = alpha * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

// Linen weave, multiplied over the paint so the canvas tooth shows through every layer.
export function drawGrain(cv: HTMLCanvasElement) {
  const W = cv.width, H = cv.height;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const r = mulberry32(90210);
  const rowJ = Array.from({ length: H }, () => r()), colJ = Array.from({ length: W }, () => r());
  const P = 3.4;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const wx = Math.sin((x / P) * Math.PI * 2 + colJ[x] * 0.6);
      const wy = Math.sin((y / P) * Math.PI * 2 + rowJ[y] * 0.6);
      const over = ((Math.floor(x / P) + Math.floor(y / P)) & 1) ? wx : wy;
      const thread = 0.5 + 0.5 * over;
      const slub = 0.5 * (rowJ[y] + colJ[x]);
      const v = 255 - (thread * 26 + slub * 14 + r() * 10);
      const o = (y * W + x) * 4;
      img.data[o] = v; img.data[o + 1] = v - 2; img.data[o + 2] = v - 6; img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
