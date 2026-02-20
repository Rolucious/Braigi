#!/usr/bin/env node

var fs = require("fs");
var path = require("path");
var { loadConfig, saveConfig, socketPath, generateSlug, syncRc } = require("./config");
var { createIPCServer } = require("./ipc");
var { createServer } = require("./server");

// Remove CLAUDECODE to allow SDK to spawn Claude Code subprocesses
// (prevents "cannot be launched inside another Claude Code session" error)
delete process.env.CLAUDECODE;

// Strip sensitive env vars from this process (prevents leakage to SDK subprocesses)
var SENSITIVE_PATTERNS = [
  "GH_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_TOKEN",
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
  "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY",
  "DATABASE_URL", "DATABASE_PASSWORD", "DB_PASSWORD",
  "SECRET_KEY", "API_KEY", "API_TOKEN",
];
for (var ei = 0; ei < SENSITIVE_PATTERNS.length; ei++) {
  delete process.env[SENSITIVE_PATTERNS[ei]];
}

var configFile = process.env.BRAIGI_CONFIG || require("./config").configPath();
var config;

try {
  config = JSON.parse(fs.readFileSync(configFile, "utf8"));
} catch (e) {
  console.error("[daemon] Failed to read config:", e.message);
  process.exit(1);
}

// --- Create multi-project server ---
var relay = createServer({
  port: config.port,
  debug: config.debug || false,
  host: config.host || undefined,
});

// --- Register projects ---
var projects = config.projects || [];
for (var i = 0; i < projects.length; i++) {
  var p = projects[i];
  if (fs.existsSync(p.path)) {
    console.log("[daemon] Adding project:", p.slug, "→", p.path);
    relay.addProject(p.path, p.slug, p.title);
  } else {
    console.log("[daemon] Skipping missing project:", p.path);
  }
}

// Sync ~/.braigi-rc on startup
try { syncRc(config.projects); } catch (e) {}

// --- IPC server ---
var ipc = createIPCServer(socketPath(), function (msg) {
  switch (msg.cmd) {
    case "add_project": {
      if (!msg.path) return { ok: false, error: "missing path" };
      var absPath = path.resolve(msg.path);
      // Check if already registered
      for (var j = 0; j < config.projects.length; j++) {
        if (config.projects[j].path === absPath) {
          return { ok: true, slug: config.projects[j].slug, existing: true };
        }
      }
      var slugs = config.projects.map(function (p) { return p.slug; });
      var slug = generateSlug(absPath, slugs);
      relay.addProject(absPath, slug);
      config.projects.push({ path: absPath, slug: slug, addedAt: Date.now() });
      saveConfig(config);
      try { syncRc(config.projects); } catch (e) {}
      console.log("[daemon] Added project:", slug, "→", absPath);
      return { ok: true, slug: slug };
    }

    case "remove_project": {
      if (!msg.path && !msg.slug) return { ok: false, error: "missing path or slug" };
      var target = msg.slug;
      if (!target) {
        var abs = path.resolve(msg.path);
        for (var k = 0; k < config.projects.length; k++) {
          if (config.projects[k].path === abs) {
            target = config.projects[k].slug;
            break;
          }
        }
      }
      if (!target) return { ok: false, error: "project not found" };
      relay.removeProject(target);
      config.projects = config.projects.filter(function (p) { return p.slug !== target; });
      saveConfig(config);
      try { syncRc(config.projects); } catch (e) {}
      console.log("[daemon] Removed project:", target);
      return { ok: true };
    }

    case "get_status":
      return {
        ok: true,
        pid: process.pid,
        port: config.port,
        projects: relay.getProjects(),
        uptime: process.uptime(),
      };

    case "set_project_title": {
      if (!msg.slug) return { ok: false, error: "missing slug" };
      var newTitle = msg.title || null;
      relay.setProjectTitle(msg.slug, newTitle);
      for (var ti = 0; ti < config.projects.length; ti++) {
        if (config.projects[ti].slug === msg.slug) {
          if (newTitle) {
            config.projects[ti].title = newTitle;
          } else {
            delete config.projects[ti].title;
          }
          break;
        }
      }
      saveConfig(config);
      try { syncRc(config.projects); } catch (e) {}
      console.log("[daemon] Project title:", msg.slug, "→", newTitle || "(default)");
      return { ok: true };
    }

    case "shutdown":
      console.log("[daemon] Shutdown requested via IPC");
      gracefulShutdown();
      return { ok: true };

    default:
      return { ok: false, error: "unknown command: " + msg.cmd };
  }
});

// --- Start listening ---
relay.server.on("error", function (err) {
  console.error("[daemon] Server error:", err.message);
  process.exit(1);
});

relay.server.listen(config.port, relay.bindHost, function () {
  console.log("[daemon] Listening on http://" + relay.bindHost + ":" + config.port);
  console.log("[daemon] PID:", process.pid);
  console.log("[daemon] Projects:", config.projects.length);

  // Update PID in config
  config.pid = process.pid;
  saveConfig(config);
});

// --- Graceful shutdown ---
var shuttingDown = false;
function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[daemon] Shutting down...");

  ipc.close();
  relay.destroyAll();

  // Remove PID from config
  try {
    var c = loadConfig();
    if (c && c.pid === process.pid) {
      delete c.pid;
      saveConfig(c);
    }
  } catch (e) {}

  relay.server.close(function () {
    console.log("[daemon] Server closed");
    process.exit(0);
  });

  // Force exit after 5 seconds
  setTimeout(function () {
    console.error("[daemon] Forced exit after timeout");
    process.exit(1);
  }, 5000);
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

process.on("uncaughtException", function (err) {
  console.error("[daemon] Uncaught exception:", err);
  gracefulShutdown();
});

process.on("unhandledRejection", function (err) {
  console.error("[daemon] Unhandled rejection:", err);
});
