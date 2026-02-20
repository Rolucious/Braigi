#!/bin/bash
set -euo pipefail
# codex-review.sh — Run Codex code review against a repo
# Usage: codex-review.sh <repo-path> [--base <branch>|--uncommitted|--commit <sha>]
# Output: review text to stdout
#
# Note: --profile flag is partially broken in Codex v0.98.0,
# so we use -c flags to override settings inline.

REPO="${1:?Usage: codex-review.sh <repo-path> [review flags...]}"
shift

cd "$REPO"

codex \
  -c 'model="gpt-5.3-codex"' \
  -c 'model_reasoning_effort="medium"' \
  -c 'model_reasoning_summary="detailed"' \
  -c 'model_verbosity="low"' \
  -c 'web_search="disabled"' \
  exec review --dangerously-bypass-approvals-and-sandbox "$@"
