#!/bin/bash
# =============================================================================
# Ensure Speaches models are downloaded and loaded
# =============================================================================
# Waits for Speaches health endpoint, then triggers model downloads if needed.
# Models persist in the HuggingFace cache volume — only downloads on first run.
#
# Usage: ./ensure-models.sh [--wait]
#   --wait: Block until Speaches is healthy (default: fail fast)
# =============================================================================
set -uo pipefail

SPEACHES_URL="${SPEACHES_URL:-http://localhost:27246}"
STT_MODEL="Systran/faster-whisper-large-v3"
TTS_MODEL="speaches-ai/Kokoro-82M-v1.0-ONNX"
MAX_WAIT=300  # 5 minutes

# Parse args
WAIT=false
[ "${1:-}" = "--wait" ] && WAIT=true

# Wait for Speaches to be healthy
check_health() {
    python3 -c "import urllib.request; urllib.request.urlopen('${SPEACHES_URL}/health')" 2>/dev/null
}

if ! check_health; then
    if [ "$WAIT" = true ]; then
        echo "Waiting for Speaches at ${SPEACHES_URL}..."
        elapsed=0
        while ! check_health && [ $elapsed -lt $MAX_WAIT ]; do
            sleep 5
            elapsed=$((elapsed + 5))
        done
        if ! check_health; then
            echo "ERROR: Speaches not healthy after ${MAX_WAIT}s" >&2
            exit 1
        fi
    else
        echo "ERROR: Speaches not healthy at ${SPEACHES_URL}" >&2
        exit 1
    fi
fi

echo "Speaches is healthy"

# Check loaded models
MODELS=$(python3 -c "
import urllib.request, json
resp = urllib.request.urlopen('${SPEACHES_URL}/v1/models')
data = json.loads(resp.read())
for m in data.get('data', []):
    print(m['id'])
" 2>/dev/null)

# Download STT model if not loaded
if echo "$MODELS" | grep -qF "$STT_MODEL"; then
    echo "STT model already loaded: $STT_MODEL"
else
    echo "Downloading STT model: $STT_MODEL ..."
    python3 -c "
import urllib.request
req = urllib.request.Request('${SPEACHES_URL}/v1/models/${STT_MODEL}', method='POST', data=b'')
urllib.request.urlopen(req, timeout=600)
print('Done')
" 2>&1
fi

# Download TTS model if not loaded
if echo "$MODELS" | grep -qF "$TTS_MODEL"; then
    echo "TTS model already loaded: $TTS_MODEL"
else
    echo "Downloading TTS model: $TTS_MODEL ..."
    python3 -c "
import urllib.request
req = urllib.request.Request('${SPEACHES_URL}/v1/models/${TTS_MODEL}', method='POST', data=b'')
urllib.request.urlopen(req, timeout=600)
print('Done')
" 2>&1
fi

echo "All models ready"
