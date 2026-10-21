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

The API uses Docker Engine through its local Docker socket. Pulling the language images happens on first use.

## Prepared Linux VM deployment

`Dockerfile` and `compose.yaml` are included for a Linux VM that you control and that has Docker Engine plus the Docker Compose plugin installed. GitHub Pages cannot host this API.

1. Clone this repository on the VM.
2. Create the shared workspace directory: `sudo mkdir -p /opt/codepulse/workspaces`.
3. Create a `.env` file in the repository directory (do not commit it) containing:

   ```dotenv
   CODEPULSE_API_KEY=replace_with_a_random_secret_at_least_32_characters
   CORS_ALLOWED_ORIGINS=https://your-frontend-domain.example
   ```

   Generate a key using `openssl rand -hex 32`; use the resulting value for `CODEPULSE_API_KEY`.
4. Build and start the API: `docker compose up -d --build`.
5. Check logs with `docker compose logs -f codepulse-api` and health locally with `curl http://127.0.0.1:3000/health`.
6. Put the service behind an HTTPS reverse proxy such as Caddy or Nginx. The compose file binds port 3000 to localhost intentionally; do not expose unauthenticated plain HTTP directly to the internet.
7. Test `/run` and `/install` with the API key before connecting the desktop app.

**Critical security note:** this deployment gives the API access to `/var/run/docker.sock`, which is effectively root-level control of the VM. Use a dedicated VM for CodePulse only, keep the host patched, restrict SSH and firewall access, and never run this configuration on a machine containing personal or production data. Container isolation is not a complete security boundary for hostile code. For a public multi-user launch, use a hardened sandbox service or separate worker hosts and implement user authentication, short-lived credentials, quotas, monitoring, and abuse controls first.

A hosting provider account, VM, and domain/reverse-proxy setup are still required to produce a public HTTPS API URL. These resources cannot be provisioned from this repository alone.

## Security and prototype limitations

- Code runs in containers with CPU, memory, process, filesystem, and execution-time limits. Containers share the host kernel; for untrusted public code, use a stronger sandbox or managed execution service, isolate workers from secrets, and enforce outbound network policy.
- Package installation intentionally needs network access. npm lifecycle scripts and packages are untrusted; install them only inside the restricted worker.
- Workspaces are mapped in memory and stored in temporary local directories. They are not durable and are not shared across API replicas; restarting the API clears session mappings and can lose package state.
- Add persistent session ownership, per-user quotas, distributed rate limits, queueing, monitoring, and abuse detection before exposing this service publicly.
- Only Python and JavaScript are implemented today. Additional languages need dedicated, pinned worker images and compiler toolchains.
