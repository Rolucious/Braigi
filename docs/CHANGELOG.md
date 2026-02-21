# Changelog

## v1.6.0

### Session Moving & Plan Approval Fix
- **Move sessions between projects**: right-click a session in the sidebar and choose "Move to..." to transfer it to another project — history, settings, and backend preference all travel with it
- **Plan approval no longer loops**: if you didn't respond to an ExitPlanMode prompt within 5 minutes, it would time out and re-ask in a loop; now plans wait 30 minutes and orphaned prompts are cleaned up when a query ends
- **ExitPlanMode excluded from yolo mode**: plan approvals always require manual confirmation, even with yolo mode enabled
- Session moves are now safe against data loss — the target project receives the session before the source deletes it, so a failed import can't lose your session
- Sessions with an active terminal takeover can't be moved (prevents orphaned PTY processes)

## v1.5.0

### Waveform Visualizer, Queue Button, Project Creation, Voice Improvements
- **Voice waveform visualizer**: real-time animated frequency bars replace the textarea while recording
- **Message queue**: queue follow-up messages while Claude is processing (Ctrl+Enter or click queue button), auto-sent when turn completes
- **Add project via web UI**: "Add project" button in project dropdown opens a modal to register new project directories
- Removed interim transcription (unreliable partial results) in favor of final-only STT
- TTS retry logic with cap (max 2 retries per sentence, then skip)
- TTS prefetch error recovery (re-queue on fetch failure)
- STT proxy timeout increased to 120s for long recordings
- Parakeet chunk size reduced from 1.5 min to 1.0 min for faster processing

## v1.4.1

### Voice Proxy Fix
- Guard voice proxy handlers against double header writes (prevents crashes on aborted requests)

## v1.4.0

### Turn Timing Instrumentation
- Per-turn timing: overhead, time-to-first-token, per-tool durations, total API time
- Timing data shown in turn metadata footer

## v1.3.1

### SDK Permission Fixes
- Grant Claude SDK full server access via `bypassPermissions`
- Disable Codex sandbox and persist always-allow tool decisions

## v1.3.0

### Codex as Interactive AI Backend
- **Dual backend**: switch between Claude and Codex (OpenAI gpt-5.3-codex) per session
- Model selector in input bar for quick backend switching
- Codex integration via MCP tool (`codex` / `codex-reply`) with thread persistence
- Backend preference saved per session and restored on reload

## v1.2.1

### Terminal Takeover Hardening
- Prevent environment variable leaks to terminal sessions
- Fix stuck takeover state when terminal exits unexpectedly

## v1.2.0

### Terminal Takeover
- **Continue in Terminal** button: seamlessly switch from web chat to a full `claude --resume` terminal session
- Chat input hidden and info banner shown while terminal is active
- **Return to Web Chat** button or terminal exit auto-restores web chat mode
- Server-side PTY exit handler ensures clean state even if all clients disconnect
- UUID validation on session IDs prevents command injection
- Capacity check before aborting SDK query (no partial state change on failure)
- Pending permissions and ask-user prompts cleared on takeover
- All connected clients see takeover state (multi-device aware)

## v1.1.1

### Security & Resource Hardening
- Reject WebSocket upgrades with missing Origin header (CSWSH prevention)
- Remove `unsafe-inline` from CSP `script-src` directive
- Add Content-Type CSRF check on permission-response POST
- Sanitize mermaid SVG through DOMPurify before DOM injection
- Bound message queue to 100 entries with overflow drop
- Cap messageUUIDs at 5000 and rebase indices on history trim
- Convert sync FS calls to async in file browser (non-blocking)
- Cancel in-progress STT recording when sending a message

## v1.1.0

### Bug Fixes
- Fix voice state not resetting fully on session switch (dangling audioChunks/mediaRecorder)
- Increase healthcheck interval to 300s (was causing false restarts)
- Address 36 findings from full Codex source analysis (20 HIGH/MEDIUM + 12 MEDIUM + 4 LOW)

## v1.0.0

Initial public release.

### Voice Integration
- **Speech-to-text**: click mic to record, click again to stop — transcribed text appears in input
- **Auto-TTS**: Claude's responses read aloud (toggle on/off, skips code blocks)
- **Review before send**: edit transcribed text before sending
- STT via Parakeet (CPU, ONNX INT8 — no GPU needed)
- TTS via Speaches (GPU, Kokoro-82M)

### Web UI
- Real-time markdown rendering as Claude responds
- Tool approvals — approve or reject Claude's tool calls from the browser
- **Yolo mode** — auto-approve all tool permission requests without interaction
- Full-text session search with hit timeline
- Rewind to any previous turn with file diffs
- Plan approval UI for `ExitPlanMode`
- Mermaid diagram rendering with PNG export
- Code viewer with syntax highlighting and line numbers
- Edit tool diff rendering (unified + split view)
- Pasted content shown as compact chips with modal viewer
- Image attach with camera/photo library picker (mobile)
- Copy button on code blocks and assistant messages
- Usage panel with rate limit progress bars

### Session Management
- Persistent JSONL-based session storage
- **CLI session browser**: browse and resume old Claude CLI sessions from the sidebar
- Multi-project support with per-project slugs and sessions
- Project persistence via `~/.braigi-rc` with auto-restore
- Draft persistence: unsent input saved per session
- Session grouping by date (Today / Yesterday / This Week / Older)

### Terminal & Files
- Multi-tab terminal sessions with rename, reorder, and independent scrollback
- Live-reload file viewer (auto-updates on external changes)
- Special key toolbar for terminal on mobile (Tab, Ctrl+C, arrows)

### Notifications
- Push notifications for responses, permission requests, questions, errors
- Favicon blinks and tab title flashes on attention needed
- Browser alert and sound toggles

### CLI
- Interactive menu with project management, settings, and daemon control
- `--add`, `--remove`, `--list` flags for non-interactive project management
- `--shutdown` to stop the daemon
- QR code display for web UI URL
- Auto-update check on startup

### Infrastructure
- Port range: relay 27244, STT 27245, TTS 27246
- All ports configurable via `BRAIGI_*` environment variables
- Portable docker-compose with relative paths (no external `.env` required)
- Daemon runs in background, survives CLI exit
