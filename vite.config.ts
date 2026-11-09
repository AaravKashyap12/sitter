import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Session names come from the browser, so they must stay a plain file stem inside session/.
const NAME = /^session-[0-9A-Za-z_-]{1,80}$/;
const MAX_BODY = 64 * 1024 * 1024;

interface SessionFile { version: number; session: string; meta: unknown; events: unknown[] }
// Each event is kept as its JSON line, so a write is a join and an overlap check is a string compare.
interface Session { version: number; session: string; meta: unknown; lines: string[] }

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function reply(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function writeAtomic(file: string, data: string | Buffer) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// One event per line keeps the file greppable and diff-friendly.
function serialise(s: Session): string {
  const head = JSON.stringify({ version: s.version, session: s.session, meta: s.meta });
  return `${head.slice(0, -1)},"events":[\n${s.lines.join(',\n')}\n]}\n`;
}

// Only this page may write: a cross-site text/plain POST would skip the CORS preflight.
function foreign(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host !== req.headers.host; } catch { return true; }
}

function sessionLog(): Plugin {
  return {
    name: 'session-log',
    configureServer(server) {
      const dir = path.join(server.config.root, 'session');
      fs.mkdirSync(dir, { recursive: true });
      const cache = new Map<string, Session>();

      const load = (name: string): Session | undefined => {
        const file = path.join(dir, `${name}.json`);
        if (!fs.existsSync(file)) return undefined;
        try {
          const f = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionFile;
          return { version: f.version, session: f.session, meta: f.meta, lines: f.events.map((e) => JSON.stringify(e)) };
        } catch { return undefined; }
      };

      server.middlewares.use('/api/log', (req, res) => {
        if (req.method !== 'POST') return reply(res, 405, { error: 'POST only' });
        if (foreign(req)) return reply(res, 403, { error: 'foreign origin' });
        readBody(req).then((buf) => {
          const body = JSON.parse(buf.toString('utf8')) as { session?: unknown; offset?: unknown; meta?: unknown; events?: unknown };
          const { session, offset, events } = body;
          if (typeof session !== 'string' || !NAME.test(session)) return reply(res, 400, { error: 'bad session' });
          if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) return reply(res, 400, { error: 'bad offset' });
          if (!Array.isArray(events)) return reply(res, 400, { error: 'bad events' });
          const file = path.join(dir, `${session}.json`);
          const s = cache.get(session) ?? load(session) ?? { version: 1, session, meta: body.meta ?? null, lines: [] };
          cache.set(session, s);
          if (body.meta) s.meta = body.meta;
          const have = s.lines.length;
          if (offset > have) return reply(res, 409, { have });
          // Retries and the unload beacon resend identical events; anything else is a second writer
          // (a duplicated tab, or a page resumed from a stale file) and must not be merged.
          const overlap = Math.min(events.length, have - offset);
          for (let i = 0; i < overlap; i++) {
            if (JSON.stringify(events[i]) !== s.lines[offset + i]) return reply(res, 409, { have, conflict: true });
          }
          for (let i = overlap; i < events.length; i++) s.lines.push(JSON.stringify(events[i]));
          // Written before replying, so a reload always resumes from an up-to-date file.
          if (s.lines.length > have || !fs.existsSync(file)) writeAtomic(file, serialise(s));
          reply(res, 200, { have: s.lines.length });
        }).catch((err: Error) => reply(res, 400, { error: err.message }));
      });

      server.middlewares.use('/api/save', (req, res) => {
        if (req.method !== 'POST') return reply(res, 405, { error: 'POST only' });
        if (foreign(req)) return reply(res, 403, { error: 'foreign origin' });
        const session = new URL(req.url ?? '', 'http://x').searchParams.get('session') ?? '';
        if (!NAME.test(session)) return reply(res, 400, { error: 'bad session' });
        readBody(req).then((buf) => {
          if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return reply(res, 400, { error: 'not a PNG' });
          let n = 1;
          while (fs.existsSync(path.join(dir, `${session}-${String(n).padStart(2, '0')}.png`))) n++;
          const file = `${session}-${String(n).padStart(2, '0')}.png`;
          writeAtomic(path.join(dir, file), buf);
          reply(res, 200, { file: `session/${file}` });
        }).catch((err: Error) => reply(res, 400, { error: err.message }));
      });
    },
  };
}

export default defineConfig({
  plugins: [sessionLog()],
  server: {
    host: '127.0.0.1',
    // Session logs and tool output change constantly; reloading on them would interrupt a painting.
    watch: { ignored: ['**/session/**', '**/out/**'] },
  },
});
