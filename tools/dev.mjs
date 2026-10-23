// npm run dev: starts the API, the staff app and the guests' site together,
// each line of output marked with its app. Ctrl+C stops all three, and so does
// any one of them stopping. A port already in use is reported before anything
// starts, rather than as one app failing among three logs.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The API's port is the PORT in backend/.env (the API's own default is 5000);
// the two web apps keep fixed ports (their vite.config.js, strictPort).
function apiPort() {
  try {
    const line = fs.readFileSync(path.join(ROOT, 'backend/.env'), 'utf8').split(/\r?\n/).find((l) => /^\s*PORT\s*=/.test(l));
    const port = line && Number(line.split('=')[1].trim());
    if (port) return port;
  } catch {
    // No backend/.env yet: the API will say so itself.
  }
  return 5000;
}

const APPS = [
  { name: 'api', title: 'API', script: 'dev:backend', port: apiPort(), colour: 36 },
  { name: 'staff', title: 'staff app', script: 'dev:business', port: 5173, colour: 32 },
  { name: 'guests', title: "guests' site", script: 'dev:customer', port: 5174, colour: 35 },
];
const label = (app) => `\x1b[${app.colour}m${app.name.padEnd(6)}\x1b[0m`;

// Something answers on the port, on either loopback address.
const inUse = (port) => Promise.all(['127.0.0.1', '::1'].map((host) => new Promise((resolve) => {
  const socket = net.connect({ port, host });
  socket.setTimeout(1000);
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('timeout', () => { socket.destroy(); resolve(false); });
  socket.once('error', () => resolve(false));
}))).then((answers) => answers.some(Boolean));

const taken = [];
for (const app of APPS) if (await inUse(app.port)) taken.push(app);
if (taken.length) {
  for (const app of taken) console.error(`${label(app)} port ${app.port} is already in use: is the ${app.title} already running in another terminal?`);
  console.error('Stop it there (Ctrl+C), or keep using it and start only the others (npm run dev:backend, dev:business, dev:customer).');
  process.exit(1);
}

const children = [];
let stopping = false;

// Stops every app and what it started (npm, nodemon, vite): on Windows only a
// tree kill reaches the grandchildren that hold the ports.
function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ } }
  }
  process.exit(code);
}

for (const app of APPS) {
  const child = spawn('npm', ['run', app.script], {
    cwd: ROOT, shell: process.platform === 'win32', detached: process.platform !== 'win32',
    env: { ...process.env, FORCE_COLOR: '1' },
  });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) {
    let rest = '';
    stream.on('data', (chunk) => {
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop();
      for (const line of lines) if (line.trim()) console.log(`${label(app)} ${line}`);
    });
  }
  child.on('exit', (code) => {
    if (stopping) return;
    // A force-stopped process reports a code like 4294967295: name only real ones.
    const shown = code > 0 && code < 256 ? ` (exit code ${code})` : '';
    console.log(`${label(app)} stopped${shown}: stopping the others.`);
    stopAll(code ? 1 : 0);
  });
}

console.log(`Starting: API http://localhost:${APPS[0].port}/api · staff app http://localhost:5173 · guests' site http://localhost:5174 (Ctrl+C stops all three)`);
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
