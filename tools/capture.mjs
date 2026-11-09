#!/usr/bin/env node
// Render a session replay frame by frame: an MP4 through ffmpeg, or a folder of PNGs.
//
//   node tools/capture.mjs <replay-url> <out.mp4 | out-dir> [--fps 60] [--size 1740x1800]
//                          [--frames 0,60,120] [--port 9334]
//
// The replay URL is the studio with ?replay=…&capture=1, e.g.
//   "http://127.0.0.1:5195/?replay=demo/girl-with-a-pearl-earring.json&capture=1&speed=20&maxGap=0"
// Without --frames, the whole replay is rendered. Frames are rendered from the replay clock,
// not recorded in real time, so the output never drops or repeats a frame.
// The default size is 1.5x the 1160x1200 studio, which maps the canvas pixel for pixel.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { openChrome, sleep } from './chrome.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const [, value] = args.splice(i, 2);
  return value;
};
const fps = Number(option('--fps', '60'));
const [W, H] = option('--size', '1740x1800').split('x').map(Number);
const list = option('--frames', null);
const port = Number(option('--port', '9334'));
const [url, out] = args;
if (!url || !out || !(fps > 0) || !(W > 0) || !(H > 0)) {
  console.error('usage: node tools/capture.mjs <replay-url> <out.mp4|out-dir> [--fps 60] [--size 1740x1800] [--frames 0,60] [--port 9334]');
  process.exit(2);
}
const frameList = list === null ? null : list.split(',').map(Number);
if (frameList && !frameList.every((n) => Number.isInteger(n) && n >= 0)) {
  console.error(`--frames must be whole frame numbers like 0,60,120, got ${list}`);
  process.exit(2);
}
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const toVideo = out.endsWith('.mp4');
// Check ffmpeg before starting Chrome, so a missing binary fails fast and leaves nothing running.
if (toVideo && spawnSync(FFMPEG, ['-version']).status !== 0) {
  console.error(`ffmpeg not found (${FFMPEG}). Install it or set FFMPEG=/path/to/ffmpeg.`);
  process.exit(1);
}

let page;
try {
  page = await openChrome({ width: W, height: H, port });
} catch (err) {
  console.error(`capture failed: ${err.message}`);
  process.exit(1);
}
let ff = null;
try {
  await page.send('Page.navigate', { url });
  let ready = false;
  for (let i = 0; i < 300 && !ready; i++) {
    ready = await page.evaluate('!!(window.sitter && window.sitter.ready)').catch(() => false);
    if (!ready) await sleep(100);
  }
  if (!ready) throw new Error('the page never exposed window.sitter; is the URL a ?replay= link to a running studio?');
  await page.evaluate('Promise.resolve(window.sitter.ready).then(() => true)');
  await page.evaluate('window.sitter.pause()');
  await page.evaluate(`window.sitter.setSize(${W}, ${H})`);
  const duration = await page.evaluate('window.sitter.duration');
  const frames = frameList ?? [...Array(Math.ceil(duration * fps)).keys()];
  console.error(`replay ${duration.toFixed(2)} s, rendering ${frames.length} frames at ${W}x${H}, ${fps} fps`);

  let done;
  if (toVideo) {
    ff = spawn(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-r', String(fps), '-movflags', '+faststart', '-an', out],
    { stdio: ['pipe', 'inherit', 'inherit'] });
    done = new Promise((resolve) => {
      ff.on('error', (err) => resolve(`ffmpeg failed to start: ${err.message}`));
      ff.on('close', resolve);
    });
    ff.stdin.on('error', () => {}); // reported through the exit code
  } else mkdirSync(out, { recursive: true });

  const started = Date.now();
  for (const n of frames) {
    await page.evaluate(`window.sitter.renderAt(${n} / ${fps})`);
    const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
    const png = Buffer.from(data, 'base64');
    if (toVideo) {
      if (ff.exitCode !== null) break;
      if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r));
    } else writeFileSync(`${out}/f${String(n).padStart(5, '0')}.png`, png);
  }
  if (toVideo) {
    ff.stdin.end();
    const code = await done;
    if (code !== 0) throw new Error(typeof code === 'string' ? code : `ffmpeg exited with code ${code}`);
  }
  console.error(`wrote ${out} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  if (page.logs.length) console.error('page console:\n' + [...new Set(page.logs)].slice(0, 15).join('\n'));
} catch (err) {
  console.error(`capture failed: ${err.message}`);
  process.exitCode = 1;
  if (ff && ff.exitCode === null) ff.kill('SIGTERM');
} finally {
  page.close();
}
