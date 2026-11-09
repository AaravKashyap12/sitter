import { Stroke } from './brush';

// ---- Event log -------------------------------------------------------------
// t is ms since session start. x/y on pointer events are frame units (the 1160x1200 studio);
// stroke points carry canvas units (x, y) and frame units (sx, sy).

export type Ev =
  | { t: number; type: 'move' | 'down' | 'up'; x: number; y: number }
  | { t: number; type: 'leave' }
  | { t: number; type: 'stroke'; id: number; x: number; y: number; sx: number; sy: number; size: number; color: string }
  | { t: number; type: 'pt'; id: number; x: number; y: number; sx: number; sy: number }
  | { t: number; type: 'end'; id: number }
  | { t: number; type: 'size'; size: number }
  | { t: number; type: 'color'; hex: string; via: string }
  | { t: number; type: 'hexinput'; value: string }
  | { t: number; type: 'hexinvalid'; value: string }
  | { t: number; type: 'hexfocus' | 'hexblur' }
  | { t: number; type: 'pass'; pass: number }
  | { t: number; type: 'undo'; id: number | null; via: string }
  | { t: number; type: 'save'; file: string }
  | { t: number; type: 'resume' }
  | { t: number; type: 'viewport'; w: number; h: number; scale: number };

export interface ReferenceInfo { src: string; credit: string; alt: string }

export interface SessionMeta {
  app: string;
  startedAt: string;
  stage: { w: number; h: number };
  canvas: { x: number; y: number; w: number; h: number; units: [number, number] };
  userAgent: string;
  /** The reference shown beside the canvas, so a replay shows the same one. Older sessions lack it. */
  reference?: ReferenceInfo | null;
}

export interface SessionFile { version: number; session: string; meta: SessionMeta; events: Ev[] }

// ---- UI state --------------------------------------------------------------
// One reducer drives the toolbar in both live and replay, so replay shows exactly what was on screen.

export interface UIState {
  size: number;
  color: string;
  hexText: string;
  hexFocus: boolean;
  hexInvalidAt: number;
  pass: number;
  down: boolean;
  top: number;
  depth: number;
  savedAt: number;
  savedFile: string;
}

export const initialUI = (): UIState => ({
  size: 40, color: '3b2c24', hexText: '3b2c24', hexFocus: false, hexInvalidAt: -1e9,
  pass: 0, down: false, top: -1, depth: 0, savedAt: -1e9, savedFile: '',
});

/** `strokes` maps stroke id -> parent/depth; the reducer fills it on 'stroke' events. */
export function reduce(s: UIState, e: Ev, strokes: Map<number, { parent: number; depth: number }>): UIState {
  switch (e.type) {
    case 'down': return { ...s, down: true };
    case 'up': return { ...s, down: false };
    case 'stroke': strokes.set(e.id, { parent: s.top, depth: s.depth + 1 }); return s;
    case 'end': {
      const k = strokes.get(e.id);
      return k ? { ...s, top: e.id, depth: k.depth } : s;
    }
    case 'undo': {
      if (s.top < 0) return s;
      const k = strokes.get(s.top)!;
      return { ...s, top: k.parent, depth: k.depth - 1 };
    }
    case 'size': return { ...s, size: e.size };
    case 'color': return { ...s, color: e.hex, hexText: e.hex };
    case 'hexinput': return { ...s, hexText: e.value };
    case 'hexinvalid': return { ...s, hexInvalidAt: e.t };
    case 'hexfocus': return { ...s, hexFocus: true };
    case 'hexblur': return { ...s, hexFocus: false, hexText: s.color };
    case 'pass': return { ...s, pass: e.pass };
    case 'save': return { ...s, savedAt: e.t, savedFile: e.file };
    // A reload drops focus and any held button, exactly as the fresh page shows it.
    case 'resume': return { ...s, down: false, hexFocus: false, hexText: s.color };
    default: return s;
  }
}

// ---- Recorder: continuous autosave to the dev server -----------------------

const r1 = (v: number) => Math.round(v * 10) / 10;

export class Recorder {
  readonly events: Ev[];
  private sent: number;
  private busy = false;
  private offset: number;
  private readonly t0 = performance.now();
  private last = 0;
  status: 'ok' | 'error' | 'conflict' = 'ok';
  onStatus: () => void = () => {};

  constructor(readonly session: string, readonly meta: SessionMeta, prior: Ev[] = []) {
    this.events = prior;
    this.sent = prior.length;
    this.offset = prior.length ? prior[prior.length - 1].t + 1000 : 0;
    this.last = this.offset;
  }

  /** Session-relative ms for a performance.now()-clock timestamp. */
  time(stamp = performance.now()): number {
    const t = r1(Math.max(this.last, stamp - this.t0 + this.offset));
    this.last = t;
    return t;
  }

  push(e: Ev) { this.events.push(e); }

  start() {
    void this.flush();
    setInterval(() => void this.flush(), 1000);
    const final = () => {
      const events = this.events.slice(this.sent);
      if (!events.length || this.status === 'conflict') return;
      const body = JSON.stringify({ session: this.session, offset: this.sent, events });
      navigator.sendBeacon('/api/log', new Blob([body], { type: 'text/plain' }));
    };
    addEventListener('pagehide', final);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') final(); });
  }

  async flush(): Promise<void> {
    if (this.busy || this.status === 'conflict') return;
    if (this.sent === this.events.length && this.sent > 0) return;
    this.busy = true;
    const end = this.events.length;
    try {
      const res = await fetch('/api/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: this.session, meta: this.meta, offset: this.sent, events: this.events.slice(this.sent, end) }),
      });
      const body = await res.json() as { have?: number; conflict?: boolean };
      const have = body.have ?? this.sent;
      if (body.conflict || have > this.events.length) {
        // Another tab owns this session file: stop writing rather than merge two histories.
        this.status = 'conflict';
      } else if (res.status === 409) {
        this.sent = have;
        this.busy = false;
        return this.flush();
      } else {
        if (res.ok) this.sent = have;
        this.status = res.ok ? 'ok' : 'error';
      }
    } catch {
      this.status = 'error';
    }
    this.busy = false;
    this.onStatus();
  }
}

// ---- Replay timeline -------------------------------------------------------

export interface TimelineOptions { speed: number; maxGap: number; gapTo: number }

interface Sample { p: number; x: number; y: number }
export interface ReplayStroke { stroke: Stroke; startP: number; endP: number; times: number[] }

const DENSE = 0.12; // gaps up to this are real motion: interpolate straight through
const GLIDE = 0.3; // longer gaps: hold, then glide into the next sample

/** Fraction of the way from one sample to the next at playback time p. */
function frac(p0: number, p1: number, p: number): number {
  const g = p1 - p0;
  if (g <= 0 || p >= p1) return 1;
  if (p <= p0) return 0;
  if (g <= DENSE) return (p - p0) / g;
  const w = Math.min(g, GLIDE);
  const u = Math.min(1, Math.max(0, (p - (p1 - w)) / w));
  return u * u * (3 - 2 * u);
}

function lastAtOrBefore(arr: { p: number }[] | number[], p: number): number {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    const v = typeof arr[m] === 'number' ? arr[m] as number : (arr[m] as { p: number }).p;
    if (v <= p) { ans = m; lo = m + 1; } else hi = m - 1;
  }
  return ans;
}

export class Timeline {
  readonly p: number[] = []; // playback seconds per event
  readonly duration: number;
  readonly strokes: ReplayStroke[] = [];
  readonly byId = new Map<number, Stroke>();
  private readonly samples: Sample[] = [];
  private readonly hidden: number[] = []; // playback times of 'leave'
  private readonly uiTimes: number[] = [];
  private readonly uiStates: UIState[] = [];

  constructor(readonly events: Ev[], opt: TimelineOptions, readonly tail = 2.5) {
    let p = 0;
    for (let i = 0; i < events.length; i++) {
      if (i > 0) {
        const gap = (events[i].t - events[i - 1].t) / 1000 / opt.speed;
        p += opt.maxGap > 0 && gap > opt.maxGap ? opt.gapTo : gap;
      }
      this.p.push(p);
    }
    this.duration = p + tail;

    const tree = new Map<number, { parent: number; depth: number }>();
    let ui = initialUI();
    this.uiTimes.push(-Infinity); this.uiStates.push(ui);
    const apply = (e: Ev, pi: number) => {
      // Replay UI timers (invalid flash, save toast) run on the playback clock.
      const next = reduce(ui, { ...e, t: pi * 1000 }, tree);
      if (next !== ui) { ui = next; this.uiTimes.push(pi); this.uiStates.push(ui); }
    };
    let open: ReplayStroke | null = null;
    // A stroke cut off without an 'end' (tab closed mid-drag) is committed where it stopped.
    const close = (pi: number) => {
      if (!open) return;
      open.stroke.finish();
      open.endP = pi;
      apply({ t: 0, type: 'end', id: open.stroke.id }, pi);
      open = null;
    };
    events.forEach((e, i) => {
      const pi = this.p[i];
      switch (e.type) {
        case 'move': case 'down': case 'up': this.samples.push({ p: pi, x: e.x, y: e.y }); break;
        case 'leave': this.hidden.push(pi); return;
        case 'stroke': {
          close(pi);
          this.samples.push({ p: pi, x: e.sx, y: e.sy });
          const stroke = new Stroke(e.id, ui.top, ui.depth + 1, e.size, e.color, e.x, e.y);
          this.byId.set(e.id, stroke);
          open = { stroke, startP: pi, endP: Infinity, times: [pi] };
          this.strokes.push(open);
          this.startPs.push(pi);
          break;
        }
        case 'pt':
          this.samples.push({ p: pi, x: e.sx, y: e.sy });
          if (open && open.stroke.id === e.id) {
            const before = open.stroke.pts.length;
            open.stroke.add(e.x, e.y);
            if (open.stroke.pts.length > before) open.times.push(pi);
          }
          return;
        case 'end':
          if (open && open.stroke.id === e.id) close(pi);
          return;
        case 'undo': close(pi); break;
      }
      if (e.type !== 'move') apply(e, pi);
    });
    close(this.p[this.p.length - 1] ?? 0);
  }

  private readonly startPs: number[] = [];

  ui(p: number): UIState { return this.uiStates[lastAtOrBefore(this.uiTimes, p)]; }

  /** The stroke being painted at p and how many of its dabs are down. */
  active(p: number): { stroke: Stroke; n: number } | null {
    const i = lastAtOrBefore(this.startPs, p);
    if (i < 0) return null;
    const rs = this.strokes[i];
    if (p >= rs.endP) return null;
    const j = lastAtOrBefore(rs.times, p);
    const s = rs.stroke;
    const arc = j + 1 < rs.times.length
      ? s.cum[j] + (s.cum[j + 1] - s.cum[j]) * frac(rs.times[j], rs.times[j + 1], p)
      : s.length;
    return { stroke: s, n: s.dabsUpTo(arc) };
  }

  cursor(p: number): { x: number; y: number } | null {
    const i = lastAtOrBefore(this.samples, p);
    if (i < 0) return null;
    const h = lastAtOrBefore(this.hidden, p);
    if (h >= 0 && this.hidden[h] >= this.samples[i].p) return null;
    const a = this.samples[i], b = this.samples[i + 1];
    if (!b) return { x: a.x, y: a.y };
    const f = frac(a.p, b.p, p);
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  }

  /** Session clock (ms) at playback time p; runs fast through compressed pauses. */
  clock(p: number): number {
    const i = lastAtOrBefore(this.p, p);
    if (i < 0) return 0;
    const j = i + 1;
    if (j >= this.p.length || this.p[j] === this.p[i]) return this.events[i].t;
    const f = Math.min(1, (p - this.p[i]) / (this.p[j] - this.p[i]));
    return this.events[i].t + (this.events[j].t - this.events[i].t) * f;
  }
}
