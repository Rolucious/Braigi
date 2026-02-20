#!/bin/bash
set -euo pipefail
# =============================================================================
# Stop Braigi relay daemon
# =============================================================================
# Sends graceful shutdown via IPC socket. Falls back to SIGTERM if IPC fails.
# =============================================================================

SOCK_FILE="${HOME}/.braigi/daemon.sock"
CONFIG_FILE="${HOME}/.braigi/daemon.json"
PID_FILE="/tmp/braigi.pid"

# Resolve daemon PID from config or PID file
get_pid() {
    if [ -f "$CONFIG_FILE" ] && command -v node &>/dev/null; then
        node -e "
            try { var c = JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf8'));
                  if (c.pid) process.stdout.write(String(c.pid)); }
            catch(e) {}
        " 2>/dev/null
    elif [ -f "$PID_FILE" ]; then
        cat "$PID_FILE"
    fi
}

PID=$(get_pid)

if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
    echo "Braigi daemon is not running"
    rm -f "$PID_FILE"
    exit 0
fi

echo "Stopping Braigi daemon (PID $PID)..."

# Try IPC shutdown first
if [ -S "$SOCK_FILE" ] && command -v node &>/dev/null; then
    RESP=$(node -e "
        var net = require('net');
        var c = net.connect('$SOCK_FILE');
        c.on('connect', function() { c.write('{\"cmd\":\"shutdown\"}\n'); });
        c.on('data', function(d) { process.stdout.write(d.toString()); c.destroy(); });
        c.on('error', function() { process.stdout.write('{\"ok\":false}'); });
        setTimeout(function() { c.destroy(); process.stdout.write('{\"ok\":false}'); }, 3000);
    " 2>/dev/null || echo '{"ok":false}')

    # Wait up to 5 seconds for process to exit
    for i in $(seq 1 10); do
        if ! kill -0 "$PID" 2>/dev/null; then
            echo "Braigi daemon stopped gracefully"
            rm -f "$PID_FILE"
            exit 0
        fi
        sleep 0.5
    done
fi

# Fallback: SIGTERM
echo "IPC shutdown timed out, sending SIGTERM..."
kill "$PID" 2>/dev/null

for i in $(seq 1 10); do
    if ! kill -0 "$PID" 2>/dev/null; then
        echo "Braigi daemon stopped via SIGTERM"
        rm -f "$PID_FILE"
        exit 0
    fi
    sleep 0.5
done

# Last resort: SIGKILL
echo "SIGTERM timed out, sending SIGKILL..."
kill -9 "$PID" 2>/dev/null
rm -f "$PID_FILE"
echo "Braigi daemon killed"
