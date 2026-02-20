#!/bin/bash
set -euo pipefail
# =============================================================================
# Start Braigi relay daemon
# =============================================================================
# Starts the Node.js daemon in the background with logging.
# Safe to call if already running (exits cleanly).
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRAIGI_DIR="$(dirname "$SCRIPT_DIR")"
DAEMON="$BRAIGI_DIR/lib/daemon.js"
LOG_FILE="${BRAIGI_LOG:-$BRAIGI_DIR/braigi.log}"
PID_FILE="/tmp/braigi.pid"

if [ ! -f "$DAEMON" ]; then
    echo "ERROR: daemon.js not found at $DAEMON" >&2
    exit 1
fi

if ! command -v node &>/dev/null; then
    echo "ERROR: node not found in PATH" >&2
    exit 1
fi

# Check if already running via config PID
CONFIG_FILE="${HOME}/.braigi/daemon.json"
if [ -f "$CONFIG_FILE" ]; then
    EXISTING_PID=$(node -e "
        try { var c = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
              if (c.pid) process.stdout.write(String(c.pid)); }
        catch(e) {}
    " -- "$CONFIG_FILE" 2>/dev/null)
    if [ -n "$EXISTING_PID" ] && kill -0 "$EXISTING_PID" 2>/dev/null; then
        echo "Braigi daemon already running (PID $EXISTING_PID)"
        exit 0
    fi
fi

# Clean up stale socket
SOCK_FILE="${HOME}/.braigi/daemon.sock"
if [ -S "$SOCK_FILE" ]; then
    rm -f "$SOCK_FILE"
fi

# Start daemon in background
echo "Starting Braigi daemon..."
nohup node "$DAEMON" >> "$LOG_FILE" 2>&1 &
DAEMON_PID=$!
echo "$DAEMON_PID" > "$PID_FILE"

# Wait briefly and verify it started
sleep 1
if kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "Braigi daemon started (PID $DAEMON_PID)"
    echo "Log: $LOG_FILE"
else
    echo "ERROR: Daemon exited immediately — check $LOG_FILE" >&2
    rm -f "$PID_FILE"
    tail -5 "$LOG_FILE" 2>/dev/null >&2
    exit 1
fi
