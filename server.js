'use strict';
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Docker = require('dockerode');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const app = express();
const docker = new Docker();
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.CODEPULSE_API_KEY;
const MAX_CODE_BYTES = 100000;
const MAX_OUTPUT_BYTES = 65536;
const RUN_TIMEOUT_MS = 10000;
const INSTALL_TIMEOUT_MS = 120000;
const WORKSPACE_TTL_MS = 30 * 60 * 1000;

if (!API_KEY || API_KEY.length < 32) throw new Error('Set CODEPULSE_API_KEY to a random secret of at least 32 characters.');

const allowedOrigins = new Set((process.env.CORS_ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean));
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error('CORS origin is not allowed'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600
}));
app.use(express.json({ limit: '128kb' }));
app.use(rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }));

app.use((req, res, next) => {
  if (req.method === 'GET' && req.path === '/health') return next();
  const header = req.get('authorization') || '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(supplied);
  const b = Buffer.from(API_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

const LANGUAGES = {
  python: {
    image: 'python:3.12-slim', extension: '.py',
    command: file => ['python', file],
    installCommand: pkg => ['python', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--no-cache-dir', '--target', '/workspace/.packages/python', pkg],
    env: ['PYTHONPATH=/workspace/.packages/python', 'PYTHONDONTWRITEBYTECODE=1']
  },
  javascript: {
    image: 'node:22-alpine', extension: '.js',
    command: file => ['node', file],
    installCommand: pkg => ['npm', 'install', '--no-audit', '--no-fund', '--prefix', '/workspace', pkg],
    env: ['npm_config_cache=/tmp/npm-cache']
  }
};

const workspaces = new Map();
const pulledImages = new Set();
function validSessionId(v) { return typeof v === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(v); }
function validPackage(v, language) {
  if (typeof v !== 'string' || v.length > 214 || v.startsWith('-') || v.includes('..') || v.includes(String.fromCharCode(96)) || /[\s;|&$<>\\]/.test(v)) return false;
  return language === 'python' ? /^[A-Za-z0-9_.-]+$/.test(v) : /^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+(?:@[A-Za-z0-9_.-]+)?$/.test(v);
}
function resolveLanguage(v) {
  if (typeof v !== 'string') return null;
  const aliases = { py: 'python', python: 'python', js: 'javascript', javascript: 'javascript', node: 'javascript' };
  const key = aliases[v.toLowerCase()];
  return key ? { name: key, ...LANGUAGES[key] } : null;
}

async function ensureImage(image) {
  if (pulledImages.has(image)) return;
  try { await docker.getImage(image).inspect(); pulledImages.add(image); return; } catch {}
  await new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, error => error ? reject(error) : (pulledImages.add(image), resolve()));
    });
  });
}
async function getWorkspace(sessionId) {
  if (!validSessionId(sessionId)) throw new Error('sessionId must be 16-80 characters using letters, numbers, _ or -.');
  let entry = workspaces.get(sessionId);
  if (!entry) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codepulse-'));
    entry = { dir, busy: false, lastUsed: Date.now() };
    workspaces.set(sessionId, entry);
  }
  entry.lastUsed = Date.now();
  return entry;
}

async function runContainer({ image, command, workspace, timeoutMs, networkEnabled, env = [] }) {
  await ensureImage(image);
  const container = await docker.createContainer({
    Image: image, Cmd: command, WorkingDir: '/workspace', Env: env,
    AttachStdout: true, AttachStderr: true, Tty: false, OpenStdin: false,
    NetworkDisabled: !networkEnabled,
    HostConfig: {
      Binds: [workspace + ':/workspace:rw'], AutoRemove: false,
      Memory: 256 * 1024 * 1024, NanoCpus: 500000000, PidsLimit: 64,
      CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: true, Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=32m' }
    }
  });
  let stream, timer, timedOut = false;
  const output = { stdout: '', stderr: '' };
  try {
    stream = await container.attach({ stream: true, stdout: true, stderr: true });
    const outputPromise = new Promise((resolve, reject) => {
      let pending = Buffer.alloc(0);
      stream.on('data', chunk => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 8) {
          const type = pending[0], length = pending.readUInt32BE(4);
          if (pending.length < 8 + length) break;
          const part = pending.subarray(8, 8 + length).toString('utf8');
          pending = pending.subarray(8 + length);
          if (type === 1) output.stdout = (output.stdout + part).slice(-MAX_OUTPUT_BYTES);
          else if (type === 2) output.stderr = (output.stderr + part).slice(-MAX_OUTPUT_BYTES);
        }
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(output));
      stream.on('close', () => resolve(output));
    });
    await container.start();
    const waitPromise = container.wait();
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(async () => {
        timedOut = true;
        try { await container.kill(); } catch {}
        reject(new Error('Execution timed out'));
      }, timeoutMs);
    });
    let status;
    try { status = await Promise.race([waitPromise, timeoutPromise]); }
    catch (error) {
      if (!timedOut) throw error;
      await Promise.race([outputPromise, new Promise(resolve => setTimeout(resolve, 500))]);
      return { ...output, exitCode: null, timedOut: true };
    }
    await Promise.race([outputPromise, new Promise(resolve => setTimeout(resolve, 1000))]);
    return { ...output, exitCode: status.StatusCode, timedOut: false };
  } finally {
    clearTimeout(timer);
    if (stream) stream.destroy();
    try { await container.remove({ force: true }); } catch {}
  }
}

async function withWorkspace(req, res, callback) {
  let entry;
  try { entry = await getWorkspace(req.body?.sessionId); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  if (entry.busy) return res.status(409).json({ error: 'This workspace is busy. Try again shortly.' });
  entry.busy = true;
  try { await callback(entry); }
  catch (error) {
    console.error('CodePulse worker error:', error.message);
    if (!res.headersSent) res.status(500).json({ error: 'Execution worker failed. Check Docker availability and server logs.' });
  } finally { entry.busy = false; entry.lastUsed = Date.now(); }
}

app.get('/health', (_req, res) => res.json({ status: 'online', service: 'CodePulse Execution API', supportedLanguages: ['python', 'javascript'] }));
app.get('/languages', (_req, res) => res.json({ languages: [
  { id: 'python', name: 'Python', packageManager: 'pip' },
  { id: 'javascript', name: 'JavaScript', packageManager: 'npm' }
]}));

app.post('/install', async (req, res) => {
  const language = resolveLanguage(req.body?.language), packageName = req.body?.package;
  if (!language) return res.status(400).json({ error: 'Supported languages: python, javascript' });
  if (!validPackage(packageName, language.name)) return res.status(400).json({ error: 'Invalid package name for the selected language' });
  await withWorkspace(req, res, async entry => {
    await fs.mkdir(path.join(entry.dir, '.packages'), { recursive: true });
    const result = await runContainer({
      image: language.image, command: language.installCommand(packageName), workspace: entry.dir,
      timeoutMs: INSTALL_TIMEOUT_MS, networkEnabled: true, env: language.env
    });
    res.status(result.exitCode === 0 ? 200 : 400).json({ success: result.exitCode === 0, package: packageName, language: language.name, ...result });
  });
});

app.post('/run', async (req, res) => {
  const language = resolveLanguage(req.body?.language), code = req.body?.code;
  if (!language) return res.status(400).json({ error: 'Supported languages: python, javascript' });
  if (typeof code !== 'string' || Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) return res.status(400).json({ error: 'Code must be a string no larger than 100 KB' });
  await withWorkspace(req, res, async entry => {
    const filename = 'main' + language.extension;
    await fs.writeFile(path.join(entry.dir, filename), code, { encoding: 'utf8', mode: 0o600 });
    const result = await runContainer({
      image: language.image, command: language.command('/workspace/' + filename), workspace: entry.dir,
      timeoutMs: RUN_TIMEOUT_MS, networkEnabled: false, env: language.env
    });
    res.json({ success: result.exitCode === 0 && !result.timedOut, language: language.name, ...result });
  });
});

setInterval(async () => {
  const now = Date.now();
  for (const [id, entry] of workspaces) {
    if (!entry.busy && now - entry.lastUsed > WORKSPACE_TTL_MS) {
      workspaces.delete(id);
      try { await fs.rm(entry.dir, { recursive: true, force: true }); }
      catch (error) { console.error('Workspace cleanup failed:', error.message); }
    }
  }
}, 60000).unref();

app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  const corsError = error.message?.includes('CORS');
  res.status(corsError ? 403 : 400).json({ error: corsError ? 'Origin not allowed' : 'Invalid request' });
});
const server = app.listen(PORT, '0.0.0.0', () => console.log('CodePulse API listening on port ' + PORT));
function shutdown() { server.close(() => process.exit(0)); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
