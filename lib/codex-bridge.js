var fs = require("fs");
var { log } = require("./log");

var CODEX_BIN = "/usr/local/bin/codex";
var DEFAULT_MODEL = "gpt-5.3-codex";
var MAX_RETRIES = 3;
var RETRY_DELAYS_MS = [1000, 2000, 4000];
var TURN_TIMEOUT_MS = 15 * 60 * 1000;

function createCodexBridge(opts) {
  var cwd = opts.cwd;
  var sm = opts.sessionManager;
  var send = opts.send;

  var sdkClientModule = null;
  var sdkStdioModule = null;
  var sdkImportPromise = null;

  var client = null;
  var transport = null;
  var connectingPromise = null;
  var connected = false;
  var runtimeAvailable = true;
  var shuttingDown = false;
  var cleanupInProgress = false;
  var retryCount = 0;
  var restartTimer = null;
  var reason = "Codex backend is idle";

  function sendAndRecord(session, obj) {
    sm.sendAndRecord(session, obj);
  }

  function errorMessage(err) {
    if (!err) return "unknown error";
    return err.message || String(err);
  }

  function hasCodexBinary() {
    try {
      fs.accessSync(CODEX_BIN, fs.constants.X_OK);
      return true;
    } catch (e) {
      return false;
    }
  }

  function hasMCPSDK() {
    try {
      require.resolve("@modelcontextprotocol/sdk/client/index.js");
      require.resolve("@modelcontextprotocol/sdk/client/stdio.js");
      return true;
    } catch (e) {
      return false;
    }
  }

  function getCurrentModel() {
    var session = sm.getActiveSession ? sm.getActiveSession() : null;
    if (session && session.codexModel) return session.codexModel;
    return DEFAULT_MODEL;
  }

  function clearRestartTimer() {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
  }

  function clearConnectionState(nextReason) {
    connected = false;
    client = null;
    transport = null;
    if (nextReason) {
      reason = nextReason;
    }
  }

  function parseResponseText(result) {
    if (!result) return "";
    if (Array.isArray(result.content)) {
      var parts = [];
      for (var i = 0; i < result.content.length; i++) {
        var block = result.content[i];
        if (block && block.type === "text" && typeof block.text === "string") {
          parts.push(block.text);
        }
      }
      if (parts.length > 0) {
        return parts.join("");
      }
    }
    if (result.structuredContent && typeof result.structuredContent.content === "string") {
      return result.structuredContent.content;
    }
    if (typeof result.content === "string") {
      return result.content;
    }
    return "";
  }

  function parseThreadId(result) {
    if (!result) return null;
    if (result.structuredContent && typeof result.structuredContent.threadId === "string") {
      return result.structuredContent.threadId;
    }
    if (typeof result.threadId === "string") {
      return result.threadId;
    }
    return null;
  }

  function failCodexSession(session, text, code) {
    if (!session || session.activeBackend !== "codex" || !session.isProcessing) return;
    session.isProcessing = false;
    session.codexAbortController = null;
    session.codexRequestId = (session.codexRequestId || 0) + 1;
    sendAndRecord(session, { type: "thinking_stop" });
    sendAndRecord(session, { type: "error", text: text });
    sendAndRecord(session, { type: "done", code: code == null ? 1 : code });
  }

  function failAllProcessingCodexSessions(text) {
    sm.sessions.forEach(function(session) {
      failCodexSession(session, text, 1);
    });
    sm.broadcastSessionList();
  }

  function loadMCPModules() {
    if (sdkClientModule && sdkStdioModule) {
      return Promise.resolve();
    }
    if (sdkImportPromise) {
      return sdkImportPromise;
    }
    sdkImportPromise = Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/client/stdio.js"),
    ]).then(function(modules) {
      sdkClientModule = modules[0];
      sdkStdioModule = modules[1];
    }).catch(function(err) {
      reason = "SDK import failed: " + errorMessage(err);
      throw err;
    }).finally(function() {
      sdkImportPromise = null;
    });
    return sdkImportPromise;
  }

  function scheduleRestart() {
    if (shuttingDown) return;
    if (restartTimer) return;
    if (retryCount >= MAX_RETRIES) {
      reason = "Codex MCP server restart failed after " + MAX_RETRIES + " attempts";
      log("codex", reason);
      send({ type: "error", text: reason });
      return;
    }

    var delay = RETRY_DELAYS_MS[retryCount] || RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
    retryCount++;
    reason = "Codex MCP server disconnected, retrying in " + delay + "ms";
    restartTimer = setTimeout(function() {
      restartTimer = null;
      ensureConnected(true).catch(function(err) {
        reason = "Codex reconnect failed: " + errorMessage(err);
        log("codex", reason);
        scheduleRestart();
      });
    }, delay);
  }

  function onTransportClose() {
    if (cleanupInProgress || shuttingDown) return;
    runtimeAvailable = false;
    clearConnectionState("Codex MCP server exited unexpectedly");
    log("codex", reason);
    send({ type: "error", text: "Codex backend disconnected." });
    failAllProcessingCodexSessions("Codex backend disconnected.");
    scheduleRestart();
  }

  function connectClient() {
    if (shuttingDown) {
      return Promise.reject(new Error("Codex bridge is shutting down"));
    }
    return loadMCPModules().then(function() {
      var Client = sdkClientModule.Client;
      var StdioClientTransport = sdkStdioModule.StdioClientTransport;

      var nextClient = new Client({
        name: "braigi-codex-bridge",
        version: "1.0.0",
      });
      var nextTransport = new StdioClientTransport({
        command: CODEX_BIN,
        args: [
          "mcp-server",
          "-c", "approval-policy=never",
          "-c", "sandbox=danger-full-access",
          "-c", "model=" + DEFAULT_MODEL,
        ],
        cwd: cwd,
        stderr: "pipe",
      });

      nextClient.onerror = function(err) {
        reason = "Codex client error: " + errorMessage(err);
        log("codex", reason);
      };
      nextTransport.onerror = function(err) {
        reason = "Codex transport error: " + errorMessage(err);
        log("codex", reason);
      };
      nextTransport.onclose = onTransportClose;

      if (nextTransport.stderr) {
        nextTransport.stderr.on("data", function(chunk) {
          var line = String(chunk || "").trim();
          if (line) {
            log("codex", "mcp-server stderr: " + line);
          }
        });
      }

      return nextClient.connect(nextTransport).then(function() {
        if (shuttingDown) {
          try { nextClient.close(); } catch (e) {}
          throw new Error("Codex bridge is shutting down");
        }
        client = nextClient;
        transport = nextTransport;
        connected = true;
        runtimeAvailable = true;
        retryCount = 0;
        reason = "Codex MCP connected";
      }).catch(function(err) {
        try { nextTransport.close(); } catch (e) {}
        throw err;
      });
    });
  }

  function ensureConnected(force) {
    if (shuttingDown) {
      return Promise.reject(new Error("Codex bridge is shut down"));
    }
    var availability = isAvailable();
    if (!availability.available && !force) {
      return Promise.reject(new Error(availability.reason));
    }
    if (connected && client) {
      return Promise.resolve();
    }
    clearRestartTimer();
    if (connectingPromise) {
      return connectingPromise;
    }
    connectingPromise = connectClient().catch(function(err) {
      runtimeAvailable = false;
      clearConnectionState("Codex connect failed: " + errorMessage(err));
      throw err;
    }).finally(function() {
      connectingPromise = null;
    });
    return connectingPromise;
  }

  function isAvailable() {
    if (!hasCodexBinary()) {
      return { available: false, reason: "codex binary not found at " + CODEX_BIN };
    }
    if (!hasMCPSDK()) {
      return { available: false, reason: "@modelcontextprotocol/sdk is not installed" };
    }
    if (!runtimeAvailable) {
      return { available: false, reason: reason || "Codex backend unavailable" };
    }
    if (reason && reason.indexOf("SDK import failed:") === 0) {
      return { available: false, reason: reason };
    }
    return { available: true, reason: connected ? "connected" : "ready" };
  }

  function getStatus() {
    var availability = isAvailable();
    return {
      available: availability.available,
      connected: connected,
      reason: availability.available ? reason : availability.reason,
      model: getCurrentModel(),
    };
  }

  function callCodex(session, text) {
    var startedAt = Date.now();
    var reqId = (session.codexRequestId || 0) + 1;
    var toolName = session.codexThreadId ? "codex-reply" : "codex";
    var toolArgs;
    if (session.codexThreadId) {
      toolArgs = {
        threadId: session.codexThreadId,
        conversationId: session.codexThreadId,
        prompt: text,
        message: text,
      };
    } else {
      toolArgs = {
        prompt: text,
        message: text,
        cwd: cwd,
        model: session.codexModel || DEFAULT_MODEL,
      };
    }

    session.codexRequestId = reqId;
    session.codexAbortController = new AbortController();
    sendAndRecord(session, { type: "thinking_start" });

    ensureConnected().then(function() {
      if (reqId !== session.codexRequestId) return null;
      return client.callTool(
        { name: toolName, arguments: toolArgs },
        undefined,
        {
          signal: session.codexAbortController.signal,
          timeout: TURN_TIMEOUT_MS,
          maxTotalTimeout: TURN_TIMEOUT_MS,
        }
      );
    }).then(function(result) {
      if (!result || reqId !== session.codexRequestId) return;

      if (result.isError) {
        throw new Error(parseResponseText(result) || "Codex MCP tool returned an error");
      }

      var threadId = parseThreadId(result);
      if (threadId) {
        session.codexThreadId = threadId;
      }

      var responseText = parseResponseText(result);
      if (responseText) {
        sendAndRecord(session, { type: "delta", text: responseText });
      }

      sendAndRecord(session, { type: "thinking_stop" });
      session.isProcessing = false;
      session.codexAbortController = null;
      sendAndRecord(session, {
        type: "result",
        cost: 0,
        duration: Date.now() - startedAt,
        usage: null,
        sessionId: null,
      });
      sendAndRecord(session, { type: "done", code: 0 });
      sm.saveSessionFile(session);
      sm.broadcastSessionList();
    }).catch(function(err) {
      if (reqId !== session.codexRequestId) return;
      var aborted = session.codexAbortController && session.codexAbortController.signal.aborted;
      session.isProcessing = false;
      session.codexAbortController = null;
      sendAndRecord(session, { type: "thinking_stop" });

      if (aborted || (err && err.name === "AbortError")) {
        sendAndRecord(session, { type: "info", text: "Interrupted \u00b7 What should Codex do instead?" });
        sendAndRecord(session, { type: "done", code: 0 });
      } else {
        var msg = errorMessage(err);
        log("codex", "query failed: " + msg);
        sendAndRecord(session, { type: "error", text: "Codex query failed: " + msg });
        sendAndRecord(session, { type: "done", code: 1 });
      }

      sm.broadcastSessionList();
    });
  }

  function startQuery(session, text) {
    if (!session) return;
    if (session.codexAbortController && !session.codexAbortController.signal.aborted) {
      sendAndRecord(session, { type: "error", text: "Codex is already processing. Stop the current query first." });
      return;
    }
    if (!session.isProcessing) {
      session.isProcessing = true;
      session.sentToolResults = {};
      send({ type: "status", status: "processing" });
    }
    callCodex(session, text || "");
  }

  function pushMessage(session, text) {
    startQuery(session, text);
  }

  function stop(session) {
    if (!session || !session.codexAbortController) return;
    try {
      session.codexAbortController.abort();
    } catch (e) {}
  }

  function cleanup() {
    shuttingDown = true;
    cleanupInProgress = true;
    runtimeAvailable = true;
    clearRestartTimer();

    sm.sessions.forEach(function(session) {
      if (session.codexAbortController) {
        try { session.codexAbortController.abort(); } catch (e) {}
      }
      session.codexAbortController = null;
    });

    var closePromise = null;
    if (client && typeof client.close === "function") {
      closePromise = client.close();
    } else if (transport && typeof transport.close === "function") {
      closePromise = transport.close();
    }

    clearConnectionState("Codex bridge stopped");
    retryCount = 0;

    if (closePromise && typeof closePromise.then === "function") {
      closePromise.catch(function(err) {
        log("codex", "cleanup error: " + errorMessage(err));
      });
    }
  }

  return {
    startQuery: startQuery,
    pushMessage: pushMessage,
    stop: stop,
    isAvailable: isAvailable,
    getStatus: getStatus,
    cleanup: cleanup,
  };
}

module.exports = { createCodexBridge: createCodexBridge };
