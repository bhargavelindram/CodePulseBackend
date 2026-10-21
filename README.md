# CodePulseBackend

Node.js API for the CodePulse desktop IDE. This repository currently supports Python and JavaScript execution using isolated Docker containers.

## Endpoints

- `GET /health` — unauthenticated health check.
- `GET /languages` — supported language list (requires API key).
- `POST /install` — install a Python package with pip or a JavaScript package with npm.
- `POST /run` — execute source code and return stdout, stderr, exit code, and timeout status.

Authenticated endpoints require `Authorization: Bearer <CODEPULSE_API_KEY>`.

### Example request

```bash
curl -X POST http://localhost:3000/run \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"demo_session_123456","language":"python","code":"print(1 + 1)"}'
```

### Install a package

```bash
curl -X POST http://localhost:3000/install \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"demo_session_123456","language":"python","package":"numpy"}'
```

Use the same `sessionId` for install and run. IDs must be 16–80 characters containing letters, numbers, underscores, or hyphens.

## Configuration

Set these environment variables:

- `PORT` — HTTP port; defaults to `3000`.
- `CODEPULSE_API_KEY` — required secret, at least 32 characters.
- `CORS_ALLOWED_ORIGINS` — comma-separated browser origins allowed to call the API. Native Electron requests without an Origin header are accepted; API-key authentication is still required.

Generate a secret with `openssl rand -hex 32`. Do not put a permanent API key in a distributable Electron client; users can extract it. For public release, add user authentication and short-lived tokens issued by a trusted service.

## Run locally

Requirements: Node.js 20+ and Docker Engine running on the same Linux host as the API process.

```bash
npm install
export CODEPULSE_API_KEY="$(openssl rand -hex 32)"
export CORS_ALLOWED_ORIGINS="http://localhost:3000"
npm start
```

The API uses Docker Engine through its local Docker socket. Run the Node process on the Docker host so temporary workspace paths are visible to the Docker daemon. Pulling the language images happens on first use.

## Deployment note

GitHub Pages is static hosting and cannot run Express or execute programs. A conventional Render/Railway web service also does not automatically provide a Docker daemon or permission to create sandbox containers. Deploy this API on a Linux VM with Docker Engine, or adapt the worker layer to a managed sandbox service that supports isolated execution. Keep the API and worker network access restricted.

## Security and prototype limitations

- Code runs in containers with CPU, memory, process, filesystem, and execution-time limits. Containers share the host kernel; for untrusted public code, use a stronger sandbox or managed execution service, isolate workers from secrets, and enforce outbound network policy.
- Package installation intentionally needs network access. npm lifecycle scripts and packages are untrusted; install them only inside the restricted worker.
- Workspaces are in-memory mapped and stored in temporary local directories. They are not durable and are not shared across API replicas; restarting the API clears session mappings and can lose package state.
- Add persistent session ownership, per-user quotas, distributed rate limits, queueing, monitoring, and abuse detection before exposing this service publicly.
- Only Python and JavaScript are implemented today. Additional languages need dedicated, pinned worker images and compiler toolchains.
