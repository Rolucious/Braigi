# Braigi — Project Instructions

## Overview

Voice-enabled web UI for Claude Code. Node.js backend (HTTP + WebSocket), SPA frontend with ES modules, Claude Agent SDK bridge, Speaches/Parakeet voice backends.

## Version Numbering

Braigi uses **semantic versioning** (`MAJOR.MINOR.PATCH`) in `package.json`.

| Bump | When |
|------|------|
| **PATCH** (`x.y.Z`) | Bug fixes, security hardening, dependency updates, refactors with no behavior change |
| **MINOR** (`x.Y.0`) | New features, new UI toggles, new API endpoints, new settings |
| **MAJOR** (`X.0.0`) | Breaking changes to CLI flags, config format, API contract, or upgrade steps required |

**Rules:**
- Every `feat:` commit MUST bump at least MINOR
- Every `fix:` commit MUST bump at least PATCH
- `chore:` / `docs:` commits do NOT require a bump (but may include one)
- Version bump goes in its own commit: `chore: bump version to x.y.z`
- The version bump commit comes AFTER the functional commit(s)
- `docs/CHANGELOG.md` MUST be updated for MINOR and MAJOR bumps; PATCH updates are optional but encouraged

## Code Style

- Plain ES5-style JavaScript (var, function, no arrow functions, no class syntax)
- No build step — frontend served as-is from `lib/public/`
- Frontend uses ES modules (`import`/`export`) loaded via `<script type="module">`
- Backend uses CommonJS (`require`/`module.exports`)
- No TypeScript, no JSX, no transpilation

## Security Conventions

- CSP: `script-src 'self'` — no inline scripts, no eval
- WebSocket: reject upgrades with missing Origin header
- POST endpoints: require `Content-Type: application/json` (CSRF protection via preflight)
- User-generated SVG/HTML: sanitize through DOMPurify before DOM insertion
- No `innerHTML` with untrusted content — use `textContent` + `insertAdjacentHTML` with sanitization

## Architecture

```
bin/cli.js          → CLI entry point (interactive menu, daemon management)
lib/daemon.js       → Background daemon (manages projects, IPC socket)
lib/server.js       → HTTP server + WebSocket per project
lib/sdk-bridge.js   → Claude Agent SDK query lifecycle
lib/sessions.js     → Multi-session state, persistence (JSONL), history replay
lib/project.js      → Per-project routes, file browser, CLI session browser
lib/config.js       → Configuration loading (~/.braigi-rc)
lib/ipc.js          → Unix socket IPC (daemon ↔ CLI)
lib/terminal*.js    → Terminal session management (pty)
lib/public/         → SPA frontend (index.html + ES modules)
```

## Git Conventions

- Conventional commits: `feat:`, `fix:`, `docs:`, `chore:`
- NEVER add `Co-Authored-By:` or AI attribution
- Branch: `main` only
