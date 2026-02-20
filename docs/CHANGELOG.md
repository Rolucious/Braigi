# Changelog

## v1.0.0

Initial public release.

### Voice Integration
- **Speech-to-text**: click mic to record, click again to stop — transcribed text appears in input
- **Live transcription**: see partial text while still speaking (updates every ~3 seconds)
- **Auto-TTS**: Claude's responses read aloud (toggle on/off, skips code blocks)
- **Review before send**: edit transcribed text before sending
- STT via Parakeet (CPU, ONNX INT8 — no GPU needed)
- TTS via Speaches (GPU, Kokoro-82M)

### Web UI
- Real-time markdown rendering as Claude responds
- Tool approvals — approve or reject Claude's tool calls from the browser
- **Yolo mode** — auto-approve all tool permission requests
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
