var http = require("http");
var fs = require("fs");
var path = require("path");
var { WebSocketServer } = require("ws");
var { dashboardPageHtml } = require("./pages");
var { createProjectContext } = require("./project");
var { log } = require("./log");

var publicDir = path.resolve(__dirname, "public");

var CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self' ws: wss:",
  "media-src 'self' blob:",
].join("; ");

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
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

function serveStatic(urlPath, res) {
  if (urlPath === "/") urlPath = "/index.html";

  var decodedPath;
  try { decodedPath = decodeURIComponent(urlPath); } catch (e) { return false; }
  var filePath = path.resolve(publicDir, "." + decodedPath);

  // Path boundary check — require path.sep to prevent prefix bypass
  if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) {
    res.writeHead(403);
    res.end("Forbidden");
    return true;
  }

  // Resolve symlinks and re-check boundary
  var realPath;
  try {
    realPath = fs.realpathSync(filePath);
  } catch (e) {
    return false;
  }
  if (realPath !== publicDir && !realPath.startsWith(publicDir + path.sep)) {
    res.writeHead(403);
    res.end("Forbidden");
    return true;
  }

  try {
    var content = fs.readFileSync(realPath);
    var ext = path.extname(realPath);
    var mime = MIME_TYPES[ext] || "application/octet-stream";
    // HTML and SW always revalidate; static assets cache for 1 hour
    var cacheControl = (ext === ".html" || urlPath === "/sw.js")
      ? "no-cache"
      : "public, max-age=3600";
    res.writeHead(200, { "Content-Type": mime + "; charset=utf-8", "Cache-Control": cacheControl });
    res.end(content);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Extract slug from URL path: /p/{slug}/... → slug
 * Returns null if path doesn't match /p/{slug}
 */
function extractSlug(urlPath) {
  var match = urlPath.match(/^\/p\/([a-z0-9_-]+)(\/|$)/);
  return match ? match[1] : null;
}

/**
 * Strip the /p/{slug} prefix from URL path
 */
function stripPrefix(urlPath, slug) {
  var prefix = "/p/" + slug;
  var rest = urlPath.substring(prefix.length);
  return rest || "/";
}

function readBody(req, limit, cb) {
  var chunks = [];
  var len = 0;
  var done = false;
  function finish(err, result) {
    if (done) return;
    done = true;
    cb(err, result);
  }
  req.on("data", function (chunk) {
    if (done) return;
    len += chunk.length;
    if (len > limit) { req.destroy(); finish(new Error("body too large")); return; }
    chunks.push(chunk);
  });
  req.on("end", function () { finish(null, Buffer.concat(chunks).toString("utf8")); });
  req.on("error", function (err) { finish(err); });
}

/**
 * Create a multi-project HTTP server.
 * Auth is handled externally (e.g., reverse proxy forward auth).
 * opts: { port, debug, host, onAddProject }
 */
function createServer(opts) {
  var portNum = opts.port || 27244;
  var debug = opts.debug || false;
  var bindHost = opts.host || process.env.BRAIGI_HOST || "0.0.0.0";

  var realVersion = require("../package.json").version;
  var currentVersion = debug ? "0.0.9" : realVersion;

  // --- Project registry ---
  var projects = new Map(); // slug → projectContext

  // --- HTTP handler ---
  var appHandler = function (req, res) {
    res.setHeader("Content-Security-Policy", CSP);
    var fullUrl = req.url.split("?")[0];

    // Root path — dashboard or redirect
    if (fullUrl === "/" && req.method === "GET") {
      if (projects.size === 1) {
        var slug = projects.keys().next().value;
        res.writeHead(302, { "Location": "/p/" + slug + "/" });
        res.end();
        return;
      }
      var statusList = [];
      projects.forEach(function (ctx) { statusList.push(ctx.getStatus()); });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(dashboardPageHtml(statusList, currentVersion));
      return;
    }

    // Global info endpoint
    if (req.method === "GET" && req.url === "/info") {
      var projectList = [];
      projects.forEach(function (ctx, slug) {
        projectList.push({ slug: slug, project: ctx.project });
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects: projectList, version: currentVersion }));
      return;
    }

    // Add project endpoint
    if (req.method === "POST" && req.url === "/api/projects") {
      var ct = (req.headers["content-type"] || "").split(";")[0].trim();
      if (ct !== "application/json") {
        res.writeHead(415, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Content-Type must be application/json" }));
        return;
      }
      if (!opts.onAddProject) {
        res.writeHead(501, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Project management not available" }));
        return;
      }
      readBody(req, 4096, function (err, body) {
        if (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Invalid request body" }));
          return;
        }
        var data;
        try { data = JSON.parse(body); } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
          return;
        }
        if (!data.path || typeof data.path !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Missing or invalid path" }));
          return;
        }
        var result = opts.onAddProject(data.path, data.title || null);
        if (!result.ok) {
          res.writeHead(result.status || 400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: result.error }));
          return;
        }
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, slug: result.slug, existing: result.existing || false }));
      });
      return;
    }

    // Static files at root (favicon, manifest, icons, sw.js, etc.)
    if (fullUrl.lastIndexOf("/") === 0 && !fullUrl.includes("..")) {
      if (serveStatic(fullUrl, res)) return;
    }

    // Project-scoped routes: /p/{slug}/...
    var slug = extractSlug(req.url.split("?")[0]);
    if (!slug) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    var ctx = projects.get(slug);
    if (!ctx) {
      res.writeHead(404);
      res.end("Project not found: " + slug);
      return;
    }

    // Redirect /p/{slug} → /p/{slug}/ (trailing slash required for relative paths)
    if (fullUrl === "/p/" + slug) {
      res.writeHead(301, { "Location": "/p/" + slug + "/" });
      res.end();
      return;
    }

    // Strip prefix for project-scoped handling
    var projectUrl = stripPrefix(req.url.split("?")[0], slug);
    // Re-attach query string for API routes
    var qsIdx = req.url.indexOf("?");
    var projectUrlWithQS = qsIdx >= 0 ? projectUrl + req.url.substring(qsIdx) : projectUrl;

    // Try project HTTP handler first (APIs)
    var origUrl = req.url;
    req.url = projectUrlWithQS;
    var handled = ctx.handleHTTP(req, res, projectUrlWithQS);
    req.url = origUrl;
    if (handled) return;

    // Static files (same assets for all projects)
    if (req.method === "GET") {
      if (serveStatic(projectUrl, res)) return;
    }

    res.writeHead(404);
    res.end("Not found");
  };

  // --- HTTP server (reverse proxy terminates TLS) ---
  var server = http.createServer(appHandler);

  // --- WebSocket ---
  var wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024, // 1MB
  });

  // 30s keepalive ping/pong
  var pingInterval = setInterval(function () {
    wss.clients.forEach(function (ws) {
      if (ws.isAlive === false) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on("connection", function (ws) {
    ws.isAlive = true;
    ws.on("pong", function () { ws.isAlive = true; });
  });

  // Extra allowed origins for WebSocket cross-origin access (configurable)
  var extraOrigins = new Set();
  if (opts.allowedOrigins) {
    opts.allowedOrigins.forEach(function (o) { extraOrigins.add(o); });
  }

  server.on("upgrade", function (req, socket, head) {
    // Origin validation: same-origin check prevents cross-site WebSocket hijacking
    // If Origin host matches Host header, it's same-origin (works for HTTP and HTTPS)
    var origin = req.headers.origin;
    if (origin) {
      var allowed = false;
      try {
        var originHost = new URL(origin).host;
        if (originHost === req.headers.host) allowed = true;
      } catch (e) {}
      if (!allowed && !extraOrigins.has(origin)) {
        log("ws", "origin rejected origin=" + origin + " ip=" + (req.headers["x-forwarded-for"] || req.socket.remoteAddress));
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
    } else {
      // Browsers always send Origin on WebSocket upgrades — missing Origin
      // means a non-browser client. Reject to prevent CSWSH attacks.
      log("ws", "rejected, missing origin ip=" + (req.headers["x-forwarded-for"] || req.socket.remoteAddress));
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    // Extract slug from WS URL: /p/{slug}/ws
    var wsSlug = extractSlug(req.url);
    if (!wsSlug) {
      log("ws", "rejected, no slug path=" + req.url);
      socket.destroy();
      return;
    }

    var ctx = projects.get(wsSlug);
    if (!ctx) {
      log("ws", "rejected, unknown slug=" + wsSlug);
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, function (ws) {
      wss.emit("connection", ws, req);
      log("ws", "connected slug=" + wsSlug + " ip=" + (req.headers["x-forwarded-for"] || req.socket.remoteAddress));
      ctx.handleConnection(ws);
    });
  });

  // --- Session transfer across projects ---
  function moveSessionToProject(sourceSlug, localId, targetSlug) {
    var sourceCtx = projects.get(sourceSlug);
    var targetCtx = projects.get(targetSlug);
    if (!sourceCtx) return { ok: false, error: "Source project not found" };
    if (!targetCtx) return { ok: false, error: "Target project not found" };
    if (sourceSlug === targetSlug) return { ok: false, error: "Already in this project" };

    // Step 1: Extract data without deleting source (safe read)
    var data = sourceCtx.getSessionData(localId);
    if (!data) return { ok: false, error: "Session not found, is processing, or has an active terminal" };

    // Step 2: Import into target — if this fails, source is untouched
    try {
      targetCtx.importSession(data);
    } catch (e) {
      return { ok: false, error: "Failed to import session: " + e.message };
    }

    // Step 3: Only now remove from source (import succeeded)
    sourceCtx.removeSession(localId);
    return { ok: true, targetSlug: targetSlug };
  }

  // --- Project management ---
  function addProject(cwd, slug, title) {
    if (projects.has(slug)) return false;
    var ctx = createProjectContext({
      cwd: cwd,
      slug: slug,
      title: title || null,
      debug: debug,
      currentVersion: currentVersion,
      getProjectCount: function () { return projects.size; },
      getProjectList: function () {
        var list = [];
        projects.forEach(function (ctx) { list.push(ctx.getStatus()); });
        return list;
      },
      moveSessionToProject: moveSessionToProject,
    });
    projects.set(slug, ctx);
    ctx.warmup();
    return true;
  }

  function removeProject(slug) {
    var ctx = projects.get(slug);
    if (!ctx) return false;
    ctx.destroy();
    projects.delete(slug);
    return true;
  }

  function getProjects() {
    var list = [];
    projects.forEach(function (ctx) {
      list.push(ctx.getStatus());
    });
    return list;
  }

  function setProjectTitle(slug, title) {
    var ctx = projects.get(slug);
    if (!ctx) return false;
    ctx.setTitle(title);
    return true;
  }

  function destroyAll() {
    clearInterval(pingInterval);
    projects.forEach(function (ctx) { ctx.destroy(); });
    projects.clear();
    wss.close();
  }

  return {
    server: server,
    bindHost: bindHost,
    addProject: addProject,
    removeProject: removeProject,
    getProjects: getProjects,
    setProjectTitle: setProjectTitle,
    destroyAll: destroyAll,
  };
}

module.exports = { createServer: createServer };
