// Minimal tagged logger for Braigi
// Format: ISO-timestamp [tag] message
function log(tag, msg) {
  console.log(new Date().toISOString() + " [" + tag + "] " + msg);
}

module.exports = { log: log };
