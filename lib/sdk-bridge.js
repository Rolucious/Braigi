const crypto = require("crypto");
var { log } = require("./log");

// Async message queue for streaming input to SDK
var MAX_QUEUE_SIZE = 100;

function createMessageQueue() {
  var queue = [];
  var waiting = null;
  var ended = false;
  return {
    push: function(msg) {
      if (ended) return;
      if (waiting) {
        var resolve = waiting;
        waiting = null;
        resolve({ value: msg, done: false });
      } else {
        if (queue.length >= MAX_QUEUE_SIZE) {
          log("queue", "message queue overflow (" + queue.length + "), dropping oldest");
          queue.shift();
        }
        queue.push(msg);
      }
    },
    end: function() {
      ended = true;
      if (waiting) {
        var resolve = waiting;
        waiting = null;
        resolve({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator]: function() {
      return {
        next: function() {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift(), done: false });
          }
          if (ended) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise(function(resolve) {
            waiting = resolve;
          });
        },
      };
    },
  };
}

function createSDKBridge(opts) {
  var cwd = opts.cwd;
  var sm = opts.sessionManager;   // session manager instance
  var send = opts.send;           // broadcast to all clients
  var getSDK = opts.getSDK;

  function sendAndRecord(session, obj) {
    sm.sendAndRecord(session, obj);
  }

  function processSDKMessage(session, parsed) {
    // Extract session_id from any message that carries it
    if (parsed.session_id && !session.cliSessionId) {
      session.cliSessionId = parsed.session_id;
      sm.saveSessionFile(session);
      if (session.localId === sm.activeSessionId) {
        send({ type: "session_id", cliSessionId: session.cliSessionId });
      }
    } else if (parsed.session_id) {
      session.cliSessionId = parsed.session_id;
    }

    // Capture message UUIDs for rewind support
    if (parsed.uuid) {
      if (parsed.type === "user" && !parsed.parent_tool_use_id) {
        session.messageUUIDs.push({ uuid: parsed.uuid, type: "user", historyIndex: session.history.length });
        sendAndRecord(session, { type: "message_uuid", uuid: parsed.uuid, messageType: "user" });
      } else if (parsed.type === "assistant") {
        session.messageUUIDs.push({ uuid: parsed.uuid, type: "assistant", historyIndex: session.history.length });
        sendAndRecord(session, { type: "message_uuid", uuid: parsed.uuid, messageType: "assistant" });
      }
      // Cap messageUUIDs to prevent unbounded growth
      if (session.messageUUIDs.length > 5000) {
        session.messageUUIDs = session.messageUUIDs.slice(-5000);
      }
    }

    // Cache slash_commands and model from CLI init message
    if (parsed.type === "system" && parsed.subtype === "init") {
      if (parsed.skills) {
        sm.skillNames = new Set(parsed.skills);
      }
      if (parsed.slash_commands) {
        sm.slashCommands = parsed.slash_commands.filter(function(name) {
          return !sm.skillNames || !sm.skillNames.has(name);
        });
        send({ type: "slash_commands", commands: sm.slashCommands });
      }
      if (parsed.model) {
        sm.currentModel = parsed.model;
        send({ type: "model_info", model: parsed.model, models: sm.availableModels || [] });
      }
    }

    if (parsed.type === "stream_event" && parsed.event) {
      var evt = parsed.event;

      if (evt.type === "content_block_start") {
        var block = evt.content_block;
        var idx = evt.index;

        if (block.type === "tool_use") {
          session.blocks[idx] = { type: "tool_use", id: block.id, name: block.name, inputJson: "" };
          sendAndRecord(session, { type: "tool_start", id: block.id, name: block.name });
        } else if (block.type === "thinking") {
          session.blocks[idx] = { type: "thinking", thinkingText: "" };
          sendAndRecord(session, { type: "thinking_start" });
        } else if (block.type === "text") {
          session.blocks[idx] = { type: "text" };
        }
      }

      if (evt.type === "content_block_delta" && evt.delta) {
        var idx = evt.index;

        if (evt.delta.type === "text_delta" && typeof evt.delta.text === "string") {
          session.streamedText = true;
          if (session.responsePreview.length < 200) {
            session.responsePreview += evt.delta.text;
          }
          sendAndRecord(session, { type: "delta", text: evt.delta.text });
        } else if (evt.delta.type === "input_json_delta" && session.blocks[idx]) {
          session.blocks[idx].inputJson += evt.delta.partial_json;
        } else if (evt.delta.type === "thinking_delta" && session.blocks[idx]) {
          session.blocks[idx].thinkingText += evt.delta.thinking;
          sendAndRecord(session, { type: "thinking_delta", text: evt.delta.thinking });
        }
      }

      if (evt.type === "content_block_stop") {
        var idx = evt.index;
        var block = session.blocks[idx];

        if (block && block.type === "tool_use") {
          var input = {};
          try { input = JSON.parse(block.inputJson); } catch {}
          sendAndRecord(session, { type: "tool_executing", id: block.id, name: block.name, input: input });
        } else if (block && block.type === "thinking") {
          sendAndRecord(session, { type: "thinking_stop" });
        }

        delete session.blocks[idx];
      }

    } else if ((parsed.type === "assistant" || parsed.type === "user") && parsed.message && parsed.message.content) {
      var content = parsed.message.content;

      // Fallback: if assistant text wasn't streamed via deltas, send it now
      if (parsed.type === "assistant" && !session.streamedText && Array.isArray(content)) {
        var assistantText = content
          .filter(function(c) { return c.type === "text"; })
          .map(function(c) { return c.text; })
          .join("");
        if (assistantText) {
          sendAndRecord(session, { type: "delta", text: assistantText });
        }
      }

      // Check for local slash command output in user messages
      if (parsed.type === "user") {
        var fullText = "";
        if (typeof content === "string") {
          fullText = content;
        } else if (Array.isArray(content)) {
          fullText = content
            .filter(function(c) { return c.type === "text"; })
            .map(function(c) { return c.text; })
            .join("\n");
        }
        if (fullText.indexOf("local-command-stdout") !== -1) {
          var m = fullText.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
          if (m) {
            sendAndRecord(session, { type: "slash_command_result", text: m[1].trim() });
          }
        }
      }

      if (Array.isArray(content)) {
        for (var i = 0; i < content.length; i++) {
          var block = content[i];
          if (block.type === "tool_result" && !session.sentToolResults[block.tool_use_id]) {
            var resultText = "";
            if (typeof block.content === "string") {
              resultText = block.content;
            } else if (Array.isArray(block.content)) {
              resultText = block.content
                .filter(function(c) { return c.type === "text"; })
                .map(function(c) { return c.text; })
                .join("\n");
            }
            session.sentToolResults[block.tool_use_id] = true;
            sendAndRecord(session, {
              type: "tool_result",
              id: block.tool_use_id,
              content: resultText,
              is_error: block.is_error || false,
            });
          }
        }
      }

    } else if (parsed.type === "result") {
      log("sdk", "query complete cost=$" + (parsed.total_cost_usd || 0).toFixed(4) + " duration=" + (parsed.duration_ms || 0) + "ms");
      session.blocks = {};
      session.sentToolResults = {};
      session.pendingPermissions = {};
      session.pendingAskUser = {};
      session.isProcessing = false;
      sendAndRecord(session, {
        type: "result",
        cost: parsed.total_cost_usd,
        duration: parsed.duration_ms,
        usage: parsed.usage || null,
        sessionId: parsed.session_id,
      });
      sendAndRecord(session, { type: "done", code: 0 });
      // Reset for next turn in the same query
      session.responsePreview = "";
      session.streamedText = false;
      sm.broadcastSessionList();

    } else if (parsed.type === "system" && parsed.subtype === "status") {
      if (parsed.status === "compacting") {
        sendAndRecord(session, { type: "compacting", active: true });
      } else if (session.compacting) {
        sendAndRecord(session, { type: "compacting", active: false });
      }
      session.compacting = parsed.status === "compacting";

    } else if (parsed.type && parsed.type !== "system" && parsed.type !== "user") {
    }
  }

  // --- SDK query lifecycle ---

  function handleCanUseTool(session, toolName, input, opts) {
    // AskUserQuestion: wait for user answers via WebSocket (5-min timeout)
    if (toolName === "AskUserQuestion") {
      return new Promise(function(resolve) {
        var resolved = false;
        function doResolve(val) {
          if (resolved) return;
          resolved = true;
          clearTimeout(askTimer);
          resolve(val);
        }
        var askTimer = setTimeout(function() {
          delete session.pendingAskUser[opts.toolUseID];
          doResolve({ behavior: "deny", message: "Question timed out" });
        }, 300000);
        session.pendingAskUser[opts.toolUseID] = {
          resolve: doResolve,
          input: input,
        };
        if (opts.signal) {
          opts.signal.addEventListener("abort", function() {
            delete session.pendingAskUser[opts.toolUseID];
            doResolve({ behavior: "deny", message: "Cancelled" });
          });
        }
      });
    }

    // Auto-approve if tool was previously allowed for session
    if (session.allowedTools && session.allowedTools[toolName]) {
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }

    // Regular tool permission request: send to client and wait (5-min timeout)
    log("sdk", "permission requested: " + toolName);
    return new Promise(function(resolve) {
      var resolved = false;
      function doResolve(val) {
        if (resolved) return;
        resolved = true;
        clearTimeout(permTimer);
        resolve(val);
      }

      var requestId = crypto.randomUUID();

      var permTimer = setTimeout(function() {
        delete session.pendingPermissions[requestId];
        sendAndRecord(session, { type: "permission_cancel", requestId: requestId });
        doResolve({ behavior: "deny", message: "Permission request timed out" });
      }, 300000);

      session.pendingPermissions[requestId] = {
        resolve: doResolve,
        requestId: requestId,
        toolName: toolName,
        toolInput: input,
        toolUseId: opts.toolUseID,
        decisionReason: opts.decisionReason || "",
      };

      var permMsg = {
        type: "permission_request",
        requestId: requestId,
        toolName: toolName,
        toolInput: input,
        toolUseId: opts.toolUseID,
        decisionReason: opts.decisionReason || "",
      };
      sendAndRecord(session, permMsg);

      if (opts.signal) {
        opts.signal.addEventListener("abort", function() {
          delete session.pendingPermissions[requestId];
          sendAndRecord(session, { type: "permission_cancel", requestId: requestId });
          doResolve({ behavior: "deny", message: "Request cancelled" });
        });
      }
    });
  }

  async function processQueryStream(session) {
    try {
      for await (var msg of session.queryInstance) {
        processSDKMessage(session, msg);
      }
    } catch (err) {
      if (session.isProcessing) {
        session.isProcessing = false;
        if (err.name === "AbortError" || (session.abortController && session.abortController.signal.aborted)) {
          log("sdk", "query interrupted");
          sendAndRecord(session, { type: "info", text: "Interrupted \u00b7 What should Claude do instead?" });
          sendAndRecord(session, { type: "done", code: 0 });
        } else {
          log("sdk", "query error: " + err.message);
          sendAndRecord(session, { type: "error", text: "Claude process error: " + err.message });
          sendAndRecord(session, { type: "done", code: 1 });
        }
        sm.broadcastSessionList();
      }
    } finally {
      session.queryInstance = null;
      session.messageQueue = null;
      session.abortController = null;
    }
  }

  async function getOrCreateRewindQuery(session) {
    if (session.queryInstance) return { query: session.queryInstance, isTemp: false, cleanup: function() {} };

    var sdk;
    try {
      sdk = await getSDK();
    } catch (e) {
      send({ type: "error", text: "Failed to load Claude SDK: " + (e.message || e) });
      throw e;
    }
    var mq = createMessageQueue();

    var tempQuery = sdk.query({
      prompt: mq,
      options: {
        cwd: cwd,
        settingSources: ["user", "project", "local"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        enableFileCheckpointing: true,
        resume: session.cliSessionId,
      },
    });

    // Drain messages in background (stream stays alive until mq.end())
    (async function() {
      try { for await (var msg of tempQuery) {} } catch(e) {}
    })();

    return {
      query: tempQuery,
      isTemp: true,
      cleanup: function() { try { mq.end(); } catch(e) {} },
    };
  }

  async function startQuery(session, text, images) {
    var sdk;
    try {
      sdk = await getSDK();
    } catch (e) {
      send({ type: "error", text: "Failed to load Claude SDK: " + (e.message || e) });
      return;
    }

    session.messageQueue = createMessageQueue();
    session.blocks = {};
    session.sentToolResults = {};
    session.streamedText = false;
    session.responsePreview = "";

    // Build initial user message
    var content = [];
    if (images && images.length > 0) {
      for (var i = 0; i < images.length; i++) {
        content.push({
          type: "image",
          source: { type: "base64", media_type: images[i].mediaType, data: images[i].data },
        });
      }
    }
    if (text) {
      content.push({ type: "text", text: text });
    }

    session.messageQueue.push({
      type: "user",
      message: { role: "user", content: content },
    });

    session.abortController = new AbortController();
    log("sdk", "query " + (session.cliSessionId ? "resumed" : "started") + " cwd=" + cwd);

    var queryOptions = {
      cwd: cwd,
      settingSources: ["user", "project", "local"],
      includePartialMessages: true,
      enableFileCheckpointing: true,
      permissionMode: "bypassPermissions", // # codex-ignore: CRITICAL-bypass-permissions — user requires full server access, same as root terminal
      allowDangerouslySkipPermissions: true,
      extraArgs: { "replay-user-messages": null },
      abortController: session.abortController,
      canUseTool: function(toolName, input, toolOpts) {
        return handleCanUseTool(session, toolName, input, toolOpts);
      },
    };

    if (session.cliSessionId) {
      queryOptions.resume = session.cliSessionId;
      if (session.lastRewindUuid) {
        queryOptions.resumeSessionAt = session.lastRewindUuid;
        delete session.lastRewindUuid;
      }
    }

    session.queryInstance = sdk.query({
      prompt: session.messageQueue,
      options: queryOptions,
    });

    processQueryStream(session).catch(function(err) {
    });
  }

  function pushMessage(session, text, images) {
    if (!session.messageQueue) {
      startQuery(session, text, images);
      return;
    }
    var content = [];
    if (images && images.length > 0) {
      for (var i = 0; i < images.length; i++) {
        content.push({
          type: "image",
          source: { type: "base64", media_type: images[i].mediaType, data: images[i].data },
        });
      }
    }
    if (text) {
      content.push({ type: "text", text: text });
    }
    session.messageQueue.push({
      type: "user",
      message: { role: "user", content: content },
    });
  }

  // SDK warmup: grab slash_commands, model, and available models from SDK init
  async function warmup() {
    log("sdk", "warming up...");
    var ac = new AbortController();
    var timer = setTimeout(function() { ac.abort(); }, 30000);
    try {
      var sdk = await getSDK();
      var mq = createMessageQueue();
      mq.push({ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
      mq.end();
      var stream = sdk.query({
        prompt: mq,
        options: { cwd: cwd, settingSources: ["user", "project", "local"], permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, abortController: ac },
      });
      for await (var msg of stream) {
        if (msg.type === "system" && msg.subtype === "init") {
          if (msg.skills) {
            sm.skillNames = new Set(msg.skills);
          }
          if (msg.slash_commands) {
            sm.slashCommands = msg.slash_commands.filter(function(name) {
              return !sm.skillNames || !sm.skillNames.has(name);
            });
            send({ type: "slash_commands", commands: sm.slashCommands });
          }
          if (msg.model) {
            sm.currentModel = msg.model;
          }
          try {
            var models = await stream.supportedModels();
            sm.availableModels = models || [];
          } catch (e) {}
          send({ type: "model_info", model: sm.currentModel || "", models: sm.availableModels || [] });
          log("sdk", "warmup complete model=" + (sm.currentModel || "unknown"));
          ac.abort();
          break;
        }
      }
    } catch (e) {
      if (e && e.name !== "AbortError" && !(e.message && e.message.indexOf("aborted") !== -1)) {
        log("sdk", "warmup failed: " + (e.message || e));
        send({ type: "error", text: "Failed to load Claude SDK: " + (e.message || e) });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async function setModel(session, model) {
    if (!session.queryInstance) return;
    try {
      await session.queryInstance.setModel(model);
      log("sdk", "model changed to " + model);
      sm.currentModel = model;
      send({ type: "model_info", model: model, models: sm.availableModels || [] });
    } catch (e) {
      log("sdk", "model change failed: " + (e.message || e));
      send({ type: "error", text: "Failed to switch model: " + (e.message || e) });
    }
  }

  return {
    createMessageQueue: createMessageQueue,
    processSDKMessage: processSDKMessage,
    handleCanUseTool: handleCanUseTool,
    processQueryStream: processQueryStream,
    getOrCreateRewindQuery: getOrCreateRewindQuery,
    startQuery: startQuery,
    pushMessage: pushMessage,
    setModel: setModel,
    warmup: warmup,
  };
}

module.exports = { createSDKBridge, createMessageQueue };
