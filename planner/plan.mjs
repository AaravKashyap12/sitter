#!/usr/bin/env node
// Plan a painting stroke by stroke from a reference image, coarse to fine.
//
//   node planner/plan.mjs <image> [--out planner/out] [--focus x0,y0,x1,y1]... [--subject x0,y0,x1,y1]
//
// In the spirit of Hertzmann's "Painterly Rendering with Curved Brush Strokes" (SIGGRAPH 1998):
// one layer per Sitter brush size, strokes placed where the simulated canvas differs most from
// the reference blurred to that brush's scale, curved along the image's contours, and colours
// fitted to a small palette per layer so the painter changes colour a few hundred times, not
// thousands. The simulator stamps Sitter's brush, so the plan's preview matches the studio.
//
// The image is scaled to cover the 810x1080 canvas and centre-cropped. Boxes are in canvas units:
// --focus marks detail that matters most (eyes, mouth); --subject marks the figure. Without them
// the whole canvas is weighted evenly. Writes plan.json, pass-1..4.png and preview.png to --out.
// Needs ffmpeg on PATH (or FFMPEG=/path/to/ffmpeg).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const width = 810;
const height = 1080;
const pixels = width * height;
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

const args = process.argv.slice(2);
const boxes = (name) => {
  const found = [];
  for (let i = args.indexOf(name); i >= 0; i = args.indexOf(name)) {
    const [, value] = args.splice(i, 2);
    const box = String(value).split(',').map(Number);
    if (box.length !== 4 || box.some((n) => !Number.isFinite(n)) || box[0] >= box[2] || box[1] >= box[3]) {
      throw new Error(`${name} needs x0,y0,x1,y1 in canvas units (0-810, 0-1080), got ${value}`);
    }
    found.push(box);
  }
  return found;
};
const outIndex = args.indexOf('--out');
const folder = outIndex >= 0 ? args.splice(outIndex, 2)[1] : 'planner/out';
const features = boxes('--focus');
const subjects = boxes('--subject');
const [image] = args;
if (!image) {
  console.error('usage: node planner/plan.mjs <image> [--out dir] [--focus x0,y0,x1,y1]... [--subject x0,y0,x1,y1]');
  process.exit(2);
}
mkdirSync(folder, { recursive: true });

const decoded = spawnSync(FFMPEG, [
  '-loglevel', 'error', '-i', image, '-frames:v', '1',
  '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height}`,
  '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
], { maxBuffer: pixels * 3 + 1024 });
if (decoded.error) throw new Error(`could not run ${FFMPEG}: ${decoded.error.message}`);
if (decoded.status !== 0) throw new Error(`ffmpeg could not read ${image}: ${decoded.stderr}`);
const reference = decoded.stdout;
assert.equal(reference.length, pixels * 3);

const passes = ['Block-in', 'Form & colour', 'Refinement', 'Fine details'];
const settings = [
  // diameter, palette limit, minimum cell error, stroke budget, maximum drag length
  [120, 24, 2.3, 390, 2.20],
  [72, 24, 2.5, 530, 2.20],
  [40, 24, 3.0, 790, 2.05],
  [22, 40, 3.2, 1230, 1.95],
  [12, 40, 3.9, 1800, 1.90],
  [7, 40, 4.6, 1760, 2.05],
  [4, 40, 5.7, 1460, 0],
  [2, 40, 7.0, 900, 0],
];

const weights = [0.28, 0.53, 0.19];
const luminance = (r, g, b) => weights[0] * r + weights[1] * g + weights[2] * b;
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const indexAt = (x, y) => clamp(Math.floor(y), 0, height - 1) * width
  + clamp(Math.floor(x), 0, width - 1);
const dist = (r, g, b) => weights[0] * r * r + weights[1] * g * g + weights[2] * b * b;
const colourAt = (rgb, i) => [rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]];
const hex = (rgb) => Buffer.from(rgb).toString('hex');

function blur(rgb, sigma) {
  // Three separable box filters approximate a Gaussian in O(canvas area).
  let field = Float32Array.from(rgb);
  let next = new Float32Array(field.length);
  const radius = Math.max(0, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  if (!radius) {
    const neighbor = Math.exp(-0.5 / (sigma * sigma));
    const divisor = 1 + 2 * neighbor;
    for (const stride of [3, width * 3]) {
      for (let i = 0; i < field.length; i++) {
        const position = stride === 3 ? Math.floor(i / 3) % width : Math.floor(i / stride);
        const last = stride === 3 ? width - 1 : height - 1;
        next[i] = (field[i] + neighbor * (field[position ? i - stride : i]
          + field[position < last ? i + stride : i])) / divisor;
      }
      [field, next] = [next, field];
    }
    return field;
  }
  const count = 2 * radius + 1;
  for (let pass = 0; pass < 3; pass++) {
    for (const horizontal of [true, false]) {
      const length = horizontal ? width : height;
      const lines = horizontal ? height : width;
      const stride = horizontal ? 3 : width * 3;
      const lineStride = horizontal ? width * 3 : 3;
      for (let line = 0; line < lines; line++) {
        for (let channel = 0; channel < 3; channel++) {
          const start = line * lineStride + channel;
          let sum = field[start] * (radius + 1);
          for (let pos = 1; pos <= radius; pos++) sum += field[start + pos * stride];
          for (let pos = 0; pos < length; pos++) {
            next[start + pos * stride] = sum / count;
            const add = Math.min(length - 1, pos + radius + 1);
            const remove = Math.max(0, pos - radius);
            sum += field[start + add * stride] - field[start + remove * stride];
          }
        }
      }
      [field, next] = [next, field];
    }
  }
  return field;
}

function gradients(rgb) {
  const light = new Float32Array(pixels);
  for (let i = 0; i < pixels; i++) {
    light[i] = luminance(rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]);
  }
  const dx = new Float32Array(pixels);
  const dy = new Float32Array(pixels);
  const magnitude = new Float32Array(pixels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      dx[i] = light[y * width + Math.min(width - 1, x + 1)]
        - light[y * width + Math.max(0, x - 1)];
      dy[i] = light[Math.min(height - 1, y + 1) * width + x]
        - light[Math.max(0, y - 1) * width + x];
      magnitude[i] = Math.hypot(dx[i], dy[i]);
    }
  }
  return { dx, dy, magnitude };
}

const inBox = (x, y, box) => x >= box[0] && y >= box[1] && x <= box[2] && y <= box[3];
const importance = new Float32Array(pixels);
const edges = gradients(blur(reference, 0.75)).magnitude;
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const i = y * width + x;
    const focus = features.some((box) => inBox(x, y, box));
    const subject = subjects.some((box) => inBox(x, y, box));
    // Detail work goes where it reads: focus first, then the figure, then the background.
    importance[i] = focus ? 2.0 : subject ? 1.3 : features.length || subjects.length ? 0.67 : 1.0;
    importance[i] += Math.min(0.6, edges[i] / 100);
  }
}

function makePath(x, y, diameter, maximum, target, gradient) {
  const first = [x, y];
  const i = indexAt(x, y);
  if (!maximum || gradient.magnitude[i] * diameter < 34) return [first];
  const rgb = colourAt(target, i);
  const step = diameter * 0.18;
  const trail = (sign) => {
    const path = [first];
    let previousX = -sign * gradient.dy[i] / gradient.magnitude[i];
    let previousY = sign * gradient.dx[i] / gradient.magnitude[i];
    for (let length = step; length <= maximum * diameter + 1e-6; length += step) {
      const [lastX, lastY] = path.at(-1);
      const pixel = indexAt(lastX, lastY);
      const magnitude = gradient.magnitude[pixel];
      if (magnitude * diameter < 19) break;
      let vx = -gradient.dy[pixel] / magnitude;
      let vy = gradient.dx[pixel] / magnitude;
      if (vx * previousX + vy * previousY < 0) {
        vx = -vx;
        vy = -vy;
      }
      vx = 0.56 * vx + 0.44 * previousX;
      vy = 0.56 * vy + 0.44 * previousY;
      const norm = Math.hypot(vx, vy);
      previousX = vx / norm;
      previousY = vy / norm;
      const nextX = Math.round(4 * (lastX + step * previousX)) / 4;
      const nextY = Math.round(4 * (lastY + step * previousY)) / 4;
      if (nextX < 0.5 || nextY < 0.5 || nextX > width - 0.5 || nextY > height - 0.5) break;
      const [r, g, b] = colourAt(target, indexAt(nextX, nextY));
      if (dist(r - rgb[0], g - rgb[1], b - rgb[2]) > 13 ** 2) break;
      path.push([nextX, nextY]);
    }
    return path;
  };
  const forward = trail(1);
  const backward = trail(-1);
  const path = forward.length >= backward.length ? forward : backward;
  return (path.length - 1) * step >= diameter ? path : [first];
}

function smooth(start, end, x) {
  const t = clamp((x - start) / (end - start), 0, 1);
  return t * t * (3 - 2 * t);
}

function footprint(path, diameter) {
  const radius = diameter / 2;
  const minX = Math.max(0, Math.ceil(Math.min(...path.map(([x]) => x)) - radius - 0.5));
  const maxX = Math.min(width - 1, Math.floor(Math.max(...path.map(([x]) => x)) + radius - 0.5));
  const minY = Math.max(0, Math.ceil(Math.min(...path.map(([, y]) => y)) - radius - 0.5));
  const maxY = Math.min(height - 1, Math.floor(Math.max(...path.map(([, y]) => y)) + radius - 0.5));
  const stride = maxX - minX + 1;
  const alpha = new Float32Array(stride * (maxY - minY + 1));
  const spacing = Math.max(0.3, diameter * 0.075);
  const overlaps = diameter / spacing;
  const loaded = 0.985 - 0.025 * smooth(4, 60, diameter);
  const perStamp = 0.925 * (1 - (1 - loaded) ** (1 / overlaps));
  const softness = 0.50 - 0.32 * smooth(4, 40, diameter);
  const bristles = 1 - 0.10 * smooth(5, 30, diameter);
  const isDab = path.length === 1;
  const stamp = (x, y, arc) => {
    const first = Math.max(minY, Math.ceil(y - radius - 0.5));
    const last = Math.min(maxY, Math.floor(y + radius - 0.5));
    const ramp = 0.6 + 0.4 * smooth(0, Math.max(2, diameter * 0.35), arc);
    const load = 0.72 + 0.28 * Math.exp(-arc / (diameter * 9 + 300));
    for (let row = first; row <= last; row++) {
      const dy = row + 0.5 - y;
      const half = Math.sqrt(Math.max(0, radius * radius - dy * dy));
      const left = Math.max(minX, Math.ceil(x - half - 0.5));
      const right = Math.min(maxX, Math.floor(x + half - 0.5));
      for (let col = left; col <= right; col++) {
        const dx = col + 0.5 - x;
        const radial = Math.sqrt(dx * dx + dy * dy) / radius;
        const falloff = smooth(1, 1 - softness, radial);
        const i = (row - minY) * stride + col - minX;
        const tipAlpha = perStamp * bristles * falloff;
        alpha[i] = isDab ? 1 - (1 - tipAlpha) ** Math.round(overlaps)
          : alpha[i] + (1 - alpha[i]) * tipAlpha * ramp * load;
      }
    }
  };
  stamp(...path[0], 0);
  let nextStamp = spacing;
  let arc = 0;
  for (let p = 1; p < path.length; p++) {
    const [x, y] = path[p - 1];
    const dx = path[p][0] - x;
    const dy = path[p][1] - y;
    const length = Math.hypot(dx, dy);
    while (nextStamp <= arc + length) {
      const fraction = (nextStamp - arc) / length;
      stamp(x + dx * fraction, y + dy * fraction, nextStamp);
      nextStamp += spacing;
    }
    arc += length;
  }
  return { minX, minY, stride, alpha };
}

function measureStroke(field, target, area, rgb, covered) {
  let gain = 0;
  let count = 0;
  let bare = 0;
  const { minX, minY, stride, alpha } = area;
  for (let offset = 0; offset < alpha.length; offset++) {
    const a = alpha[offset];
    if (a <= 0.001) continue;
    const i = (minY + Math.floor(offset / stride)) * width + minX + offset % stride;
    const j = 3 * i;
    const r = field[j], g = field[j + 1], b = field[j + 2];
    gain += dist(r - target[j], g - target[j + 1], b - target[j + 2]) - dist(
      r + a * (rgb[0] - r) - target[j],
      g + a * (rgb[1] - g) - target[j + 1],
      b + a * (rgb[2] - b) - target[j + 2],
    );
    bare += covered && !covered[i] && a > 0.32 ? 1 : 0;
    count += a;
  }
  return { gain, count, bare };
}

function paint(field, area, rgb, covered) {
  const { minX, minY, stride, alpha } = area;
  for (let offset = 0; offset < alpha.length; offset++) {
    const a = alpha[offset];
    if (a <= 0.001) continue;
    const i = (minY + Math.floor(offset / stride)) * width + minX + offset % stride;
    const j = 3 * i;
    field[j] = Math.round(field[j] + a * (rgb[0] - field[j]));
    field[j + 1] = Math.round(field[j + 1] + a * (rgb[1] - field[j + 1]));
    field[j + 2] = Math.round(field[j + 2] + a * (rgb[2] - field[j + 2]));
    if (covered && a > 0.32) covered[i] = 1;
  }
}

function cellError(field, target, cell, diameter, covered) {
  let worst = -1;
  let where = -1;
  let sum = 0;
  for (let y = cell.y; y < cell.bottom; y++) {
    for (let x = cell.x; x < cell.right; x++) {
      const i = y * width + x;
      const j = i * 3;
      let error = Math.sqrt(dist(field[j] - target[j], field[j + 1] - target[j + 1], field[j + 2] - target[j + 2]));
      if (covered && !covered[i]) error += 256;
      if (diameter <= 12) {
        const activity = edges[i];
        const attention = importance[i] * (diameter <= 4 && importance[i] > 1.9 ? 1.45 : 1);
        if (diameter <= 4 && activity < (attention > 1.9 ? 2.5 : attention > 1.25 ? 6 : 24)) continue;
        if (diameter <= 7 && attention < 1.0 && activity < 10) continue;
        error *= attention;
      }
      sum += error;
      if (error > worst) {
        worst = error;
        where = i;
      }
    }
  }
  const mean = sum / ((cell.bottom - cell.y) * (cell.right - cell.x));
  return { mean, worst, where };
}

function draftLayer(field, target, lossTarget, gradient, config, covered) {
  const [diameter, , threshold, budget, maximum] = config;
  const spacing = Math.max(1, Math.round(diameter / 2));
  const cells = [];
  for (let y = 0; y < height; y += spacing) {
    for (let x = 0; x < width; x += spacing) {
      const cell = { x, y, right: Math.min(width, x + spacing), bottom: Math.min(height, y + spacing) };
      const error = cellError(field, target, cell, diameter, covered);
      if (error.mean < threshold) continue;
      const priority = error.mean + 0.13 * error.worst;
      cells.push({ ...cell, priority });
    }
  }
  // Begin with broad, high-error areas. Recheck each cell on the updated draft.
  cells.sort((a, b) => b.priority - a.priority || a.y - b.y || a.x - b.x);
  const strokes = [];
  for (const cell of cells) {
    const error = cellError(field, target, cell, diameter, covered);
    if (error.mean < threshold) continue;
    const x = error.where % width + 0.5;
    const y = Math.floor(error.where / width) + 0.5;
    let path = makePath(x, y, diameter, maximum, target, gradient);
    const rgb = colourAt(target, error.where);
    let area = footprint(path, diameter);
    let score = measureStroke(field, lossTarget, area, rgb, covered);
    if (path.length > 1 && !score.bare && score.gain < score.count * 2) {
      path = [path[0]];
      area = footprint(path, diameter);
      score = measureStroke(field, lossTarget, area, rgb, covered);
    }
    if (!score.bare && score.gain < score.count * 1.2) continue;
    paint(field, area, rgb, covered);
    strokes.push({ path, rgb, cell, score, area });
    if (strokes.length >= budget) break;
    if (covered && cellError(field, target, cell, diameter, covered).worst >= 256) {
      cells.push(cell);
    }
  }
  return strokes;
}

function fitPalette(strokes, size) {
  const colours = strokes.map((stroke) => stroke.rgb);
  const centroids = [colours[Math.floor(colours.length / 2)]];
  const nearest = new Float32Array(colours.length).fill(Infinity);
  while (centroids.length < size) {
    const last = centroids.at(-1);
    let farthest = 0;
    for (let i = 0; i < colours.length; i++) {
      const [r, g, b] = colours[i];
      nearest[i] = Math.min(nearest[i], dist(r - last[0], g - last[1], b - last[2]));
      if (nearest[i] > nearest[farthest]) farthest = i;
    }
    if (nearest[farthest] < 0.25) break;
    centroids.push(colours[farthest]);
  }
  const groups = centroids.map((rgb) => ({ rgb, strokes: [] }));
  for (let iteration = 0; iteration <= 18; iteration++) {
    for (const group of groups) group.strokes = [];
    for (const stroke of strokes) {
      const [r, g, b] = stroke.rgb;
      let best = groups[0];
      let min = Infinity;
      for (const group of groups) {
        const d = dist(r - group.rgb[0], g - group.rgb[1], b - group.rgb[2]);
        if (d < min) {
          best = group;
          min = d;
        }
      }
      best.strokes.push(stroke);
    }
    for (const group of groups) {
      if (!group.strokes.length) continue;
      const sum = [0, 0, 0];
      for (const { rgb } of group.strokes) {
        for (let channel = 0; channel < 3; channel++) sum[channel] += rgb[channel];
      }
      group.rgb = sum.map((value) => value / group.strokes.length);
    }
  }
  return groups.filter((group) => group.strokes.length).map(({ rgb, strokes }) => ({
    rgb: rgb.map(Math.round),
    strokes,
  }));
}

function routeGroup(strokes) {
  // A nearest-neighbor route keeps cursor travel short without moving strokes across colours.
  const remaining = [...strokes];
  const route = [remaining.shift()];
  while (remaining.length) {
    const [x, y] = route.at(-1).path.at(-1);
    let best = 0;
    let nearest = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const [sx, sy] = remaining[i].path[0];
      const distance = (sx - x) ** 2 + (sy - y) ** 2;
      if (distance < nearest) {
        nearest = distance;
        best = i;
      }
    }
    route.push(remaining.splice(best, 1)[0]);
  }
  return route;
}

function render(name, rgb) {
  const result = spawnSync(FFMPEG, [
    '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'rgb24',
    '-video_size', width + 'x' + height, '-i', 'pipe:0', '-frames:v', '1',
    '-update', '1', join(folder, name),
  ], { input: rgb, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.error);
}

function errorReport(field) {
  let full = 0;
  let focus = 0;
  let count = 0;
  for (let i = 0; i < pixels; i++) {
    const j = i * 3;
    const error = (Math.abs(field[j] - reference[j]) + Math.abs(field[j + 1] - reference[j + 1])
      + Math.abs(field[j + 2] - reference[j + 2])) / 3;
    full += error;
    if (features.some((box) => inBox(i % width, Math.floor(i / width), box))) {
      focus += error;
      count++;
    }
  }
  return { meanRGB: +(full / pixels).toFixed(2), focusMeanRGB: count ? +(focus / count).toFixed(2) : null };
}

const canvas = Buffer.alloc(pixels * 3);
for (let i = 0; i < canvas.length; i += 3) {
  canvas[i] = 233;
  canvas[i + 1] = 227;
  canvas[i + 2] = 214;
}
const ground = Buffer.from(canvas);
const covered = new Uint8Array(pixels);
const layers = [];
const reports = [];
for (const [layerIndex, config] of settings.entries()) {
  const [diameter, paletteLimit] = config;
  const pass = passes[Math.floor(layerIndex / 2)];
  const gaussian = blur(reference, diameter * (diameter >= 40 ? 0.125 : 0.11));
  const target = Float32Array.from(gaussian);
  if (diameter >= 12) {
    // Suppress colour spill across sharp boundaries while keeping the scale blur in flat areas.
    for (let i = 0; i < target.length; i += 3) {
      const delta = luminance(reference[i] - gaussian[i], reference[i + 1] - gaussian[i + 1],
        reference[i + 2] - gaussian[i + 2]);
      const keep = 0.70 * smooth(9, 40, Math.abs(delta));
      for (let c = 0; c < 3; c++) target[i + c] += keep * (reference[i + c] - gaussian[i + c]);
    }
  }
  const lossTarget = target.map((value, i) => 0.33 * value + 0.67 * reference[i]);
  const gradient = gradients(gaussian);
  const coverage = layerIndex === 0 ? covered : null;
  const draft = draftLayer(Float32Array.from(canvas), target, lossTarget, gradient, config, coverage?.slice());
  assert(draft.length, 'Empty layer ' + diameter);
  const groups = fitPalette(draft, paletteLimit);
  groups.sort((a, b) => b.strokes.length - a.strokes.length || luminance(...a.rgb) - luminance(...b.rgb));
  const recorded = [];
  for (const group of groups) {
    const paths = [];
    for (const stroke of routeGroup(group.strokes)) {
      const { gain, count, bare } = measureStroke(canvas, lossTarget, stroke.area, group.rgb, coverage);
      if (!bare && gain < count * 0.7) continue;
      paint(canvas, stroke.area, group.rgb, coverage);
      paths.push(stroke.path);
    }
    if (paths.length) recorded.push({ hex: hex(group.rgb), paths });
  }
  layers.push({ pass, diameter, groups: recorded });
  const strokes = recorded.reduce((sum, group) => sum + group.paths.length, 0);
  console.log(diameter, 'draft', draft.length, 'accepted', strokes, 'colours', recorded.length, errorReport(canvas));
  assert(recorded.length <= paletteLimit && strokes > 0);
  if (layerIndex % 2 === 1) {
    const file = 'pass-' + (Math.floor(layerIndex / 2) + 1) + '.png';
    render(file, canvas);
    const pair = layers.slice(-2);
    reports.push({
      pass, file, strokes: pair.reduce((sum, layer) => sum
        + layer.groups.reduce((count, group) => count + group.paths.length, 0), 0),
      ...errorReport(canvas),
    });
  }
}
assert(covered.every(Boolean), 'Block-in left ' + covered.reduce((n, v) => n + (v === 0), 0) + ' uncovered pixels');
render('preview.png', canvas);
const strokes = reports.reduce((sum, pass) => sum + pass.strokes, 0);
let colourChanges = 0;
let previousHex = '';
let dabs = 0;
for (const { groups } of layers) {
  for (const { hex: colour, paths } of groups) {
    assert.match(colour, /^[a-f0-9]{6}$/);
    if (colour !== previousHex) colourChanges++;
    previousHex = colour;
    for (const path of paths) {
      assert(path.every(([x, y]) => x >= 0 && y >= 0 && x < width && y < height));
      if (path.length === 1) dabs++;
    }
  }
}
const estimatedSeconds = Math.round(dabs * 0.13 + (strokes - dabs) * 0.22 + colourChanges * 0.60);
const plan = { width, height, strokes, dabs, colourChanges, estimatedSeconds, reports, layers };
const serialized = JSON.stringify(plan);
const replay = Buffer.from(ground);
let laid = 0;
for (const { diameter, groups } of JSON.parse(serialized).layers) {
  for (const { hex, paths } of groups) {
    for (const path of paths) {
      paint(replay, footprint(path, diameter), Buffer.from(hex, 'hex'));
      laid++;
    }
  }
}
assert.equal(laid, strokes);
assert(replay.equals(canvas), 'Serialized input plan diverged from the preview');
writeFileSync(join(folder, 'plan.json'), serialized);
console.log(JSON.stringify({ strokes, dabs, colourChanges, estimatedSeconds, reports }, null, 2));
