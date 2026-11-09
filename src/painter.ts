import { BACKING, CANVAS_H, CANVAS_W, GROUND, Stroke } from './brush';

// The painting is a tree of strokes: each stroke records the stack top it was painted on,
// and undo moves the top back to the parent. Any state is rebuilt by stamping strokes forward
// from the nearest known state (the visible canvas, the pre-stroke snapshot or a checkpoint),
// so live painting, undo and out-of-order replay seeks all reach identical pixels.

const CHECKPOINT_EVERY = 16;
const MAX_CHECKPOINTS = 20; // ~7.9 MB each

function makeCanvas() {
  const c = document.createElement('canvas');
  c.width = Math.round(CANVAS_W * BACKING);
  c.height = Math.round(CANVAS_H * BACKING);
  return c;
}

function copy(dst: CanvasRenderingContext2D, src: HTMLCanvasElement) {
  dst.globalCompositeOperation = 'copy';
  dst.drawImage(src, 0, 0);
  dst.globalCompositeOperation = 'source-over';
}

export class Painter {
  readonly strokes = new Map<number, Stroke>();
  private readonly ctx: CanvasRenderingContext2D;
  // What the visible canvas holds: committed stack top plus the first n dabs of stroke pid.
  private top = -1;
  private pid = -1;
  private n = 0;
  private valid = true;
  private readonly pre = makeCanvas();
  private readonly preCtx: CanvasRenderingContext2D;
  private preTop = NaN;
  private readonly checkpoints = new Map<number, HTMLCanvasElement>();

  constructor(readonly canvas: HTMLCanvasElement) {
    canvas.width = Math.round(CANVAS_W * BACKING);
    canvas.height = Math.round(CANVAS_H * BACKING);
    this.ctx = canvas.getContext('2d')!;
    this.preCtx = this.pre.getContext('2d')!;
    this.blank();
  }

  private blank() {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.globalAlpha = 1;
    this.ctx.fillStyle = GROUND;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private stroke(id: number): Stroke {
    const s = this.strokes.get(id);
    if (!s) throw new Error(`unknown stroke ${id}`);
    return s;
  }

  /** Show committed state `top`, plus the first `n` dabs of in-progress stroke `pid` (parent must be `top`). */
  show(top: number, pid = -1, n = 0) {
    if (pid >= 0) {
      if (this.valid && this.pid === pid && this.top === top && this.n <= n) {
        this.stroke(pid).stamp(this.ctx, this.n, n);
        this.n = n;
        return;
      }
      if (this.preTop === top) copy(this.ctx, this.pre);
      else {
        this.commit(top);
        copy(this.preCtx, this.canvas);
        this.preTop = top;
      }
      this.stroke(pid).stamp(this.ctx, 0, n);
      this.top = top; this.pid = pid; this.n = n; this.valid = true;
      return;
    }
    this.commit(top);
  }

  private commit(top: number) {
    if (this.valid && this.pid >= 0) {
      const s = this.stroke(this.pid);
      if (s.complete && this.n === s.dabs.length) {
        // The finished stroke is already on the canvas: just name the state.
        this.top = this.pid; this.pid = -1; this.n = 0;
        this.remember(this.top);
      } else if (this.preTop === this.top) {
        copy(this.ctx, this.pre);
        this.pid = -1; this.n = 0;
      } else this.valid = false;
    }
    if (this.valid && this.pid < 0 && this.top === top) return;

    const path: number[] = [];
    let id = top;
    let base: 'canvas' | 'pre' | 'checkpoint' | 'blank' = 'blank';
    for (;;) {
      if (this.valid && this.pid < 0 && id === this.top) { base = 'canvas'; break; }
      if (id === this.preTop && id >= 0) { base = 'pre'; break; }
      if (id < 0) break;
      if (this.checkpoints.has(id)) { base = 'checkpoint'; break; }
      path.push(id);
      id = this.stroke(id).parent;
    }
    if (base === 'pre') copy(this.ctx, this.pre);
    else if (base === 'checkpoint') {
      const c = this.checkpoints.get(id)!;
      this.checkpoints.delete(id); this.checkpoints.set(id, c); // LRU touch
      copy(this.ctx, c);
    } else if (base === 'blank') this.blank();

    for (let i = path.length - 1; i >= 0; i--) {
      const s = this.stroke(path[i]);
      s.stamp(this.ctx, 0, s.dabs.length);
      this.remember(s.id);
    }
    this.top = top; this.pid = -1; this.n = 0; this.valid = true;
  }

  private remember(id: number) {
    if (id < 0 || this.stroke(id).depth % CHECKPOINT_EVERY !== 0 || this.checkpoints.has(id)) return;
    let c: HTMLCanvasElement;
    if (this.checkpoints.size >= MAX_CHECKPOINTS) {
      const oldest = this.checkpoints.keys().next().value as number;
      c = this.checkpoints.get(oldest)!;
      this.checkpoints.delete(oldest);
    } else c = makeCanvas();
    copy(c.getContext('2d')!, this.canvas);
    this.checkpoints.set(id, c);
  }
}
