'use strict';

// Local CodePulse runner. No HTTP service, API key, Docker, or SnapDeploy required.
// Requires Python 3 and Node.js to be installed on the computer.
// Import from Electron's MAIN process only through a narrow, validated IPC handler.
// This executes code with the current user's OS permissions; it is NOT a sandbox.

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const MAX_CODE_BYTES = 100 * 1024;
const MAX_OUTPUT_CHARS = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const LANGUAGES = {
  python: { extension: '.py', executable: process.env.CODEPULSE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3') },
  javascript: { extension: '.js', executable: process.env.CODEPULSE_NODE || 'node' }
};

function runProcess(executable, args, options = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    // Do not pass API keys, tokens, or other parent-process secrets into user code.
    const env = { PATH: process.env.PATH || '' };
    for (const key of ['SystemRoot', 'WINDIR', 'PATHEXT', 'TMP', 'TEMP']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false
    });
    const append = (current, chunk) => (current + chunk.toString('utf8')).slice(-MAX_OUTPUT_CHARS);
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      resolve({ success: false, stdout, stderr: error.code === 'ENOENT'
        ? 'Interpreter not found. Install the required runtime or configure its path.'
        : error.message, exitCode: null, timedOut: false });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs || DEFAULT_TIMEOUT_MS);
    child.on('close', code => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({
        success: !timedOut && code === 0,
        stdout,
        stderr: timedOut ? (stderr + '\nExecution timed out.') : stderr,
        exitCode: timedOut ? null : code,
        timedOut
      });
    });
  });
}

async function runCode({ language, code, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof language !== 'string' || !Object.hasOwn(LANGUAGES, language.toLowerCase())) {
    throw new TypeError('Supported local languages: python, javascript');
  }
  if (typeof code !== 'string' || Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
    throw new TypeError('Code must be text no larger than 100 KB.');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new TypeError('timeoutMs must be an integer between 100 and 60000.');
  }

  const selected = LANGUAGES[language.toLowerCase()];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codepulse-run-'));
  const filename = path.join(dir, 'main' + selected.extension);
  try {
    await fs.writeFile(filename, code, { encoding: 'utf8', mode: 0o600 });
    return await runProcess(selected.executable, [filename], { cwd: dir, timeoutMs });
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { runCode, supportedLanguages: Object.keys(LANGUAGES) };
