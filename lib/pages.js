function dashboardPageHtml(projects, version) {
  var cards = "";
  for (var i = 0; i < projects.length; i++) {
    var p = projects[i];
    var statusIcon = p.isProcessing ? "⚡" : (p.clients > 0 ? "🟢" : "⏸");
    var sessionLabel = p.sessions === 1 ? "1 session" : p.sessions + " sessions";
    var displayName = p.title || p.project;
    cards += '<a class="card" href="/p/' + p.slug + '/">' +
      '<div class="card-title">' + escapeHtml(displayName) + ' <span class="card-status">' + statusIcon + '</span></div>' +
      '<div class="card-path">' + escapeHtml(p.path) + '</div>' +
      '<div class="card-meta">' + sessionLabel + ' · ' + p.clients + ' client' + (p.clients !== 1 ? 's' : '') + '</div>' +
      '</a>';
  }
  if (projects.length === 0) {
    cards = '<div class="empty">No projects registered. Run <code>braigi</code> in a project directory to add one.</div>';
  }
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Braigi</title>' +
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">' +
    '<style>' +
    '*{margin:0;padding:0;box-sizing:border-box}' +
    'body{background:#2F2E2B;color:#E8E5DE;font-family:-apple-system,system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:40px 20px}' +
    'h1{font-size:24px;font-weight:600;margin-bottom:8px;color:#E8E5DE}' +
    '.subtitle{font-size:13px;color:#8B887F;margin-bottom:32px}' +
    '.cards{display:flex;flex-direction:column;gap:12px;width:100%;max-width:480px}' +
    '.card{display:block;background:#3A3936;border:1px solid #4A4845;border-radius:12px;padding:16px 20px;text-decoration:none;color:#E8E5DE;transition:border-color .15s,background .15s}' +
    '.card:hover{border-color:#DA7756;background:#3F3D3A}' +
    '.card-title{font-size:16px;font-weight:600;display:flex;align-items:center;gap:8px}' +
    '.card-status{font-size:14px}' +
    '.card-path{font-size:12px;color:#8B887F;margin-top:4px;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.card-meta{font-size:12px;color:#6B6862;margin-top:8px}' +
    '.empty{text-align:center;color:#6B6862;font-size:14px;padding:40px 20px}' +
    '.empty code{background:#3A3936;padding:2px 6px;border-radius:4px;font-size:13px;color:#DA7756}' +
    '.footer{margin-top:40px;font-size:11px;color:#4A4845}' +
    '</style></head><body>' +
    '<h1>Braigi</h1>' +
    '<div class="subtitle">Select a project</div>' +
    '<div class="cards">' + cards + '</div>' +
    '<div class="footer">v' + escapeHtml(version || "") + '</div>' +
    '</body></html>';
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

module.exports = { dashboardPageHtml, escapeHtml };
