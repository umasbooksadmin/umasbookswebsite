// The app's last-resort Express error handler (mounted at the bottom of
// src/index.js), kept in its own module so it can be tested directly.
const { alertOnError } = require("./errorAlert");

// Friendly text for the client errors that can reach the handler.
const CLIENT_ERROR_MESSAGES = {
  400: "That request couldn't be understood. Please go back and try again.",
  403: "You don't have permission to do that.",
  404: "Page not found.",
  413: "That file or request is too large. Please choose a smaller file and try again.",
  415: "That type of file isn't supported.",
};

// Path-only, safe to log or email: reset/verification/order tokens travel
// in the URL (/reset-password/<token>, /verify-email/<token>,
// /cart/return?order=<token>), so the query string is dropped entirely and
// any path segment that looks like a token is replaced. A segment counts as
// a token if it follows a known token-bearing route or is long and
// opaque (20+ chars of hex/base64url).
const TOKEN_ROUTES = new Set(["reset-password", "verify-email"]);
function redactedPath(req) {
  const full = String(req.originalUrl || req.url || "");
  const pathOnly = full.split("?")[0].split("#")[0];
  const parts = pathOnly.split("/");
  for (let i = 1; i < parts.length; i++) {
    if ((i > 1 && TOKEN_ROUTES.has(parts[i - 1])) || /^[A-Za-z0-9_-]{20,}$/.test(parts[i])) {
      parts[i] = ":token";
    }
  }
  const out = parts.join("/");
  return out.length > 200 ? `${out.slice(0, 200)}...` : out;
}

// err.status/err.statusCode in 4xx (body-parser, multer's 413, a malformed
// URI's 400...) is the visitor's problem, not a server fault: respond with
// that status and a friendly message and send NO alert (an anonymous
// visitor could otherwise burn the alert throttle at will). Anything else
// is a 500 and alerts, with the subject carrying only method + redacted path.
function errorHandler(err, req, res, next) {
  let raw = Number(err && (err.status || err.statusCode));
  // MulterError carries no status of its own, only a code: too-big is a
  // 413, any other multer limit (unexpected field, too many files...) a 400.
  if (!raw && err && err.name === "MulterError") raw = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
  const clientStatus = Number.isInteger(raw) && raw >= 400 && raw < 500 ? raw : null;
  const where = `${req.method} ${redactedPath(req)}`;

  if (clientStatus) {
    console.warn(`Client error ${clientStatus} on ${where}: ${err.message}`);
  } else {
    console.error(`Unhandled error on ${where}:`, err);
    alertOnError(`Error on ${where}`, err);
  }
  if (res.headersSent) return next(err);

  const status = clientStatus || 500;
  res.status(status);
  const message = clientStatus
    ? CLIENT_ERROR_MESSAGES[clientStatus] || "That request couldn't be processed."
    : "Something went wrong. Please try again.";
  if (clientStatus) {
    return res.render("error", { status, message }, (renderErr, html) => {
      if (renderErr) return res.type("text").send(message);
      res.send(html);
    });
  }
  res.render("500", (renderErr, html) => {
    if (renderErr) return res.type("text").send(message);
    res.send(html);
  });
}

module.exports = { errorHandler, redactedPath };
