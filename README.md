# Braigi

Voice-enabled web UI for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Chat with Claude from any device — type or speak, approve tools, browse files, and manage terminal sessions from your browser.

## Features

- **Text & voice input** — type normally or click the mic button to record speech-to-text (click again to stop)
- **Auto-TTS** — Claude's responses read aloud (toggle on/off, skips code blocks)
- **Yolo mode** — auto-approve all tool permission requests without interaction
- **Tool approvals** — approve or reject Claude's tool calls from the browser
- **CLI session browser** — browse and resume old Claude CLI sessions from the sidebar
- **Review before send** — optionally preview transcribed speech before sending
- **File browser** — navigate and view project files in the sidebar
- **Terminal tabs** — spawn and manage terminal sessions
- **Session history** — persistent JSONL-based session storage with search
- **Multi-project** — register multiple project directories, each with its own slug and sessions
- **Streaming** — real-time markdown rendering as Claude responds

## Architecture

```
Browser ──── WS /p/{slug}/ws ──────────┐
  │                                     │
  ├── POST /p/{slug}/api/stt ──────► Parakeet (:27245, CPU STT)
  │                                     │
  ├── POST /p/{slug}/api/tts ──────► Speaches (:27246, GPU TTS)
  │                                     │
  └── Static assets                  Braigi Relay (:27244)
                                        │
                                        ├── SDK Bridge ──► Claude Agent SDK
                                        ├── Terminal Manager ──► PTY sessions
                                        └── Session Store ──► ~/.braigi/sessions/
```

The relay daemon runs on the host (not Docker) because it needs direct filesystem access for the Claude Agent SDK. STT and TTS backends run as Docker containers.

## Requirements

- **Node.js** >= 18
- **Docker Compose** (optional — for voice containers)
- **NVIDIA GPU** with CUDA support and `nvidia-container-toolkit` (optional — TTS only)

> Voice is optional. Without Docker, you get a fully functional text-only chat UI. With Docker, you can add STT (CPU) and/or TTS (GPU).

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/Rolucious/braigi.git
cd braigi

# 2. Install dependencies
npm install

# 3. Start the relay
npx braigi
# or: npm start

# 4. Open in browser
# http://localhost:27244
```

### Adding Voice (Optional)

```bash
# STT only (CPU — no GPU needed)
docker compose -f infra/docker-compose.yml up -d parakeet

# STT + TTS (TTS requires NVIDIA GPU + nvidia-container-toolkit)
docker compose -f infra/docker-compose.yml up -d

# Wait for models to download (~2.4 GB on first run)
bash scripts/ensure-models.sh --wait
```

The relay auto-detects voice backends at `localhost:27245` (STT) and `localhost:27246` (TTS). Override with environment variables if needed. Without TTS, you get speech-to-text input but no voice output.

## CLI Usage

```bash
npx braigi                    # Start daemon + interactive menu
npx braigi -p 3000            # Custom port
npx braigi -y                 # Skip interactive prompts
npx braigi --add /path/to/dir # Add a project to the running daemon
npx braigi --remove /path     # Remove a project
npx braigi --list             # List registered projects
npx braigi --shutdown         # Stop the daemon
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BRAIGI_HOST` | `0.0.0.0` | Bind address for the relay server |
| `BRAIGI_STT_URL` | `http://localhost:27245` | Parakeet STT backend URL |
| `BRAIGI_TTS_URL` | `http://localhost:27246` | Speaches TTS backend URL |
| `BRAIGI_STT_MODEL` | `parakeet` | Model name for STT requests |
| `BRAIGI_TTS_MODEL` | `speaches-ai/Kokoro-82M-v1.0-ONNX` | Model name for TTS requests |
| `BRAIGI_TTS_VOICE` | `af_heart` | TTS voice preset |
| `BRAIGI_LOG` | `braigi.log` | Log file path |

## Docker Services

| Service | Image | Port | Resource |
|---------|-------|------|----------|
| **parakeet** | `parakeet-tdt:cpu` (local build) | 27245 | CPU (Parakeet TDT 0.6B, ONNX INT8 STT) |
| **speaches** | `ghcr.io/speaches-ai/speaches:latest-cuda` | 27246 | GPU (Kokoro-82M TTS) |

## Reverse Proxy Setup

Braigi works great behind a reverse proxy for remote access over HTTPS. The key requirements are **WebSocket support** and proper **header forwarding**.

### Requirements (Any Reverse Proxy)

| Requirement | Why |
|-------------|-----|
| WebSocket upgrade on `/p/{slug}/ws` | Real-time chat streaming and tool approvals |
| `X-Forwarded-*` / `X-Real-IP` headers | Client IP logging |
| Large body size (≥ 25 MB) | Audio uploads for speech-to-text |
| No response buffering | SSE and streaming responses |

**Recommended headers:**

```
Permissions-Policy: microphone=(self)
```

Without this, browsers block microphone access on HTTPS pages. If you use speech-to-text, your reverse proxy must either set `microphone=(self)` or not set a `Permissions-Policy` at all (browsers allow microphone by default when no policy is set).

**Optional CSP header:**

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' wss:; frame-ancestors 'self'; base-uri 'self'; object-src 'none'
```

Braigi sets its own CSP header, but your proxy can override or supplement it. If you set CSP at the proxy level, make sure `connect-src` includes `wss:` (for WebSocket) and `media-src` includes `blob:` (for audio recording).

### Traefik v3

Braigi runs on the host (not Docker), so you need a **file-based service** pointing to the host IP. Add to your Traefik dynamic config:

**Service:**

```yaml
# traefik/config.yml (dynamic config, file provider)
http:
  services:
    braigi:
      loadBalancer:
        servers:
          - url: "http://YOUR_HOST_IP:27244"
```

**Routers:**

```yaml
  routers:
    # WebSocket route — must be separate (forward auth breaks WS upgrades)
    braigi-ws:
      rule: "Host(`braigi.example.com`) && PathRegexp(`^/p/[^/]+/ws$`)"
      entryPoints:
        - https
      tls: {}
      priority: 100
      service: braigi

    # Main route (with optional SSO)
    braigi:
      rule: "Host(`braigi.example.com`)"
      entryPoints:
        - https
      tls: {}
      service: braigi
      # middlewares:
      #   - your-auth-middleware@file    # optional: Authentik, Authelia, etc.
```

> **Important:** The WebSocket route (`braigi-ws`) must have higher `priority` than the main route, and must **not** have forward-auth middleware. Auth happens on the initial page load — WebSocket frames are not individually authenticated.

### Nginx

```nginx
upstream braigi {
    server YOUR_HOST_IP:27244;
}

server {
    listen 443 ssl;
    server_name braigi.example.com;

    # TLS config...

    # WebSocket support
    location ~ ^/p/[^/]+/ws$ {
        proxy_pass http://braigi;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;  # keep WS alive
    }

    # Everything else
    location / {
        proxy_pass http://braigi;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 25m;    # audio uploads
        proxy_buffering off;
    }

    # Microphone access
    add_header Permissions-Policy "microphone=(self)" always;
}
```

### Caddy

```caddyfile
braigi.example.com {
    reverse_proxy YOUR_HOST_IP:27244
    header Permissions-Policy "microphone=(self)"
}
```

Caddy handles WebSocket upgrades, header forwarding, and TLS automatically.

## Project Structure

```
braigi/
├── bin/cli.js              # CLI entry point
├── lib/
│   ├── server.js           # HTTP + WebSocket server
│   ├── daemon.js           # Background process + IPC
│   ├── sdk-bridge.js       # Claude Agent SDK integration
│   ├── project.js          # Per-project routes (chat, files, voice, CLI sessions)
│   ├── config.js           # ~/.braigi config management
│   ├── sessions.js         # JSONL session storage
│   ├── pages.js            # HTML page templates
│   ├── ipc.js              # Unix socket IPC
│   ├── terminal-manager.js # Browser terminal sessions
│   ├── terminal.js         # PTY wrapper
│   ├── usage.js            # Token usage tracking
│   ├── updater.js          # Version check
│   └── public/
│       ├── index.html      # Single-page app
│       ├── app.js          # Main frontend logic
│       ├── modules/        # voice.js, sidebar.js, tools.js, etc.
│       └── css/            # base.css, voice.css, etc.
├── infra/
│   ├── docker-compose.yml  # Speaches + Parakeet containers
│   └── parakeet/           # CPU STT build (ONNX INT8)
├── scripts/
│   ├── start-braigi.sh     # Daemon launcher
│   ├── stop-braigi.sh      # Graceful shutdown
│   └── ensure-models.sh    # Model pre-download
├── docs/                   # Architecture, changelog, contributing
└── media/                  # Screenshots
```

## License

MIT — see [LICENSE](LICENSE)
