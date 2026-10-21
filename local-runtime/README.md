# CodePulse local runtime module

This module lets the desktop IDE run Python and JavaScript locally without calling the hosted CodePulse API, using Docker, or requiring a CodePulse API key.

## Requirements

- Node.js installed and available as `node`
- Python 3 installed and available as `python3` on macOS/Linux or `python` on Windows
- The desktop app must call this module from its Electron **main process**, not directly from renderer/browser code.

## Basic use

```js
const { runCode, supportedLanguages } = require('./local-runtime/runner');

console.log(supportedLanguages); // ['python', 'javascript']

const result = await runCode({
  language: 'python',
  code: 'print("Hello, world!")'
});

console.log(result.stdout);
console.error(result.stderr);
```

The result includes `success`, `stdout`, `stderr`, `exitCode`, and `timedOut`. Optional `timeoutMs` may be set from 100 to 60000. Source code is limited to 100 KB and captured output is limited to 64 KB per stream.

## Electron integration warning

Expose a single validated IPC operation from the main process and keep `contextIsolation: true` and `nodeIntegration: false` in the renderer. Validate the language, code length, and timeout again at the IPC boundary. Never expose arbitrary filesystem or process-spawning functions to the renderer.

**Security limitation:** this module starts local processes; it is not a sandbox. User code runs with the current user's operating-system permissions and may access that user's files. Do not use this runner to execute untrusted code from repositories, extensions, or other users. A production IDE needs a proper OS/container sandbox for untrusted code.

## Portability limitation

This module does not bundle language runtimes. Python and Node.js must be installed on the target computer. To support other languages, add an explicit runtime/adapter for each language and provide a compatible runtime for each supported operating system and CPU architecture.

This module does not replace the existing hosted API; it is a local execution option that the desktop app must explicitly integrate.
