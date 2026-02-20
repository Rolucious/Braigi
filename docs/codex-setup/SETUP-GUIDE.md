# Claude Code + Codex CLI: Multi-Agent Dev Setup

A dual-AI-agent workflow using **Claude Code** (Anthropic) as the primary coding agent and **Codex CLI** (OpenAI) as an independent reviewer and second-opinion coder. Both agents have access to your local filesystem, MCP servers, and can be orchestrated together.

---

## Architecture Overview

```
You (human)
  |
  v
Claude Code (primary agent)
  |-- Writes code, manages infrastructure, orchestrates tasks
  |-- Has MCP servers: GitHub, Context7 (docs), Codex CLI
  |-- Can spawn agent teams for parallel work
  |
  +---> Codex CLI (independent reviewer)
          |-- Reviews code before every commit
          |-- Provides second opinions on architecture
          |-- Has its own MCP servers (Context7 for docs)
          |-- Accessed via CLI (file reviews) or MCP (quick questions)
```

### Three Channels for Codex

| Channel | Use Case | How |
|---------|----------|-----|
| CLI (file reviews) | Code review before commits | `cd /repo && codex exec review` |
| CLI (analysis) | Deep analysis with doc lookup | `cd /repo && codex "Check config against official docs using Context7"` |
| MCP (from Claude) | Quick questions, no file access needed | Claude calls `codex()` MCP tool |

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 22.x+ | [nodejs.org](https://nodejs.org/) |
| Claude Code | Latest | `npm install -g @anthropic-ai/claude-code` |
| Codex CLI | Latest | `npm install -g @openai/codex` |
| gh CLI | Latest | [cli.github.com](https://cli.github.com/) |
| tmux | 3.x+ | Package manager |

### Authentication

```bash
# Claude Code — uses Anthropic API key or OAuth
claude auth

# Codex CLI — uses OpenAI API key or ChatGPT OAuth
codex auth

# GitHub CLI
gh auth login
```

---

## Directory Layout

Adapt paths to your system. The key principle: **all AI config lives in one persistent directory** that survives reboots/reinstalls.

```
~/.claude/                    # Claude Code user runtime (settings, auth, plugins)
~/.codex/                     # Codex CLI config (profiles, auth, MCP servers)
~/projects/                   # Your code repositories

# Optional central config location:
/path/to/persistent-storage/
  ├── .claude/
  │   ├── CLAUDE.md           # Project-level instructions (auto-loaded by Claude)
  │   ├── templates/
  │   │   └── AGENTS.md       # Review instructions template for Codex
  │   └── scripts/
  │       ├── codex-review.sh # Review wrapper script
  │       └── deploy-agents-md.sh  # Deploy AGENTS.md to all repos
  └── .codex/
      └── config.toml         # Codex profiles + MCP servers
```

---

## Step 1: Configure Codex CLI

Create `~/.codex/config.toml` with profiles for different use cases:

```toml
# See: configs/codex-config.toml (included in this package)
```

**Key concepts:**
- **Profiles** let you switch models/settings per task without CLI flags
- **review** profile: fast, low-verbosity, no web search, auto-approve (for CI-like reviews)
- **quick** profile: smallest model, minimum cost, for simple questions
- **deep** profile: strongest model, high reasoning, for complex analysis
- **MCP servers**: Context7 gives Codex access to official library documentation

### Profile Usage

```bash
# Default profile (interactive coding)
codex "Help me refactor this module"

# Review profile (code review)
codex --profile review exec review

# Quick profile (cheap, fast)
codex --profile quick "What does this error mean?"

# Deep profile (complex reasoning)
codex --profile deep "Design a migration strategy for this database"
```

---

## Step 2: Configure Claude Code

### Settings (`~/.claude/settings.json`)

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
    "CLAUDE_CODE_SUBAGENT_MODEL": "sonnet",
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "75",
    "BASH_MAX_OUTPUT_LENGTH": "8000",
    "MAX_MCP_OUTPUT_TOKENS": "15000"
  },
  "teammateMode": "auto",
  "includeCoAuthoredBy": false
}
```

**What these do:**
- `AGENT_TEAMS`: Enables Claude Code to spawn multiple agents working in parallel
- `SUBAGENT_MODEL`: Sub-agents use Sonnet (cheaper) while main agent uses Opus
- `AUTOCOMPACT_PCT_OVERRIDE`: Compresses context at 75% usage to extend conversations
- `BASH_MAX_OUTPUT_LENGTH` / `MAX_MCP_OUTPUT_TOKENS`: Caps tool output to save context
- `teammateMode: auto`: Claude decides when to spawn teammates
- `includeCoAuthoredBy: false`: No AI attribution in commits

### MCP Servers (`.claude.json` in project root or `~/.claude.json`)

Set up these MCP servers for Claude Code:

1. **Codex CLI** — lets Claude call Codex directly
2. **GitHub** — PR/issue management without gh CLI
3. **Context7** — versioned library documentation

Configure via `claude mcp add` or edit `.claude.json` directly.

### CLAUDE.md (Project Instructions)

Place a `CLAUDE.md` file in your project root. Claude Code auto-loads it as system instructions. This is where you define:

- Project conventions and coding standards
- Infrastructure context (paths, networks, services)
- Docker/deployment patterns
- Git workflow rules
- Security requirements

This is the single most impactful file — it turns Claude from a generic assistant into a domain expert for your specific project.

---

## Step 3: Set Up Code Reviews with AGENTS.md

Codex CLI auto-loads `AGENTS.md` from the repo root when running `codex exec review`. This file tells Codex what to look for and how to report findings.

```markdown
# See: configs/AGENTS.md (included in this package)
```

**Deploy to all repos:**

```bash
# Copy AGENTS.md to each repo root, commit, and push
for repo in repo1 repo2 repo3; do
  cp templates/AGENTS.md /path/to/$repo/AGENTS.md
  cd /path/to/$repo
  git add AGENTS.md && git commit -m "chore: add AGENTS.md for Codex reviews"
  git push
done
```

---

## Step 4: The Review Wrapper Script

A shell script standardizes review invocations with consistent model/settings overrides:

```bash
# See: scripts/codex-review.sh (included in this package)
```

**Usage:**

```bash
# Review uncommitted changes
./codex-review.sh /path/to/repo --uncommitted

# Review against a branch
./codex-review.sh /path/to/repo --base main

# Review a specific commit
./codex-review.sh /path/to/repo --commit abc123
```

---

## Step 5: The Multi-Agent Pipeline

### Pre-Commit Review Flow

```
Claude writes code
    |
    v
codex-review.sh runs against uncommitted changes
    |
    v
Codex returns findings: CRITICAL / HIGH / MEDIUM / LOW
    |
    v
Claude addresses findings:
  - CRITICAL/HIGH: Fix before commit (blockers)
  - MEDIUM: Fix if easy, otherwise create GitHub issue
  - LOW: Note if relevant, no fix required
    |
    v
Commit proceeds
```

### Pipeline Prompt (for automated mode)

When running Claude in automated/bypass-permissions mode, append a system prompt that enforces the review pipeline:

```
## Before Every Commit
1. Run Codex review: codex-review.sh <repo> --uncommitted
2. Address all CRITICAL/HIGH findings before committing
3. MEDIUM findings: fix if easy, otherwise create GitHub issue
4. LOW: note in commit message if relevant

## Codex Channel Selection
- File reviews -> CLI: codex-review.sh <repo>
- Quick questions -> MCP: codex() tool
- Multi-turn -> MCP: codex() then codex-reply() with threadId
```

### Agent Teams (Parallel Work)

Claude Code can spawn multiple agents for parallel work:

```
Claude (orchestrator)
  |
  +-- Agent 1: "Fix the auth bug in service A"
  |
  +-- Agent 2: "Update the API docs"
  |
  +-- Agent 3: "Write tests for the new endpoint"
```

Key setting: teammates MUST use `bypassPermissions` mode, otherwise they stall waiting for approval on every tool call.

---

## Workflow Summary

### Daily Development

1. **Start Claude Code** in your project directory
2. **Describe your task** — Claude reads CLAUDE.md and understands your stack
3. **Claude writes code**, using its tools (file read/write, bash, git, MCP)
4. **Before committing**, Claude runs Codex review automatically (if pipeline prompt is active) or you trigger it manually
5. **Address findings**, commit, push

### Architecture Decisions

```
You: "Should I use Redis or Memcached for caching?"
Claude: *calls Codex MCP for second opinion*
Codex: *analyzes with Context7 docs*
Claude: *synthesizes both perspectives, recommends approach*
```

### Doc-Aware Config Review

```bash
# In a tmux pane, run Codex directly with Context7:
cd /path/to/your/project
codex "Review my nginx config against official docs using Context7. Flag misconfigurations."
```

---

## Known Gotchas

| Issue | Workaround |
|-------|------------|
| Codex `--profile` flag doesn't inherit to `exec` subcommands | Use `-c` flags to override settings inline |
| Codex Landlock sandbox blocks `git` even in read-only mode | Use `--dangerously-bypass-approvals-and-sandbox` for reviews |
| `codex exec review` ignores `--cd`, `--sandbox`, `-o` flags | Always `cd` into the repo directory first |
| Claude `settings.json` env vars only take effect on session start | Restart Claude Code after changing settings |
| Distroless Docker images have no shell | Can't use `CMD-SHELL` healthchecks on them |
| Write tool can produce CRLF line endings | Run `sed -i 's/\r$//'` on generated shell scripts |

---

## Adapting This Setup

This setup was built for a Docker Compose homelab on Unraid, but the pattern works for any project:

1. **Replace CLAUDE.md** with your project's conventions, paths, and patterns
2. **Customize AGENTS.md** for what Codex should check in your codebase (language-specific linting rules, framework patterns, security requirements)
3. **Adjust Codex profiles** — swap models based on your OpenAI plan (GPT-4o works fine for reviews if you don't have Codex-tier access)
4. **Add MCP servers** relevant to your stack — Context7 covers most popular frameworks
5. **Scale the pipeline** — add GitHub Actions as a formal CI gate if you want enforced reviews on PRs

The core idea is simple: **two independent AI agents reviewing each other's blind spots**, with structured communication channels between them.
