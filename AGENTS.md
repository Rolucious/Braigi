# Review Guidelines

You are reviewing a Node.js web application (Braigi — voice-enabled web UI for Claude Code).

## Severity Levels
- CRITICAL: Active security vulnerability, data loss risk, or service-breaking bug
- HIGH: Security hardening gap, reliability issue, or credential exposure
- MEDIUM: Best practice deviation, missing error handling, or performance concern
- LOW: Style, documentation, or minor optimization

## What to Check
1. **Security**: no hardcoded secrets, proper input validation, no shell injection, XSS prevention, WebSocket origin validation, CSP compliance (no unsafe-inline), DOMPurify on untrusted HTML/SVG
2. **Reliability**: error handling in async code, graceful shutdown, connection recovery, resource cleanup, bounded queues/arrays (no unbounded growth)
3. **Docker services**: health checks present, resource limits set, no-new-privileges, log rotation
4. **Dependencies**: no known vulnerable packages, pinned versions where needed
5. **Frontend**: no sensitive data in localStorage, proper CSP compatibility, accessible UI, no innerHTML with unsanitized content
6. **Version bump**: if the diff contains `feat:` or `fix:` changes but `package.json` version is unchanged, flag as MEDIUM ("missing version bump"). Rules: feat → MINOR bump, fix → PATCH bump. Version format: semver (MAJOR.MINOR.PATCH)

## Inline Suppressions

Lines containing `# codex-ignore: SEVERITY-keyword — reason` indicate intentionally accepted patterns. The SEVERITY prefix must be one of CRITICAL, HIGH, MEDIUM, LOW.

## Output Format

Format each finding on its own line as:

```
[SEVERITY] file-or-component: description
```

Where SEVERITY is exactly one of: CRITICAL, HIGH, MEDIUM, LOW

After all findings (or if none), output a separator line and structured footer:

```
---
SUMMARY: X CRITICAL, Y HIGH, Z MEDIUM, W LOW
VERDICT: APPROVED
SCORE: 9/10
```

Rules:
- VERDICT must be exactly `APPROVED` or `NEEDS_REVISION`
- VERDICT is `NEEDS_REVISION` if any CRITICAL finding exists
- VERDICT is `APPROVED` if zero CRITICAL findings
- SCORE is 1-10 where 10 is perfect; deduct ~2 per CRITICAL, ~1 per HIGH, ~0.5 per MEDIUM
- If no findings at all, output: `No issues found.` followed by the separator and footer
- The `---`, `SUMMARY:`, `VERDICT:`, and `SCORE:` lines are mandatory in every review
