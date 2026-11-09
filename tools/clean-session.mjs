#!/usr/bin/env node
// Prepare a recorded session for a timelapse.
//
//   node tools/clean-session.mjs <in.json> <out.json> [--keep-undone] [--cap <ms>]
//
// By default, strokes that were later undone are removed together with the undo clicks and
// the cursor time spent on them, so the timelapse never flashes a wiped canvas or a mistake.
// Only the final branch of the undo tree survives, so the finished painting is unchanged.
// --cap <ms> shortens every pause between two events to at most <ms>, giving the replay an
// even pace when the painter stalled (slow input, long thinking, a dropped connection).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const STROKE_EVENTS = new Set(['stroke', 'pt', 'end']);
// Toolbar state must survive a cut, or the replayed UI would show the wrong brush or colour.
const UI_EVENTS = new Set(['pass', 'size', 'color', 'viewport', 'save', 'resume']);
// Pause left in place where a cut removed events, so the cursor still glides between strokes.
const CUT_PAUSE_MS = 120;

/**
 * Stroke ids on the final branch of the undo tree: the strokes visible at the end.
 * A stroke cut off without an 'end' (tab closed mid-drag) counts as finished where it stopped,
 * exactly as the replay commits it.
 */
export function liveStrokes(events) {
  const parent = new Map();
  let top = -1;
  let open = null;
  const commit = () => { if (open !== null) top = open; open = null; };
  for (const e of events) {
    if (e.type === 'stroke') { commit(); parent.set(e.id, top); open = e.id; }
    else if (e.type === 'end') { if (e.id === open) commit(); }
    else if (e.type === 'undo') { commit(); if (top >= 0) top = parent.get(top); }
  }
  commit();
  const live = new Set();
  for (let id = top; id >= 0; id = parent.get(id)) live.add(id);
  return live;
}

/** Remove undone strokes, undo events and the dead time around each run of undos. */
export function dropUndone(events) {
  const live = liveStrokes(events);
  const first = new Map();
  events.forEach((e, i) => { if (e.type === 'stroke' && !first.has(e.id)) first.set(e.id, i); });

  // A run of undos is cut back to the first event of the earliest stroke it removed.
  const cut = new Uint8Array(events.length);
  let run = null;
  const close = () => { if (run) cut.fill(1, run[0], run[1] + 1); run = null; };
  events.forEach((e, i) => {
    if (e.type === 'undo') {
      const from = first.get(e.id) ?? i;
      run = run ? [Math.min(run[0], from), i] : [from, i];
    } else if (e.type === 'stroke') close();
  });
  close();

  const out = [];
  let shift = 0;
  let lastKept = null; // original time of the last kept event
  let skipped = false; // events were dropped since lastKept
  events.forEach((e, i) => {
    const keep = STROKE_EVENTS.has(e.type) ? live.has(e.id)
      : e.type === 'undo' ? false
      : !cut[i] || UI_EVENTS.has(e.type);
    if (!keep) { skipped = true; return; }
    // Close the gap left by dropped events, or by a cut that only kept toolbar changes.
    if (lastKept !== null && (skipped || cut[i])) shift += Math.max(0, e.t - lastKept - CUT_PAUSE_MS);
    out.push({ ...e, t: round(e.t - shift) });
    lastKept = e.t;
    skipped = false;
  });
  return out;
}

/** Shorten every gap between consecutive events to at most capMs. */
export function capPauses(events, capMs) {
  let t = 0;
  return events.map((e, i) => {
    if (i > 0) t += Math.min(Math.max(0, e.t - events[i - 1].t), capMs);
    return { ...e, t: round(t) };
  });
}

const round = (v) => Math.round(v * 10) / 10;

function fail(message) {
  console.error(`clean-session: ${message}`);
  process.exit(1);
}

function main(argv) {
  const args = [...argv];
  const flag = (name) => { const i = args.indexOf(name); if (i < 0) return null; const [, v] = args.splice(i, 2); return v ?? ''; };
  const keepUndone = args.includes('--keep-undone');
  if (keepUndone) args.splice(args.indexOf('--keep-undone'), 1);
  const cap = flag('--cap');
  const [input, output] = args;
  if (!input || !output || args.length > 2 || (cap !== null && !(Number(cap) > 0))) {
    console.error('usage: node tools/clean-session.mjs <in.json> <out.json> [--keep-undone] [--cap <ms>]');
    process.exit(2);
  }
  if (resolve(input) === resolve(output)) fail('write to a new file; the input session is kept as recorded');
  let session;
  try { session = JSON.parse(readFileSync(input, 'utf8')); } catch (err) {
    fail(err.code === 'ENOENT' ? `${input} not found` : `${input} is not valid JSON (${err.message})`);
  }
  if (!Array.isArray(session?.events)) fail(`${input} is not a Sitter session (no "events" list)`);
  let events = session.events;
  const before = { events: events.length, seconds: (events.at(-1)?.t ?? 0) / 1000 };
  if (!keepUndone) events = dropUndone(events);
  if (cap !== null) events = capPauses(events, Number(cap));
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(output, JSON.stringify({ ...session, events }));
  console.log(JSON.stringify({
    strokes: events.filter((e) => e.type === 'stroke').length,
    events: [before.events, events.length],
    seconds: [+before.seconds.toFixed(1), +((events.at(-1)?.t ?? 0) / 1000).toFixed(1)],
  }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
