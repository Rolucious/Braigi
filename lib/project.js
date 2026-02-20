var fs = require("fs");
var http = require("http");
var os = require("os");
var path = require("path");
var readline = require("readline");
var { createSessionManager } = require("./sessions");
var { createSDKBridge } = require("./sdk-bridge");
var { createTerminalManager } = require("./terminal-manager");
var { fetchLatestVersion, isNewer } = require("./updater");
var { fetchUsageData } = require("./usage");
var { execFileSync } = require("child_process");
var { log } = require("./log");

// SDK loaded dynamically (ESM module)
var sdkModule = null;
function getSDK() {
  if (!sdkModule) sdkModule = import("@anthropic-ai/claude-agent-sdk");
  return sdkModule;
}

// --- Shared constants ---
var IGNORED_DIRS = new Set(["node_modules", ".git", ".next", "__pycache__", ".cache", "dist", "build", ".braigi"]);
var BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx",
  ".exe", ".dll", ".so", ".dylib",
  ".mp3", ".mp4", ".wav", ".avi", ".mov",
  ".pyc", ".o", ".a", ".class",
]);
var IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"]);
var FS_MAX_SIZE = 512 * 1024;
var MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// --- Voice proxy config ---
var STT_URL = process.env.BRAIGI_STT_URL || "http://localhost:27245";
var TTS_URL = process.env.BRAIGI_TTS_URL || "http://localhost:27246";
var STT_MODEL = process.env.BRAIGI_STT_MODEL || "parakeet";
var TTS_MODEL = process.env.BRAIGI_TTS_MODEL || "speaches-ai/Kokoro-82M-v1.0-ONNX";
var TTS_VOICE = process.env.BRAIGI_TTS_VOICE || "af_heart";
var VOICE_MAX_BODY = 10 * 1024 * 1024; // 10MB for audio uploads

function safePath(base, requested) {
  var resolved = path.resolve(base, requested);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  try {
    var real = fs.realpathSync(resolved);
    if (real !== base && !real.startsWith(base + path.sep)) return null;
    return real;
  } catch (e) {
    return null;
  }
}

/**
 * Create a project context — per-project state and handlers.
 * opts: { cwd, slug, title, debug, currentVersion }
 */
function createProjectContext(opts) {
  var cwd = opts.cwd;
  var slug = opts.slug;
  var project = path.basename(cwd);
  var title = opts.title || null;
  var debug = opts.debug || false;
  var currentVersion = opts.currentVersion;
  var getProjectCount = opts.getProjectCount || function () { return 1; };
  var getProjectList = opts.getProjectList || function () { return []; };
  var latestVersion = null;

  // --- Per-project clients ---
  var clients = new Set();

  function send(obj) {
    var data = JSON.stringify(obj);
    for (var ws of clients) {
      if (ws.readyState === 1) ws.send(data);
    }
  }

  function sendTo(ws, obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function broadcastClientCount() {
    send({ type: "client_count", count: clients.size });
  }

  function sendToOthers(sender, obj) {
    var data = JSON.stringify(obj);
    for (var ws of clients) {
      if (ws !== sender && ws.readyState === 1) ws.send(data);
    }
  }

  // --- File watcher ---
  var fileWatcher = null;
  var watchedPath = null;
  var watchDebounce = null;

  function startFileWatch(relPath) {
    var absPath = safePath(cwd, relPath);
    if (!absPath) return;
    if (watchedPath === relPath) return;
    stopFileWatch();
    watchedPath = relPath;
    try {
      fileWatcher = fs.watch(absPath, function () {
        clearTimeout(watchDebounce);
        watchDebounce = setTimeout(function () {
          try {
            var stat = fs.statSync(absPath);
            var ext = path.extname(absPath).toLowerCase();
            if (stat.size > FS_MAX_SIZE || BINARY_EXTS.has(ext)) return;
            var content = fs.readFileSync(absPath, "utf8");
            send({ type: "fs_file_changed", path: relPath, content: content, size: stat.size });
          } catch (e) {
            stopFileWatch();
          }
        }, 200);
      });
      fileWatcher.on("error", function () { stopFileWatch(); });
    } catch (e) {
      watchedPath = null;
    }
  }

  function stopFileWatch() {
    if (fileWatcher) {
      try { fileWatcher.close(); } catch (e) {}
      fileWatcher = null;
    }
    clearTimeout(watchDebounce);
    watchDebounce = null;
    watchedPath = null;
  }

  // --- Session manager ---
  var sm = createSessionManager({ cwd: cwd, send: send });

  // --- SDK bridge ---
  var sdk = createSDKBridge({
    cwd: cwd,
    sessionManager: sm,
    send: send,
    getSDK: getSDK,
  });

  // --- Terminal manager ---
  var tm = createTerminalManager({ cwd: cwd, send: send, sendTo: sendTo });

  // Check for updates in background
  fetchLatestVersion().then(function (v) {
    if (v && isNewer(v, currentVersion)) {
      latestVersion = v;
      send({ type: "update_available", version: v });
    }
  });

  // --- WS connection handler ---
  function handleConnection(ws) {
    clients.add(ws);
    log(slug, "client connected (" + clients.size + " total)");
    broadcastClientCount();

    // Send cached state
    sendTo(ws, { type: "info", cwd: cwd, slug: slug, project: title || project, version: currentVersion, debug: !!debug, projectCount: getProjectCount(), projects: getProjectList() });
    if (latestVersion) {
      sendTo(ws, { type: "update_available", version: latestVersion });
    }
    if (sm.slashCommands) {
      sendTo(ws, { type: "slash_commands", commands: sm.slashCommands });
    }
    if (sm.currentModel) {
      sendTo(ws, { type: "model_info", model: sm.currentModel, models: sm.availableModels || [] });
    }
    sendTo(ws, { type: "term_list", terminals: tm.list() });

    // Session list
    sendTo(ws, {
      type: "session_list",
      sessions: [].concat(Array.from(sm.sessions.values())).map(function (s) {
        return {
          id: s.localId,
          cliSessionId: s.cliSessionId || null,
          title: s.title || "New Session",
          active: s.localId === sm.activeSessionId,
          isProcessing: s.isProcessing,
          lastActivity: s.lastActivity || s.createdAt || 0,
        };
      }),
    });

    // Restore active session for this client
    var active = sm.getActiveSession();
    if (active) {
      sendTo(ws, { type: "session_switched", id: active.localId, cliSessionId: active.cliSessionId || null });

      var total = active.history.length;
      var fromIndex = 0;
      if (total > sm.HISTORY_PAGE_SIZE) {
        fromIndex = sm.findTurnBoundary(active.history, Math.max(0, total - sm.HISTORY_PAGE_SIZE));
      }
      sendTo(ws, { type: "history_meta", total: total, from: fromIndex });
      for (var i = fromIndex; i < total; i++) {
        sendTo(ws, active.history[i]);
      }

      if (active.isProcessing) {
        sendTo(ws, { type: "status", status: "processing" });
      }
      var pendingIds = Object.keys(active.pendingPermissions);
      for (var pi = 0; pi < pendingIds.length; pi++) {
        var p = active.pendingPermissions[pendingIds[pi]];
        sendTo(ws, {
          type: "permission_request_pending",
          requestId: p.requestId,
          toolName: p.toolName,
          toolInput: p.toolInput,
          toolUseId: p.toolUseId,
          decisionReason: p.decisionReason,
        });
      }
    }

    ws.on("message", function (raw) {
      var msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      handleMessage(ws, msg);
    });

    ws.on("close", function (code, reason) {
      log(slug, "ws close code=" + code + " reason=" + (reason || ""));
      handleDisconnection(ws);
    });

    ws.on("error", function (err) {
      log(slug, "ws error: " + err.message);
    });
  }

  // --- WS message handler ---
  function handleMessage(ws, msg) {
    if (msg.type === "load_more_history") {
      var session = sm.getActiveSession();
      if (!session || typeof msg.before !== "number") return;
      var before = msg.before;
      var from = sm.findTurnBoundary(session.history, Math.max(0, before - sm.HISTORY_PAGE_SIZE));
      var to = before;
      var items = session.history.slice(from, to);
      sendTo(ws, {
        type: "history_prepend",
        items: items,
        meta: { from: from, to: to, hasMore: from > 0 },
      });
      return;
    }

    if (msg.type === "new_session") {
      sm.createSession();
      return;
    }

    if (msg.type === "resume_session") {
      if (!msg.cliSessionId) return;
      sm.resumeSession(msg.cliSessionId);
      return;
    }

    if (msg.type === "switch_session") {
      if (msg.id && sm.sessions.has(msg.id)) {
        sm.switchSession(msg.id);
      }
      return;
    }

    if (msg.type === "delete_session") {
      if (msg.id && sm.sessions.has(msg.id)) {
        sm.deleteSession(msg.id);
      }
      return;
    }

    if (msg.type === "rename_session") {
      if (msg.id && sm.sessions.has(msg.id) && msg.title) {
        var s = sm.sessions.get(msg.id);
        s.title = String(msg.title).substring(0, 100);
        sm.saveSessionFile(s);
        sm.broadcastSessionList();
      }
      return;
    }

    if (msg.type === "search_sessions") {
      var results = sm.searchSessions(msg.query || "");
      sendTo(ws, { type: "search_results", query: msg.query || "", results: results });
      return;
    }

    if (msg.type === "check_update") {
      fetchLatestVersion().then(function (v) {
        if (v && isNewer(v, currentVersion)) {
          latestVersion = v;
          sendTo(ws, { type: "update_available", version: v });
        }
      }).catch(function () {});
      return;
    }

    if (msg.type === "stop") {
      var session = sm.getActiveSession();
      if (session && session.abortController && session.isProcessing) {
        session.abortController.abort();
      }
      return;
    }

    if (msg.type === "get_usage") {
      fetchUsageData().then(function (data) {
        sendTo(ws, { type: "usage_data", data: data });
      }).catch(function (err) {
        sendTo(ws, { type: "usage_data", error: err.message || "Failed to fetch usage data" });
      });
      return;
    }

    if (msg.type === "set_model" && msg.model) {
      var session = sm.getActiveSession();
      if (session) {
        sdk.setModel(session, msg.model);
      }
      return;
    }

    if (msg.type === "rewind_preview") {
      var session = sm.getActiveSession();
      if (!session || !session.cliSessionId || !msg.uuid) return;

      (async function () {
        var result;
        try {
          result = await sdk.getOrCreateRewindQuery(session);
          var preview = await result.query.rewindFiles(msg.uuid, { dryRun: true });
          var diffs = {};
          var changedFiles = preview.filesChanged || [];
          for (var f = 0; f < changedFiles.length; f++) {
            try {
              diffs[changedFiles[f]] = execFileSync(
                "git", ["diff", "HEAD", "--", changedFiles[f]],
                { cwd: cwd, encoding: "utf8", timeout: 5000 }
              ) || "";
            } catch (e) { diffs[changedFiles[f]] = ""; }
          }
          sendTo(ws, { type: "rewind_preview_result", preview: preview, diffs: diffs, uuid: msg.uuid });
        } catch (err) {
          sendTo(ws, { type: "rewind_error", text: "Failed to preview rewind: " + err.message });
        } finally {
          if (result && result.isTemp) result.cleanup();
        }
      })();
      return;
    }

    if (msg.type === "rewind_execute") {
      var session = sm.getActiveSession();
      if (!session || !session.cliSessionId || !msg.uuid) return;

      (async function () {
        var result;
        try {
          result = await sdk.getOrCreateRewindQuery(session);
          await result.query.rewindFiles(msg.uuid, { dryRun: false });

          var targetIdx = -1;
          for (var i = 0; i < session.messageUUIDs.length; i++) {
            if (session.messageUUIDs[i].uuid === msg.uuid) {
              targetIdx = i;
              break;
            }
          }

          if (targetIdx >= 0) {
            var trimTo = session.messageUUIDs[targetIdx].historyIndex;
            for (var k = trimTo - 1; k >= 0; k--) {
              if (session.history[k].type === "user_message") {
                trimTo = k;
                break;
              }
            }
            session.history = session.history.slice(0, trimTo);
            session.messageUUIDs = session.messageUUIDs.slice(0, targetIdx);
          }

          session.lastRewindUuid = msg.uuid;

          if (session.abortController) {
            try { session.abortController.abort(); } catch (e) {}
          }
          if (session.messageQueue) {
            try { session.messageQueue.end(); } catch (e) {}
          }
          session.queryInstance = null;
          session.messageQueue = null;
          session.abortController = null;
          session.blocks = {};
          session.sentToolResults = {};
          session.pendingPermissions = {};
          session.pendingAskUser = {};
          session.isProcessing = false;

          sm.saveSessionFile(session);
          sm.switchSession(session.localId);
          sm.sendAndRecord(session, { type: "rewind_complete" });
          sm.broadcastSessionList();
        } catch (err) {
          send({ type: "rewind_error", text: "Rewind failed: " + err.message });
        } finally {
          if (result && result.isTemp) result.cleanup();
        }
      })();
      return;
    }

    if (msg.type === "ask_user_response") {
      var session = sm.getActiveSession();
      if (!session) return;
      var toolId = msg.toolId;
      var answers = msg.answers || {};
      var pending = session.pendingAskUser[toolId];
      if (!pending) return;
      delete session.pendingAskUser[toolId];
      sm.sendAndRecord(session, { type: "ask_user_answered", toolId: toolId });
      pending.resolve({
        behavior: "allow",
        updatedInput: Object.assign({}, pending.input, { answers: answers }),
      });
      return;
    }

    if (msg.type === "input_sync") {
      sendToOthers(ws, msg);
      return;
    }

    if (msg.type === "permission_response") {
      var session = sm.getActiveSession();
      if (!session) return;
      var requestId = msg.requestId;
      var decision = msg.decision;
      var pending = session.pendingPermissions[requestId];
      if (!pending) return;
      delete session.pendingPermissions[requestId];

      if (decision === "allow" || decision === "allow_always") {
        if (decision === "allow_always") {
          if (!session.allowedTools) session.allowedTools = {};
          session.allowedTools[pending.toolName] = true;
        }
        pending.resolve({ behavior: "allow", updatedInput: pending.toolInput });
      } else {
        pending.resolve({ behavior: "deny", message: "User denied permission" });
      }

      sm.sendAndRecord(session, {
        type: "permission_resolved",
        requestId: requestId,
        decision: decision,
      });
      return;
    }

    // --- File browser ---
    if (msg.type === "fs_list") {
      var fsDir = safePath(cwd, msg.path || ".");
      if (!fsDir) {
        sendTo(ws, { type: "fs_list_result", path: msg.path, entries: [], error: "Access denied" });
        return;
      }
      try {
        var items = fs.readdirSync(fsDir, { withFileTypes: true });
        var entries = [];
        for (var fi = 0; fi < items.length; fi++) {
          var item = items[fi];
          if (item.isDirectory() && IGNORED_DIRS.has(item.name)) continue;
          entries.push({
            name: item.name,
            type: item.isDirectory() ? "dir" : "file",
            path: path.relative(cwd, path.join(fsDir, item.name)),
          });
        }
        sendTo(ws, { type: "fs_list_result", path: msg.path || ".", entries: entries });
      } catch (e) {
        sendTo(ws, { type: "fs_list_result", path: msg.path, entries: [], error: e.message });
      }
      return;
    }

    if (msg.type === "fs_read") {
      var fsFile = safePath(cwd, msg.path);
      if (!fsFile) {
        sendTo(ws, { type: "fs_read_result", path: msg.path, error: "Access denied" });
        return;
      }
      try {
        var stat = fs.statSync(fsFile);
        var ext = path.extname(fsFile).toLowerCase();
        if (stat.size > FS_MAX_SIZE) {
          sendTo(ws, { type: "fs_read_result", path: msg.path, binary: true, size: stat.size, error: "File too large (" + (stat.size / 1024 / 1024).toFixed(1) + " MB)" });
          return;
        }
        if (BINARY_EXTS.has(ext)) {
          var result = { type: "fs_read_result", path: msg.path, binary: true, size: stat.size };
          if (IMAGE_EXTS.has(ext)) result.imageUrl = "api/file?path=" + encodeURIComponent(msg.path);
          sendTo(ws, result);
          return;
        }
        var content = fs.readFileSync(fsFile, "utf8");
        sendTo(ws, { type: "fs_read_result", path: msg.path, content: content, size: stat.size });
      } catch (e) {
        sendTo(ws, { type: "fs_read_result", path: msg.path, error: e.message });
      }
      return;
    }

    // --- File watcher ---
    if (msg.type === "fs_watch") {
      if (msg.path) startFileWatch(msg.path);
      return;
    }

    if (msg.type === "fs_unwatch") {
      stopFileWatch();
      return;
    }

    // --- Web terminal ---
    if (msg.type === "term_create") {
      var t = tm.create(msg.cols || 80, msg.rows || 24);
      if (!t) {
        sendTo(ws, { type: "term_error", error: "Cannot create terminal (node-pty not available or limit reached)" });
        return;
      }
      tm.attach(t.id, ws);
      send({ type: "term_list", terminals: tm.list() });
      sendTo(ws, { type: "term_created", id: t.id });
      return;
    }

    if (msg.type === "term_attach") {
      if (msg.id) tm.attach(msg.id, ws);
      return;
    }

    if (msg.type === "term_detach") {
      if (msg.id) tm.detach(msg.id, ws);
      return;
    }

    if (msg.type === "term_input") {
      if (msg.id) tm.write(msg.id, msg.data);
      return;
    }

    if (msg.type === "term_resize") {
      if (msg.id && msg.cols > 0 && msg.rows > 0) {
        tm.resize(msg.id, msg.cols, msg.rows);
      }
      return;
    }

    if (msg.type === "term_close") {
      if (msg.id) {
        tm.close(msg.id);
        send({ type: "term_list", terminals: tm.list() });
      }
      return;
    }

    if (msg.type === "term_rename") {
      if (msg.id && msg.title) {
        tm.rename(msg.id, msg.title);
        send({ type: "term_list", terminals: tm.list() });
      }
      return;
    }

    if (msg.type !== "message") return;
    if (!msg.text && (!msg.images || msg.images.length === 0) && (!msg.pastes || msg.pastes.length === 0)) return;

    var session = sm.getActiveSession();
    if (!session) return;

    log(slug, "user message (" + ((msg.text || "").length) + " chars" + (msg.images && msg.images.length ? ", " + msg.images.length + " images" : "") + ")");

    var userMsg = { type: "user_message", text: msg.text || "" };
    if (msg.images && msg.images.length > 0) {
      userMsg.imageCount = msg.images.length;
    }
    if (msg.pastes && msg.pastes.length > 0) {
      userMsg.pastes = msg.pastes;
    }
    session.history.push(userMsg);
    sm.appendToSessionFile(session, userMsg);
    sendToOthers(ws, userMsg);

    if (!session.title) {
      session.title = (msg.text || "Image").substring(0, 50);
      sm.saveSessionFile(session);
      sm.broadcastSessionList();
    }

    var fullText = msg.text || "";
    if (msg.pastes && msg.pastes.length > 0) {
      for (var pi = 0; pi < msg.pastes.length; pi++) {
        if (fullText) fullText += "\n\n";
        fullText += msg.pastes[pi];
      }
    }

    if (!session.isProcessing) {
      session.isProcessing = true;
      session.sentToolResults = {};
      send({ type: "status", status: "processing" });
      if (!session.queryInstance) {
        sdk.startQuery(session, fullText, msg.images);
      } else {
        sdk.pushMessage(session, fullText, msg.images);
      }
    } else {
      sdk.pushMessage(session, fullText, msg.images);
    }
    sm.broadcastSessionList();
  }

  // --- WS disconnection handler ---
  function handleDisconnection(ws) {
    tm.detachAll(ws);
    clients.delete(ws);
    log(slug, "client disconnected (" + clients.size + " remaining)");
    if (clients.size === 0) stopFileWatch();
    broadcastClientCount();
  }

  // --- Handle project-scoped HTTP requests ---
  function handleHTTP(req, res, urlPath) {
    // Permission response (e.g. from external client)
    if (req.method === "POST" && urlPath === "/api/permission-response") {
      parseJsonBody(req).then(function (data) {
        var requestId = data.requestId;
        var decision = data.decision;
        if (!requestId || !decision) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"missing requestId or decision"}');
          return;
        }
        var found = false;
        sm.sessions.forEach(function (session) {
          var pending = session.pendingPermissions[requestId];
          if (!pending) return;
          found = true;
          delete session.pendingPermissions[requestId];
          if (decision === "allow") {
            pending.resolve({ behavior: "allow", updatedInput: pending.toolInput });
          } else {
            pending.resolve({ behavior: "deny", message: "Denied via push notification" });
          }
          sm.sendAndRecord(session, {
            type: "permission_resolved",
            requestId: requestId,
            decision: decision,
          });
        });
        if (found) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end('{"error":"permission request not found"}');
        }
      }).catch(function () {
        res.writeHead(400);
        res.end("Bad request");
      });
      return true;
    }

    // File browser: serve project images
    if (req.method === "GET" && urlPath.startsWith("/api/file?")) {
      var qIdx = urlPath.indexOf("?");
      var params = new URLSearchParams(urlPath.substring(qIdx));
      var reqFilePath = params.get("path");
      if (!reqFilePath) { res.writeHead(400); res.end("Missing path"); return true; }
      var absFile = safePath(cwd, reqFilePath);
      if (!absFile) { res.writeHead(403); res.end("Access denied"); return true; }
      var fileExt = path.extname(absFile).toLowerCase();
      if (!IMAGE_EXTS.has(fileExt)) { res.writeHead(403); res.end("Only image files"); return true; }
      try {
        var fileStat = fs.statSync(absFile);
        if (fileStat.size > 10 * 1024 * 1024) { res.writeHead(413); res.end("File too large"); return true; }
        var fileContent = fs.readFileSync(absFile);
        var fileMime = MIME_TYPES[fileExt] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": fileMime, "Cache-Control": "no-cache" });
        res.end(fileContent);
      } catch (e) {
        res.writeHead(404); res.end("Not found");
      }
      return true;
    }

    // Info endpoint
    if (req.method === "GET" && urlPath === "/info") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ project: project, slug: slug }));
      return true;
    }

    // --- Voice proxy routes ---
    if (req.method === "POST" && urlPath === "/api/stt") {
      log(slug + ":voice", "STT request");
      proxySTT(req, res);
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/tts") {
      log(slug + ":voice", "TTS request");
      proxyTTS(req, res);
      return true;
    }

    if (req.method === "GET" && urlPath === "/api/voice/status") {
      voiceStatus(res);
      return true;
    }

    // CLI session browser
    // # codex-ignore: HIGH-session-titles — users browse their own sessions via authenticated UI
    if (req.method === "GET" && urlPath === "/api/cli-sessions") {
      listCliSessions(cwd, sm, res);
      return true;
    }

    return false; // not handled
  }

  // --- Destroy ---
  function destroy() {
    stopFileWatch();
    // Abort all active sessions
    sm.sessions.forEach(function (session) {
      if (session.abortController) {
        try { session.abortController.abort(); } catch (e) {}
      }
      if (session.messageQueue) {
        try { session.messageQueue.end(); } catch (e) {}
      }
    });
    // Kill all terminals
    tm.destroyAll();
    for (var ws of clients) {
      try { ws.close(); } catch (e) {}
    }
    clients.clear();
  }

  // --- Status info ---
  function getStatus() {
    var sessionCount = sm.sessions.size;
    var hasProcessing = false;
    sm.sessions.forEach(function (s) {
      if (s.isProcessing) hasProcessing = true;
    });
    return {
      slug: slug,
      path: cwd,
      project: project,
      title: title,
      clients: clients.size,
      sessions: sessionCount,
      isProcessing: hasProcessing,
    };
  }

  function setTitle(newTitle) {
    title = newTitle || null;
    send({ type: "info", cwd: cwd, slug: slug, project: title || project, version: currentVersion, debug: !!debug, projectCount: getProjectCount(), projects: getProjectList() });
  }

  return {
    cwd: cwd,
    slug: slug,
    project: project,
    clients: clients,
    sm: sm,
    sdk: sdk,
    send: send,
    sendTo: sendTo,
    handleConnection: handleConnection,
    handleMessage: handleMessage,
    handleDisconnection: handleDisconnection,
    handleHTTP: handleHTTP,
    getStatus: getStatus,
    setTitle: setTitle,
    warmup: function () { sdk.warmup(); },
    destroy: destroy,
  };
}

var MAX_BODY_SIZE = 1024 * 1024; // 1MB

function parseJsonBody(req) {
  return new Promise(function (resolve, reject) {
    var body = "";
    var size = 0;
    req.on("data", function (chunk) {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      body += chunk;
    });
    req.on("end", function () {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
  });
}

// --- Voice proxy helpers ---

function collectRawBody(req, maxSize) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    var size = 0;
    req.on("data", function (chunk) {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error("Body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", function () {
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function proxySTT(req, res) {
  collectRawBody(req, VOICE_MAX_BODY).then(function (audioData) {
    var contentType = req.headers["content-type"] || "audio/webm";
    var ext = "webm";
    if (contentType.indexOf("ogg") >= 0) ext = "ogg";
    else if (contentType.indexOf("wav") >= 0) ext = "wav";
    else if (contentType.indexOf("mp4") >= 0) ext = "mp4";

    // Build multipart/form-data for OpenAI-compatible STT API
    var boundary = "----BraigiBoundary" + Date.now();
    var filePart = Buffer.concat([
      Buffer.from(
        "--" + boundary + "\r\n" +
        "Content-Disposition: form-data; name=\"file\"; filename=\"audio." + ext + "\"\r\n" +
        "Content-Type: " + contentType + "\r\n\r\n"
      ),
      audioData,
      Buffer.from("\r\n"),
    ]);
    var modelPart = Buffer.from(
      "--" + boundary + "\r\n" +
      "Content-Disposition: form-data; name=\"model\"\r\n\r\n" +
      STT_MODEL + "\r\n"
    );
    var closer = Buffer.from("--" + boundary + "--\r\n");
    var body = Buffer.concat([filePart, modelPart, closer]);

    var parsed = new URL(STT_URL);
    var options = {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: "/v1/audio/transcriptions",
      method: "POST",
      headers: {
        "Content-Type": "multipart/form-data; boundary=" + boundary,
        "Content-Length": body.length,
      },
      timeout: 30000,
    };

    var proxyReq = http.request(options, function (proxyRes) {
      var chunks = [];
      proxyRes.on("data", function (c) { chunks.push(c); });
      proxyRes.on("end", function () {
        var respBody = Buffer.concat(chunks).toString();
        res.writeHead(proxyRes.statusCode, { "Content-Type": "application/json" });
        res.end(respBody);
      });
    });

    proxyReq.on("error", function (err) {
      log("voice:stt", "backend error: " + err.message);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "STT backend unavailable: " + err.message }));
    });

    proxyReq.on("timeout", function () {
      log("voice:stt", "backend timeout");
      proxyReq.destroy();
      res.writeHead(504, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "STT backend timeout" }));
    });

    proxyReq.end(body);
  }).catch(function (err) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  });
}

function proxyTTS(req, res) {
  parseJsonBody(req).then(function (data) {
    var text = data.text;
    if (!text) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "missing text" }));
      return;
    }

    var payload = JSON.stringify({
      model: data.model || TTS_MODEL,
      voice: data.voice || TTS_VOICE,
      input: text,
    });

    var parsed = new URL(TTS_URL);
    var options = {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: "/v1/audio/speech",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      timeout: 30000,
    };

    var proxyReq = http.request(options, function (proxyRes) {
      res.writeHead(proxyRes.statusCode, {
        "Content-Type": proxyRes.headers["content-type"] || "audio/wav",
        "Transfer-Encoding": "chunked",
      });
      proxyRes.pipe(res);
    });

    proxyReq.on("error", function (err) {
      log("voice:tts", "backend error: " + err.message);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "TTS backend unavailable: " + err.message }));
    });

    proxyReq.on("timeout", function () {
      log("voice:tts", "backend timeout");
      proxyReq.destroy();
      res.writeHead(504, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "TTS backend timeout" }));
    });

    proxyReq.end(payload);
  }).catch(function (err) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  });
}

function checkEndpoint(url, cb) {
  var called = false;
  function done(ok) {
    if (called) return;
    called = true;
    cb(ok);
  }
  try {
    var parsed = new URL(url);
    var req = http.get({
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: "/v1/models",
      timeout: 3000,
    }, function (proxyRes) {
      proxyRes.resume();
      done(proxyRes.statusCode >= 200 && proxyRes.statusCode < 500);
    });
    req.on("error", function () { done(false); });
    req.on("timeout", function () { req.destroy(); done(false); });
  } catch (e) {
    done(false);
  }
}

var voiceStatusCache = null;
var voiceStatusCacheTime = 0;
var VOICE_STATUS_TTL = 30000; // 30 seconds

function voiceStatus(res) {
  var now = Date.now();
  if (voiceStatusCache && now - voiceStatusCacheTime < VOICE_STATUS_TTL) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(voiceStatusCache));
    return;
  }
  var result = { stt: false, tts: false };
  var pending = 2;
  function finish() {
    if (--pending === 0) {
      voiceStatusCache = result;
      voiceStatusCacheTime = Date.now();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    }
  }
  checkEndpoint(STT_URL, function (ok) { result.stt = ok; finish(); });
  checkEndpoint(TTS_URL, function (ok) { result.tts = ok; finish(); });
}

// --- CLI session browser ---

var cliSessionCache = {};       // keyed by projectKey
var CLI_CACHE_TTL = 30 * 1000;  // 30s

function cwdToProjectKey(cwd) {
  // Claude CLI convention: absolute path with slashes replaced by dashes
  return cwd.replace(/\//g, "-");
}

function extractFirstUserMessage(filePath) {
  return new Promise(function (resolve) {
    var title = null;
    var lineCount = 0;
    var stream;
    try {
      stream = fs.createReadStream(filePath, { encoding: "utf8" });
    } catch (e) {
      return resolve(null);
    }
    var rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", function (line) {
      lineCount++;
      if (lineCount > 50) {
        rl.close();
        stream.destroy();
        return;
      }
      if (!line.trim()) return;
      try {
        var obj = JSON.parse(line);
        if (obj.type === "user" && obj.message) {
          var content = obj.message.content;
          if (typeof content === "string") {
            title = content.substring(0, 80);
          } else if (Array.isArray(content)) {
            for (var i = 0; i < content.length; i++) {
              if (content[i].type === "text" && content[i].text) {
                title = content[i].text.substring(0, 80);
                break;
              }
            }
          }
          if (title) {
            rl.close();
            stream.destroy();
          }
        }
      } catch (e) {
        // skip malformed lines
      }
    });
    rl.on("close", function () {
      resolve(title);
    });
    rl.on("error", function () {
      resolve(null);
    });
  });
}

function listCliSessions(cwd, sm, res) {
  var projectKey = cwdToProjectKey(cwd);
  var cached = cliSessionCache[projectKey];
  if (cached && Date.now() - cached.ts < CLI_CACHE_TTL) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions: cached.data }));
    return;
  }

  var homeDir = os.homedir();
  var projectsDir = path.join(homeDir, ".claude", "projects", projectKey);

  var files;
  try {
    files = fs.readdirSync(projectsDir);
  } catch (e) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions: [] }));
    return;
  }

  var jsonlFiles = files.filter(function (f) { return f.endsWith(".jsonl"); });

  // Collect active CLI session IDs in Braigi
  var activeCli = new Set();
  sm.sessions.forEach(function (s) {
    if (s.cliSessionId) activeCli.add(s.cliSessionId);
  });

  var entries = [];
  for (var i = 0; i < jsonlFiles.length; i++) {
    var f = jsonlFiles[i];
    var sessionId = f.replace(/\.jsonl$/, "");
    var fullPath = path.join(projectsDir, f);
    try {
      var stat = fs.statSync(fullPath);
      entries.push({
        id: sessionId,
        filePath: fullPath,
        lastActivity: stat.mtimeMs,
        size: stat.size,
        active: activeCli.has(sessionId),
      });
    } catch (e) {
      // skip unreadable files
    }
  }

  // Sort by mtime descending and limit to 100
  entries.sort(function (a, b) { return b.lastActivity - a.lastActivity; });
  entries = entries.slice(0, 100);

  // Extract titles in parallel
  var pending = entries.length;
  if (pending === 0) {
    cliSessionCache[projectKey] = { ts: Date.now(), data: [] };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions: [] }));
    return;
  }

  var results = new Array(entries.length);
  for (var j = 0; j < entries.length; j++) {
    (function (idx) {
      extractFirstUserMessage(entries[idx].filePath).then(function (title) {
        results[idx] = {
          id: entries[idx].id,
          title: title || "Untitled session",
          lastActivity: entries[idx].lastActivity,
          size: entries[idx].size,
          active: entries[idx].active,
        };
        if (--pending === 0) {
          cliSessionCache[projectKey] = { ts: Date.now(), data: results };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ sessions: results }));
        }
      });
    })(j);
  }
}

module.exports = { createProjectContext: createProjectContext };
