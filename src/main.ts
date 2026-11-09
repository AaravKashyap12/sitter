import { CANVAS_H, CANVAS_W, Stroke, drawGrain, parseHex } from './brush';
import { Painter } from './painter';
import { type Ev, type ReferenceInfo, type SessionFile, type SessionMeta, type UIState, Recorder, Timeline, initialUI, reduce } from './session';

const SIZES = [120, 72, 40, 22, 12, 7, 4, 2];
const PASSES = ['Block-in', 'Form & colour', 'Refinement', 'Fine details'];
const NUMERALS = ['I', 'II', 'III', 'IV'];
const STAGE_W = 1160, STAGE_H = 1200; // the recorded 29:30 frame
const GRAIN_OPACITY = 0.55;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $<HTMLDivElement>('stage');
const paintCanvas = $<HTMLCanvasElement>('paint');
const grainCanvas = $<HTMLCanvasElement>('grain');
const frameEl = $<HTMLDivElement>('frame');
const hexInput = $<HTMLInputElement>('hex');
const hexBox = $<HTMLLabelElement>('hexbox');
const ring = $<HTMLDivElement>('ring');
const cursorEl = document.getElementById('cursor') as unknown as SVGSVGElement;
const toast = $<HTMLDivElement>('toast');
const undoBtn = $<HTMLButtonElement>('undo');
const saveBtn = $<HTMLButtonElement>('save');
const refImg = $<HTMLImageElement>('refimg');

// ---- Reference -------------------------------------------------------------------

function validReference(r: unknown): ReferenceInfo | null {
  if (!r || typeof r !== 'object') return null;
  const { src, credit, alt } = r as Record<string, unknown>;
  if (typeof src !== 'string' || !REF_SRC.test(src)) return null;
  return { src, credit: typeof credit === 'string' ? credit.slice(0, 300) : '', alt: typeof alt === 'string' ? alt.slice(0, 300) : '' };
}

/** reference/reference.json names an image in reference/ plus its credit line. */
async function loadReferenceConfig(): Promise<ReferenceInfo | null> {
  try {
    const res = await fetch('/reference/reference.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const cfg = await res.json() as { image?: unknown; credit?: unknown; alt?: unknown };
    if (typeof cfg.image !== 'string') throw new Error('reference/reference.json needs an "image" file name');
    const ref = validReference({ ...cfg, src: `/reference/${cfg.image}` });
    if (!ref) throw new Error(`reference/reference.json: "${cfg.image}" must be a .jpg, .png or .webp file inside reference/`);
    return ref;
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error('reference/reference.json is not valid JSON');
    throw err;
  }
}

async function showReference(ref: ReferenceInfo | null) {
  refImg.hidden = !ref;
  $('refEmpty').hidden = !!ref;
  $('refCredit').textContent = ref?.credit ?? '';
  if (!ref) { refImg.removeAttribute('src'); return; }
  refImg.alt = ref.alt || 'Reference image';
  refImg.src = ref.src;
  await refImg.decode().catch(() => fail(new Error(`Could not load the reference image ${ref.src}`)));
}

const params = new URLSearchParams(location.search);
const num = (k: string, d: number) => { const v = Number(params.get(k)); return params.has(k) && Number.isFinite(v) ? v : d; };
// Replays load recorded sessions from session/ or the bundled demos from public/demo/.
const SESSION_PATH = /^(session\/session-[0-9A-Za-z_-]{1,80}|demo\/[0-9A-Za-z_-]{1,80})\.json$/;
// Reference images live in reference/ (yours) or public/demo/ (bundled). No other paths are shown.
const REF_SRC = /^\/(reference|demo)\/[0-9A-Za-z][0-9A-Za-z._-]{0,120}\.(jpe?g|png|webp)$/i;

// ---- Static UI ---------------------------------------------------------------

const sizeBtns = SIZES.map((size) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'size';
  b.dataset.size = String(size);
  b.setAttribute('aria-label', `Brush size ${size}`);
  const d = Math.round(Math.min(24, 3 + Math.sqrt(size) * 1.9));
  b.innerHTML = `<span class="blob"><i style="width:${d}px;height:${d}px"></i></span><span class="num">${size}</span>`;
  $('sizes').append(b);
  return b;
});
const passBtns = PASSES.map((name, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'pass';
  b.dataset.pass = String(i);
  b.setAttribute('aria-label', `Pass ${i + 1}: ${name}`);
  b.innerHTML = `<span class="rn">${NUMERALS[i]}</span><span>${name.replace('&', '&amp;')}</span>`;
  $('passes').append(b);
  return b;
});

const painter = new Painter(paintCanvas);
grainCanvas.width = paintCanvas.width;
grainCanvas.height = paintCanvas.height;
drawGrain(grainCanvas);

let scale = 1;
function fit(w: number, h: number) {
  scale = Math.min(w / STAGE_W, h / STAGE_H);
  const x = (w - STAGE_W * scale) / 2, y = (h - STAGE_H * scale) / 2;
  stage.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
function toStage(cx: number, cy: number) {
  const r = stage.getBoundingClientRect();
  return { x: r1((cx - r.left) / scale), y: r1((cy - r.top) / scale) };
}
function canvasRectOnStage() {
  const s = stage.getBoundingClientRect(), f = frameEl.getBoundingClientRect();
  return { x: (f.left - s.left) / scale, y: (f.top - s.top) / scale, w: f.width / scale, h: f.height / scale };
}
function clock(ms: number) {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function renderUI(s: UIState, nowMs: number) {
  sizeBtns.forEach((b, i) => { const on = SIZES[i] === s.size; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  passBtns.forEach((b, i) => { const on = i === s.pass; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  $('passNum').textContent = NUMERALS[s.pass];
  $('passName').textContent = PASSES[s.pass];
  $('swatch').style.background = `#${s.color}`;
  $('statChip').style.background = `#${s.color}`;
  $('statBrush').textContent = String(s.size);
  $('statStrokes').textContent = String(s.depth);
  if (hexInput.value !== s.hexText) hexInput.value = s.hexText;
  hexBox.classList.toggle('focused', s.hexFocus);
  hexBox.classList.toggle('invalid', nowMs - s.hexInvalidAt < 1400);
  undoBtn.classList.toggle('off', s.depth === 0);
  undoBtn.setAttribute('aria-disabled', String(s.depth === 0));
  const showToast = nowMs - s.savedAt < 2400;
  toast.classList.toggle('show', showToast);
  if (showToast) toast.textContent = `Saved ${s.savedFile.replace(/^session\//, '')}`;
}

function placeRing(x: number, y: number, size: number, on: boolean) {
  ring.style.display = on ? 'block' : 'none';
  if (!on) return;
  const d = Math.max(6, size);
  ring.style.width = ring.style.height = `${d}px`;
  ring.style.transform = `translate(${x - d / 2}px, ${y - d / 2}px)`;
}
function overCanvas(x: number, y: number) {
  const c = canvasRectOnStage();
  return x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h;
}

function composite(): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = paintCanvas.width; out.height = paintCanvas.height;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(paintCanvas, 0, 0);
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = GRAIN_OPACITY;
  ctx.drawImage(grainCanvas, 0, 0);
  return out;
}

async function loadSession(path: string): Promise<SessionFile> {
  if (!SESSION_PATH.test(path)) throw new Error(`session path must look like session/session-....json, got ${path}`);
  const res = await fetch(`/${path}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`could not load ${path}: ${res.status}`);
  const file = await res.json() as SessionFile;
  checkEvents(path, file);
  return file;
}

// Session files can be shared, so values that reach styles or the brush are checked before use:
// a colour goes into CSS, and a huge brush size would stall the tab.
const HEX6 = /^[0-9a-f]{6}$/;
function checkEvents(path: string, file: SessionFile) {
  if (!file || !Array.isArray(file.events)) throw new Error(`${path} is not a Sitter session`);
  const finite = (...v: unknown[]) => v.every((n) => typeof n === 'number' && Number.isFinite(n));
  file.events.forEach((e, i) => {
    const bad = (why: string) => { throw new Error(`${path}: event ${i} (${String(e?.type)}) ${why}`); };
    if (!e || typeof e !== 'object' || !finite(e.t)) bad('has no valid time');
    switch (e.type) {
      case 'stroke':
        if (!HEX6.test(e.color)) bad('has an invalid colour');
        if (!finite(e.size) || e.size <= 0 || e.size > 200) bad('has an invalid brush size');
        if (!finite(e.id, e.x, e.y, e.sx, e.sy)) bad('has invalid coordinates');
        break;
      case 'pt': if (!finite(e.id, e.x, e.y, e.sx, e.sy)) bad('has invalid coordinates'); break;
      case 'move': case 'down': case 'up': if (!finite(e.x, e.y)) bad('has invalid coordinates'); break;
      case 'color': if (!HEX6.test(e.hex)) bad('has an invalid colour'); break;
      case 'size': if (!SIZES.includes(e.size)) bad('has an unknown brush size'); break;
      case 'pass': if (!Number.isInteger(e.pass) || e.pass < 0 || e.pass >= PASSES.length) bad('has an unknown pass'); break;
    }
  });
}

function fail(err: unknown) {
  console.error(err);
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:auto 24px 24px auto;max-width:560px;padding:14px 18px;border-radius:10px;background:#3a1f1a;color:#f3d6cc;font:14px/1.4 -apple-system,sans-serif;z-index:20';
  box.textContent = String(err instanceof Error ? err.message : err);
  document.body.append(box);
}

// ---- Live studio ---------------------------------------------------------------

function sessionName() {
  const d = new Date(), p = (n: number) => String(n).padStart(2, '0');
  return `session-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function startLive() {
  document.body.classList.add('live');
  fit(innerWidth, innerHeight);
  addEventListener('resize', () => { fit(innerWidth, innerHeight); log({ t: rec.time(), type: 'viewport', w: innerWidth, h: innerHeight, scale: r1(scale * 1000) / 1000 }); });

  const tree = new Map<number, { parent: number; depth: number }>();
  let ui = initialUI();
  let nextId = 0;
  let rec: Recorder;
  const meta: SessionMeta = {
    app: 'sitter', startedAt: new Date().toISOString(), stage: { w: STAGE_W, h: STAGE_H },
    canvas: { ...canvasRectOnStage(), units: [CANVAS_W, CANVAS_H] }, userAgent: navigator.userAgent,
    reference: await loadReferenceConfig().catch((err) => { fail(err); return null; }),
  };

  // The bare URL continues the current session (a stray navigation must not split the log); ?new=1 starts fresh.
  const explicit = params.get('resume');
  let remembered: string | null = null;
  try { remembered = localStorage.getItem('sitter.session'); } catch { /* storage blocked */ }
  const resume = explicit ?? (params.has('new') || !remembered ? null : `session/${remembered}.json`);
  let file: SessionFile | null = null;
  if (resume) {
    try { file = await loadSession(resume); } catch (err) {
      if (explicit) throw new Error(`Could not load ${resume}. Open /?new=1 to start a new session.`);
      console.warn('last session not found, starting a new one', err);
    }
  }
  if (file) {
    const tl = new Timeline(file.events, { speed: 1, maxGap: 0, gapTo: 0 });
    for (const s of tl.byId.values()) {
      painter.strokes.set(s.id, s);
      tree.set(s.id, { parent: s.parent, depth: s.depth });
      nextId = Math.max(nextId, s.id + 1);
    }
    rec = new Recorder(file.session, file.meta, file.events);
    // A resumed session keeps the reference it started with.
    if (file.meta && 'reference' in file.meta) meta.reference = validReference(file.meta.reference);
    // A stroke cut off by the reload is committed exactly as replay commits it.
    const last = tl.strokes[tl.strokes.length - 1];
    if (last && !file.events.some((e) => e.type === 'end' && e.id === last.stroke.id)) rec.push({ t: rec.time(), type: 'end', id: last.stroke.id });
    const resumed: Ev = { t: rec.time(), type: 'resume' };
    rec.push(resumed);
    ui = { ...reduce(tl.ui(Infinity), resumed, tree), hexInvalidAt: -1e9, savedAt: -1e9 };
    painter.show(ui.top);
  } else rec = new Recorder(sessionName(), meta);
  void showReference(meta.reference ?? null);
  history.replaceState(null, '', `?resume=session/${rec.session}.json`);
  try { localStorage.setItem('sitter.session', rec.session); } catch { /* storage blocked */ }

  const log = (e: Ev) => {
    rec.push(e);
    const next = reduce(ui, e, tree);
    if (next !== ui) { ui = next; renderUI(ui, e.t); }
  };
  rec.onStatus = () => {
    $('saveDot').classList.toggle('error', rec.status !== 'ok');
    $('saveText').textContent = rec.status === 'conflict' ? 'Open in another tab — autosave stopped'
      : rec.status === 'error' ? 'Autosave failed — retrying' : 'Autosaving';
    $('saveText').title = rec.session;
  };
  rec.start();
  renderUI(ui, 0);
  setInterval(() => { renderUI(ui, rec.time()); $('statTime').textContent = clock(rec.time()); }, 250);

  // Every pointer movement, drawing or not, so the cursor path can be replayed.
  let active: Stroke | null = null;
  let lastClient = { x: -1, y: -1 };
  const updateRing = () => {
    const p = toStage(lastClient.x, lastClient.y);
    placeRing(p.x, p.y, ui.size, overCanvas(p.x, p.y));
  };
  addEventListener('pointermove', (e) => {
    lastClient = { x: e.clientX, y: e.clientY };
    if (!active) { const p = toStage(e.clientX, e.clientY); log({ t: rec.time(e.timeStamp), type: 'move', x: p.x, y: p.y }); }
    updateRing();
  }, true);
  addEventListener('pointerdown', (e) => { const p = toStage(e.clientX, e.clientY); log({ t: rec.time(e.timeStamp), type: 'down', x: p.x, y: p.y }); }, true);
  addEventListener('pointerup', (e) => { const p = toStage(e.clientX, e.clientY); log({ t: rec.time(e.timeStamp), type: 'up', x: p.x, y: p.y }); }, true);
  document.documentElement.addEventListener('pointerleave', () => { log({ t: rec.time(), type: 'leave' }); ring.style.display = 'none'; });

  // ---- Canvas strokes
  const toCanvas = (cx: number, cy: number) => {
    const r = paintCanvas.getBoundingClientRect();
    return { x: r1(((cx - r.left) / r.width) * CANVAS_W), y: r1(((cy - r.top) / r.height) * CANVAS_H) };
  };
  let raf = 0;
  const paintSoon = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; if (active) painter.show(active.parent, active.id, active.dabs.length); });
  };
  paintCanvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || active) return;
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur?.();
    paintCanvas.setPointerCapture(e.pointerId);
    const c = toCanvas(e.clientX, e.clientY), s = toStage(e.clientX, e.clientY);
    const id = nextId++;
    log({ t: rec.time(e.timeStamp), type: 'stroke', id, x: c.x, y: c.y, sx: s.x, sy: s.y, size: ui.size, color: ui.color });
    const k = tree.get(id)!;
    active = new Stroke(id, k.parent, k.depth, ui.size, ui.color, c.x, c.y);
    painter.strokes.set(id, active);
    paintSoon();
  });
  const addPoint = (e: PointerEvent) => {
    if (!active) return;
    const c = toCanvas(e.clientX, e.clientY), s = toStage(e.clientX, e.clientY);
    const last = active.pts[active.pts.length - 1];
    if (c.x === last.x && c.y === last.y) return;
    log({ t: rec.time(e.timeStamp), type: 'pt', id: active.id, x: c.x, y: c.y, sx: s.x, sy: s.y });
    active.add(c.x, c.y);
  };
  paintCanvas.addEventListener('pointermove', (e) => {
    if (!active) return;
    for (const ce of e.getCoalescedEvents?.() ?? [e]) addPoint(ce);
    paintSoon();
  });
  const endStroke = (e: PointerEvent) => {
    if (!active) return;
    if (e.type === 'pointerup') addPoint(e);
    const s = active;
    s.finish();
    active = null;
    cancelAnimationFrame(raf); raf = 0;
    log({ t: rec.time(e.timeStamp), type: 'end', id: s.id });
    painter.show(ui.top);
  };
  paintCanvas.addEventListener('pointerup', endStroke);
  paintCanvas.addEventListener('pointercancel', endStroke);
  paintCanvas.addEventListener('lostpointercapture', endStroke);
  paintCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---- Toolbar
  sizeBtns.forEach((b, i) => b.addEventListener('click', () => { log({ t: rec.time(), type: 'size', size: SIZES[i] }); updateRing(); }));
  passBtns.forEach((b, i) => b.addEventListener('click', () => log({ t: rec.time(), type: 'pass', pass: i })));
  const undo = (via: string) => {
    if (active) return;
    log({ t: rec.time(), type: 'undo', id: ui.top >= 0 ? ui.top : null, via });
    painter.show(ui.top);
  };
  undoBtn.addEventListener('click', () => undo('button'));
  addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && document.activeElement !== hexInput) { e.preventDefault(); undo('key'); }
  });

  let saving = false;
  saveBtn.addEventListener('click', async () => {
    if (saving) return;
    saving = true;
    try {
      const blob = await new Promise<Blob>((ok, no) => composite().toBlob((b) => (b ? ok(b) : no(new Error('PNG encode failed'))), 'image/png'));
      await rec.flush();
      // Saved by the dev server into session/: no browser download, so no save dialog can interrupt the agent.
      const res = await fetch(`/api/save?session=${rec.session}`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob });
      const { file, error } = await res.json() as { file?: string; error?: string };
      if (!res.ok || !file) throw new Error(`Save failed: ${error ?? res.status}`);
      log({ t: rec.time(), type: 'save', file });
      void rec.flush();
    } catch (err) { fail(err); } finally { saving = false; }
  });

  // ---- Hex field: click selects all, Enter applies, a valid value also applies on blur.
  let selectOnUp = false;
  hexInput.addEventListener('focus', () => { log({ t: rec.time(), type: 'hexfocus' }); hexInput.select(); selectOnUp = true; });
  hexInput.addEventListener('mouseup', (e) => { if (selectOnUp) { e.preventDefault(); selectOnUp = false; } });
  hexInput.addEventListener('input', () => { selectOnUp = false; log({ t: rec.time(), type: 'hexinput', value: hexInput.value }); });
  const applyHex = (via: string) => {
    const hex = parseHex(hexInput.value);
    if (hex) log({ t: rec.time(), type: 'color', hex, via });
    else log({ t: rec.time(), type: 'hexinvalid', value: hexInput.value });
    return hex;
  };
  hexInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (applyHex('enter')) hexInput.select(); }
    else if (e.key === 'Escape') { log({ t: rec.time(), type: 'hexinput', value: ui.color }); hexInput.blur(); }
  });
  hexInput.addEventListener('blur', () => {
    const hex = parseHex(hexInput.value);
    if (hex && hex !== ui.color) applyHex('blur');
    log({ t: rec.time(), type: 'hexblur' });
  });
}

// ---- Replay ----------------------------------------------------------------------

interface Piece {
  ready: Promise<void>;
  duration: number;
  renderAt(t: number): void;
  play(): void;
  pause(): void;
  replay(): void;
  setSize(w: number, h: number, dpr?: number): void;
}
declare global { interface Window { sitter: Piece } }

function startReplay(path: string) {
  document.body.classList.add('replay');
  const capture = params.get('capture') === '1';
  let tl: Timeline | null = null;
  let t = 0, playing = false, last = 0, raf = 0;
  let fixed: { w: number; h: number } | null = null;
  let hovered: Element | null = null;
  fit(innerWidth, innerHeight);
  addEventListener('resize', () => { if (!fixed) fit(innerWidth, innerHeight); });

  const hud = $<HTMLDivElement>('hud');
  const hudPlay = $<HTMLButtonElement>('hudPlay');
  const hudScrub = $<HTMLInputElement>('hudScrub');

  const frame = (p: number) => {
    if (!tl) return;
    const ui = tl.ui(p);
    const act = tl.active(p);
    if (act) painter.show(act.stroke.parent, act.stroke.id, act.n);
    else painter.show(ui.top);
    renderUI(ui, p * 1000);
    $('statTime').textContent = clock(tl.clock(p));

    const c = tl.cursor(p);
    cursorEl.style.display = c ? 'block' : 'none';
    let target: Element | null = null;
    if (c) {
      cursorEl.style.transform = `translate(${c.x - 5}px, ${c.y - 2.5}px) scale(${ui.down ? 0.86 : 1})`;
      placeRing(c.x, c.y, ui.size, overCanvas(c.x, c.y));
      const r = stage.getBoundingClientRect();
      target = document.elementFromPoint(r.left + c.x * scale, r.top + c.y * scale)?.closest('.size, .pass, .btn, .hex') ?? null;
    } else placeRing(0, 0, 0, false);
    if (hovered !== target) { hovered?.classList.remove('hover', 'press'); hovered = target; }
    hovered?.classList.add('hover');
    hovered?.classList.toggle('press', ui.down && !hovered.classList.contains('hex'));

    if (!capture) {
      hudScrub.value = String(Math.round((p / tl.duration) * 1000));
      $('hudTime').textContent = `${clock(p * 1000)} / ${clock(tl.duration * 1000)}`;
      hudPlay.textContent = playing ? 'Pause' : 'Play';
    }
  };

  const tick = (now: number) => {
    raf = 0;
    if (!playing || !tl) return;
    t = Math.min(tl.duration, t + (now - last) / 1000);
    last = now;
    frame(t);
    if (t >= tl.duration) { playing = false; frame(t); return; }
    raf = requestAnimationFrame(tick);
  };
  const piece: Piece = {
    ready: Promise.resolve(),
    duration: 0,
    renderAt(time: number) { if (!tl) return; t = Math.max(0, Math.min(tl.duration, time)); frame(t); },
    play() { if (!tl || playing) return; if (t >= tl.duration) t = 0; playing = true; last = performance.now(); raf ||= requestAnimationFrame(tick); },
    pause() { playing = false; cancelAnimationFrame(raf); raf = 0; frame(t); },
    replay() { t = 0; piece.pause(); piece.play(); },
    // dpr is always 1 for capture; the canvas backing (1215x1620) is sized for frames up to 1.5x.
    setSize(w: number, h: number) { fixed = { w, h }; fit(w, h); frame(t); },
  };
  piece.ready = (async () => {
    const file = await loadSession(path);
    tl = new Timeline(file.events, { speed: Math.max(0.01, num('speed', 1)), maxGap: num('maxGap', 1.5), gapTo: num('gapTo', 0.4) });
    for (const s of tl.byId.values()) painter.strokes.set(s.id, s);
    piece.duration = tl.duration;
    const recorded = file.meta && 'reference' in file.meta ? validReference(file.meta.reference) : undefined;
    await showReference(recorded !== undefined ? recorded : await loadReferenceConfig().catch(() => null));
    await document.fonts.ready;
    frame(0);
    if (!capture) {
      hud.hidden = false;
      hudPlay.addEventListener('click', () => (playing ? piece.pause() : piece.play()));
      hudScrub.addEventListener('input', () => { piece.pause(); piece.renderAt((Number(hudScrub.value) / 1000) * tl!.duration); });
      addEventListener('keydown', (e) => {
        if (e.key === ' ') { e.preventDefault(); playing ? piece.pause() : piece.play(); }
        else if (e.key === 'ArrowRight') piece.renderAt(t + 5);
        else if (e.key === 'ArrowLeft') piece.renderAt(t - 5);
      });
    }
    if (params.get('autoplay') !== '0') piece.play();
  })();
  piece.ready.catch(fail);
  window.sitter = piece;
}

const replayPath = params.get('replay');
if (replayPath) startReplay(replayPath);
else startLive().catch(fail);
