import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capPauses, dropUndone, liveStrokes } from '../tools/clean-session.mjs';

const stroke = (t, id) => [
  { t, type: 'stroke', id, x: 1, y: 1, sx: 1, sy: 1, size: 40, color: '112233' },
  { t: t + 10, type: 'pt', id, x: 2, y: 2, sx: 2, sy: 2 },
  { t: t + 20, type: 'end', id },
];

test('liveStrokes follows the undo tree, including branches painted after an undo', () => {
  const events = [
    ...stroke(0, 0), ...stroke(100, 1),
    { t: 200, type: 'undo', id: 1, via: 'button' },
    ...stroke(300, 2),
  ];
  assert.deepEqual([...liveStrokes(events)].sort(), [0, 2]);
});

test('dropUndone removes undone strokes, the undos and the time they took', () => {
  const events = [
    ...stroke(0, 0),
    { t: 50, type: 'size', size: 12 },
    ...stroke(1000, 1),
    { t: 5000, type: 'color', hex: 'aabbcc', via: 'enter' },
    { t: 9000, type: 'undo', id: 1, via: 'button' },
    ...stroke(9500, 2),
  ];
  const out = dropUndone(events);
  assert.deepEqual(out.filter((e) => e.type === 'stroke').map((e) => e.id), [0, 2]);
  assert.equal(out.some((e) => e.type === 'undo'), false);
  // Toolbar changes inside the cut stay, so the replayed UI is still right.
  assert.ok(out.some((e) => e.type === 'color' && e.hex === 'aabbcc'));
  assert.ok(out.some((e) => e.type === 'size' && e.size === 12));
  // Stroke 2 now starts shortly after the surviving events, not 9.5 s in.
  assert.ok(out.find((e) => e.type === 'stroke' && e.id === 2).t < 1500);
  // Time never runs backwards.
  out.forEach((e, i) => assert.ok(i === 0 || e.t >= out[i - 1].t));
});

test('dropUndone leaves a session without undos unchanged', () => {
  const events = [...stroke(0, 0), ...stroke(100, 1)];
  assert.deepEqual(dropUndone(events), events);
});

test('capPauses shortens long gaps and keeps short ones', () => {
  const events = [0, 12, 30, 10030, 10045].map((t) => ({ t, type: 'move', x: 0, y: 0 }));
  assert.deepEqual(capPauses(events, 250).map((e) => e.t), [0, 12, 30, 280, 295]);
});

test('consecutive undos merge into one cut and leave only the kept branch', () => {
  const events = [
    ...stroke(0, 0), ...stroke(100, 1), ...stroke(200, 2),
    { t: 4000, type: 'undo', id: 2, via: 'key' },
    { t: 4100, type: 'undo', id: 1, via: 'key' },
    ...stroke(5000, 3),
  ];
  const out = dropUndone(events);
  assert.deepEqual(out.filter((e) => e.type === 'stroke').map((e) => e.id), [0, 3]);
  assert.ok(out.find((e) => e.type === 'stroke' && e.id === 3).t < 300);
});

test('an undo with nothing to undo (id null) is dropped without cutting kept strokes', () => {
  const events = [{ t: 0, type: 'undo', id: null, via: 'button' }, ...stroke(100, 0)];
  const out = dropUndone(events);
  assert.deepEqual(out.filter((e) => e.type === 'stroke').map((e) => e.id), [0]);
  assert.equal(out.some((e) => e.type === 'undo'), false);
});

test('a stroke cut off without an end still counts, as it does in replay', () => {
  const events = [...stroke(0, 0), { t: 100, type: 'stroke', id: 1, x: 1, y: 1, sx: 1, sy: 1, size: 40, color: '112233' }];
  assert.deepEqual([...liveStrokes(events)].sort(), [0, 1]);
  assert.deepEqual(dropUndone(events).filter((e) => e.type === 'stroke').map((e) => e.id), [0, 1]);
});

test('the visible painting is the same before and after cleaning', () => {
  const events = [
    ...stroke(0, 0), ...stroke(100, 1),
    { t: 300, type: 'undo', id: 1, via: 'button' },
    ...stroke(400, 2), ...stroke(500, 3), ...stroke(600, 4),
    { t: 700, type: 'undo', id: 4, via: 'button' },
    { t: 750, type: 'undo', id: 3, via: 'button' },
    ...stroke(800, 5),
  ];
  const out = dropUndone(events);
  const ids = (list) => [...liveStrokes(list)].sort((a, b) => a - b);
  assert.deepEqual(ids(out), ids(events));
  assert.deepEqual(out.filter((e) => e.type === 'stroke').map((e) => e.id), ids(events));
});

test('command line: --cap and the default cut produce a valid session; bad input fails clearly', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'sitter-test-'));
  const input = join(dir, 'in.json');
  writeFileSync(input, JSON.stringify({ version: 1, session: 's', meta: {}, events: [...stroke(0, 0), ...stroke(9000, 1)] }));
  const run = (...args) => spawnSync(process.execPath, ['tools/clean-session.mjs', ...args], { encoding: 'utf8' });

  const ok = run(input, join(dir, 'nested', 'out.json'), '--cap', '250');
  assert.equal(ok.status, 0, ok.stderr);
  const out = JSON.parse(readFileSync(join(dir, 'nested', 'out.json'), 'utf8'));
  assert.equal(out.session, 's');
  assert.ok(out.events.at(-1).t <= 20 + 250 + 20);

  assert.equal(run(input, join(dir, 'x.json'), '--cap', '0').status, 2);
  assert.match(run(join(dir, 'missing.json'), join(dir, 'x.json')).stderr, /not found/);
  assert.match(run(input, input).stderr, /new file/);
});
