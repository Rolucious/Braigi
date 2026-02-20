var pty;
try {
  pty = require("@lydell/node-pty");
} catch (e) {
  pty = null;
}

// Safe env vars to pass to PTY child processes.
// Prevents leaking secrets (GH_TOKEN, API keys, etc.) into child environments.
var SAFE_ENV_KEYS = [
  "HOME", "USER", "SHELL", "PATH", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE",
  "TERM", "TMPDIR", "TMP", "TEMP", "EDITOR", "VISUAL", "PAGER",
  "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  "COLORTERM", "TERM_PROGRAM", "HOSTNAME", "LOGNAME", "PWD",
  "SSH_AUTH_SOCK", "SSH_AGENT_PID",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
];

function safeEnv() {
  var env = { TERM: "xterm-256color" };
  for (var i = 0; i < SAFE_ENV_KEYS.length; i++) {
    var key = SAFE_ENV_KEYS[i];
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function createTerminal(cwd, cols, rows) {
  if (!pty) return null;

  var shell = process.env.SHELL || "/bin/bash";
  var term = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: cols || 80,
    rows: rows || 24,
    cwd: cwd,
    env: safeEnv(),
  });

  return term;
}

function createTerminalCommand(cmd, args, cwd, cols, rows) {
  if (!pty) return null;

  var term = pty.spawn(cmd, args || [], {
    name: "xterm-256color",
    cols: cols || 80,
    rows: rows || 24,
    cwd: cwd,
    env: safeEnv(),
  });

  return term;
}

module.exports = { createTerminal: createTerminal, createTerminalCommand: createTerminalCommand };
