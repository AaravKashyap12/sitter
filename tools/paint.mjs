#!/usr/bin/env node
// Paint a plan in the running studio with real browser input.
//
//   node tools/paint.mjs <plan.json> [--url http://127.0.0.1:5195/] [--pace 1] [--headed] [--port 9335]
//
// Opens the studio with ?new=1 in a private Chrome and performs every step of the plan the way
// a person would: click the pass, click the brush size, click the hex field, type the colour,
// press Enter, then drag each stroke. Input goes through Chrome's input pipeline (DevTools
// Input.dispatch*), so the page sees trusted pointer and key events and logs them as usual.
// The page is only read to find button positions and to check progress, never scripted.
//
// --pace scales every wait: 1 is a calm human-like pace (about 0.2 s per stroke), 0.25 is quick.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openChrome, sleep } from './chrome.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const [, value] = args.splice(i, 2);
  return value;
};
const headed = args.includes('--headed');
if (headed) args.splice(args.indexOf('--headed'), 1);
const base = option('--url', 'http://127.0.0.1:5195/');
const pace = Number(option('--pace', '1'));
const port = Number(option('--port', '9335'));
const [planFile] = args;
if (!planFile || !(pace > 0)) {
  console.error('usage: node tools/paint.mjs <plan.json> [--url http://127.0.0.1:5195/] [--pace 1] [--headed] [--port 9335]');
  process.exit(2);
}
const plan = JSON.parse(readFileSync(planFile, 'utf8'));
assert(Array.isArray(plan.layers) && plan.width === 810 && plan.height === 1080, `${planFile} is not a Sitter plan`);

const PASSES = ['Block-in', 'Form & colour', 'Refinement', 'Fine details'];
const VIEWPORT = { width: 1240, height: 1220 };
const wait = (ms) => sleep(ms * pace);
const waitUntil = (due) => sleep(Math.max(0, due - performance.now()));

const layoutQuery = `(() => {
  const rect = (el) => el.getBoundingClientRect().toJSON();
  const centre = (el) => { const r = rect(el); return [r.left + r.width / 2, r.top + r.height / 2]; };
  return {
    canvas: rect(document.querySelector('#paint')),
    sizes: Object.fromEntries([...document.querySelectorAll('button[data-size]')].map((b) => [b.dataset.size, centre(b)])),
    passes: [...document.querySelectorAll('button[data-pass]')].map(centre),
    hex: centre(document.querySelector('#hex')),
    save: centre(document.querySelector('#save')),
  };
})()`;
const stateQuery = `({
  strokes: Number(document.querySelector('#statStrokes').textContent),
  size: Number(document.querySelector('button[data-size][aria-pressed="true"]')?.dataset.size),
  pass: Number(document.querySelector('button[data-pass][aria-pressed="true"]')?.dataset.pass),
  hex: document.querySelector('#hex').value,
  session: document.querySelector('#saveText').title,
  status: document.querySelector('#saveText').textContent,
})`;

let page;
try {
  page = await openChrome({ ...VIEWPORT, port, headless: !headed });
} catch (err) {
  console.error(`paint failed: ${err.message}`);
  process.exit(1);
}
try {
  let position = [VIEWPORT.width / 2, 40];
  const mouse = async (type, [x, y], held = false) => {
    const params = { type, x, y, button: type === 'mouseMoved' && !held ? 'none' : 'left', buttons: held ? 1 : 0, pointerType: 'mouse' };
    if (type !== 'mouseMoved') params.clickCount = 1;
    await page.send('Input.dispatchMouseEvent', params);
    position = [x, y];
  };
  // Glide between targets with eased intermediate moves instead of teleporting.
  const travel = async ([toX, toY], steps) => {
    const [fromX, fromY] = position;
    const start = performance.now();
    for (let i = 1; i <= steps; i++) {
      const k = i / steps, e = k * k * (3 - 2 * k);
      await waitUntil(start + 12 * pace * i);
      await mouse('mouseMoved', [fromX + e * (toX - fromX), fromY + e * (toY - fromY)]);
    }
  };
  const click = async (point) => {
    await travel(point, 6);
    await mouse('mousePressed', point, true);
    await wait(40);
    await mouse('mouseReleased', point);
    await wait(60);
  };
  const stroke = async (path, n) => {
    await travel(path[0], 3 + (n % 4 === 0 ? 1 : 0));
    const start = performance.now();
    await mouse('mousePressed', path[0], true);
    const duration = pace * (path.length === 1 ? 82 + (n * 7) % 18 : Math.max(88, path.length * 13));
    for (let i = 1; i < path.length; i++) {
      await waitUntil(start + (i * duration) / path.length);
      await mouse('mouseMoved', path[i], true);
    }
    await waitUntil(start + duration);
    await mouse('mouseReleased', path.at(-1));
    await wait(20 + (n * 13) % 40);
  };
  const type = async (text) => {
    for (const key of [...text, 'Enter']) {
      const enter = key === 'Enter';
      const fields = { key, code: enter ? 'Enter' : /\d/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`, windowsVirtualKeyCode: enter ? 13 : key.toUpperCase().charCodeAt(0) };
      await page.send('Input.dispatchKeyEvent', { type: enter ? 'rawKeyDown' : 'keyDown', ...fields, ...(enter ? {} : { text: key, unmodifiedText: key }) });
      await wait(35);
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...fields });
      await wait(35);
    }
  };

  await page.send('Page.navigate', { url: new URL('?new=1', base).href });
  let layout = null;
  for (let i = 0; i < 100 && !layout; i++) {
    layout = await page.evaluate(`document.querySelector('#statStrokes') && document.querySelector('#saveText').title ? ${layoutQuery} : null`).catch(() => null);
    if (!layout) await sleep(100);
  }
  assert(layout, `the studio did not load at ${base}; start it with npm run dev`);
  const start = await page.evaluate(stateQuery);
  assert.equal(start.strokes, 0, 'expected an empty canvas from ?new=1');
  const { canvas } = layout;
  const screen = ([x, y]) => [canvas.left + (x * canvas.width) / plan.width, canvas.top + (y * canvas.height) / plan.height];
  console.log(`painting ${plan.strokes} strokes into ${start.session} (about ${Math.round((plan.estimatedSeconds * pace) / 60)} min)`);

  let pass = -1, size = 0, hex = '', n = 0;
  const started = Date.now();
  for (const layer of plan.layers) {
    const layerPass = PASSES.indexOf(layer.pass);
    assert(layerPass >= 0, `unknown pass ${layer.pass}`);
    if (layerPass !== pass) {
      if (pass >= 0) {
        const state = await page.evaluate(stateQuery);
        assert.equal(state.strokes, n, `the studio shows ${state.strokes} strokes after ${PASSES[pass]}, expected ${n}`);
        console.log(`${PASSES[pass]} done: ${n} strokes, ${Math.round((Date.now() - started) / 1000)} s`);
      }
      pass = layerPass;
      await click(layout.passes[pass]);
    }
    if (layer.diameter !== size) {
      size = layer.diameter;
      assert(layout.sizes[size], `no brush size ${size}`);
      await click(layout.sizes[size]);
    }
    for (const group of layer.groups) {
      if (group.hex !== hex) {
        hex = group.hex;
        await click(layout.hex);
        await type(hex);
      }
      for (const path of group.paths) await stroke(path.map(screen), n++);
    }
  }
  await click(layout.save);
  await sleep(1500);
  const end = await page.evaluate(stateQuery);
  assert.equal(end.strokes, n, `the studio shows ${end.strokes} strokes, expected ${n}`);
  assert.equal(end.status, 'Autosaving', `autosave reported: ${end.status}`);
  console.log(`done: ${n} strokes in ${Math.round((Date.now() - started) / 1000)} s; session/${end.session}.json`);
  if (page.logs.length) console.log('page console:\n' + [...new Set(page.logs)].slice(0, 15).join('\n'));
} catch (err) {
  console.error(`paint failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  page.close();
}
