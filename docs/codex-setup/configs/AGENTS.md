# Review Guidelines

You are reviewing code in this repository.

## Severity Levels
- CRITICAL: Active security vulnerability, data loss risk, or service-breaking misconfiguration
- HIGH: Security hardening gap, reliability issue, or credential exposure
- MEDIUM: Best practice deviation, missing validation, or resource management gap
- LOW: Style, documentation, or minor optimization

## What to Check
1. **Security**: secrets not hardcoded, input validation, no injection vulnerabilities, principle of least privilege
2. **Reliability**: error handling, health checks, graceful degradation, restart policies
3. **Resource management**: memory/CPU limits, connection pooling, log rotation
4. **Network**: least-privilege network access, internal networks for databases, service discovery by name (not IP)
5. **Dependencies**: pinned versions for critical deps, no known vulnerable packages
6. **Configuration**: environment variables for secrets (not hardcoded), sensible defaults

## Infrastructure Context (do NOT flag these as issues)
- YAML merge keys (`<<: [*anchor]`) are an expected DRY pattern, not invalid syntax
- Environment variables like `${VAR_NAME}` come from a central `.env` file — they are not undefined
- Add any project-specific "known patterns" here so Codex doesn't flag them as issues

## Output Format
List findings as: `[SEVERITY] file-or-service: description`
End with a summary line: `X CRITICAL, Y HIGH, Z MEDIUM, W LOW`
If no findings: `No issues found.`
