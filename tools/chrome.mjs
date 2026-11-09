// Launch a private Chrome and talk to one page over the DevTools protocol (Node 22+, no packages).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_CHROME = {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: 'google-chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
};
const TIMEOUT_MS = 60_000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function portInUse(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Start Chrome with a throwaway profile and connect to its first tab.
 * Returns { send, evaluate, close, logs }. Set CHROME to use another binary.
 */
export async function openChrome({ width, height, port = 9333, headless = true } = {}) {
  const binary = process.env.CHROME || DEFAULT_CHROME[process.platform] || 'google-chrome';
  // Never attach to a browser that is already listening there: it could be someone's own Chrome.
  if (await portInUse(port)) throw new Error(`port ${port} is already in use; pass another with --port`);

  const profile = mkdtempSync(join(tmpdir(), 'sitter-chrome-'));
  const args = [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', '--mute-audio',
    ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []),
    `--window-size=${width},${height}`, 'about:blank',
  ];
  if (headless) args.unshift('--headless=new');
  const chrome = spawn(binary, args, { stdio: 'ignore' });
  let launchError = null;
  chrome.on('error', (err) => { launchError = err; });
  // The throwaway profile is removed once Chrome has exited and released it.
  chrome.on('exit', () => rmSync(profile, { recursive: true, force: true }));
  const kill = () => { if (chrome.exitCode === null && !chrome.killed) chrome.kill('SIGTERM'); };

  try {
    return await connect(port, width, height, kill, () => launchError, binary);
  } catch (err) {
    kill();
    throw err;
  }
}

async function connect(port, width, height, kill, launchError, binary) {
  let wsUrl;
  for (let i = 0; i < 150 && !wsUrl && !launchError(); i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
    } catch { /* not listening yet */ }
    if (!wsUrl) await sleep(100);
  }
  if (!wsUrl) {
    const why = launchError() ? `: ${launchError().message}` : '';
    throw new Error(`Chrome did not start (${binary}${why}). Set CHROME to its path.`);
  }

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('could not connect to Chrome')), { once: true });
  });

  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject, method } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(`${method}: ${m.error.message}`));
      else resolve(m.result);
    } else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      logs.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    } else if (m.method === 'Runtime.exceptionThrown') {
      logs.push(`exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
    }
  });
  ws.addEventListener('close', () => {
    for (const { reject, method } of pending.values()) reject(new Error(`${method}: Chrome connection closed`));
    pending.clear();
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    const timer = setTimeout(() => {
      pending.delete(i);
      reject(new Error(`${method}: Chrome did not answer within ${TIMEOUT_MS / 1000} s`));
    }, TIMEOUT_MS);
    pending.set(i, {
      method,
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (err) => { clearTimeout(timer); reject(err); },
    });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const close = () => {
    try { ws.close(); } catch { /* already closed */ }
    kill();
  };

  try {
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  } catch (err) {
    close();
    throw err;
  }
  return { send, evaluate, close, logs };
}
