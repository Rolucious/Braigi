#!/bin/bash
set -euo pipefail
# deploy-agents-md.sh — Deploy AGENTS.md template to multiple repos
# Usage: deploy-agents-md.sh <template-path> <base-dir> [--dry-run]
#
# Copies AGENTS.md to every git repo found as an immediate subdirectory
# of <base-dir>, then commits and pushes.

TEMPLATE="${1:?Usage: deploy-agents-md.sh <template-path> <base-dir> [--dry-run]}"
BASE="${2:?Usage: deploy-agents-md.sh <template-path> <base-dir> [--dry-run]}"
DRY_RUN="${3:-}"

if [ ! -f "$TEMPLATE" ]; then
    echo "ERROR: Template not found at $TEMPLATE" >&2
    exit 1
fi

for repo_dir in "$BASE"/*/; do
    repo_dir="${repo_dir%/}"
    repo_name="$(basename "$repo_dir")"

    if [ ! -d "$repo_dir/.git" ]; then
        echo "SKIP: $repo_name — not a git repo"
        continue
    fi

    DEST="$repo_dir/AGENTS.md"

    if [[ "$DRY_RUN" == "--dry-run" ]]; then
        echo "[dry-run] Would deploy to $DEST"
    else
        cp "$TEMPLATE" "$DEST"
        git -C "$repo_dir" add AGENTS.md
        if git -C "$repo_dir" diff --cached --quiet; then
            echo "SKIP: $repo_name — AGENTS.md unchanged"
        else
            git -C "$repo_dir" commit -m "chore: add AGENTS.md for Codex CLI reviews"
            git -C "$repo_dir" push origin main
            echo "OK: $repo_name — committed and pushed"
        fi
    fi
done

echo "Done."
