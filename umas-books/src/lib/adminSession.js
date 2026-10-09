// Shorter sessions for people who can change the shop's books and money.
//
// Customers, members and volunteers keep the 30-day session (src/index.js).
// An ADMIN (users.is_admin) or a TILL account (users.is_till) additionally
// gets two limits, both enforced per request by enforceAdminSession below:
//   - IDLE: no request for ADMIN_SESSION_IDLE_HOURS (default 8) -> signed out.
//     8 hours covers a whole shop shift on the till.
//   - ABSOLUTE: ADMIN_SESSION_MAX_DAYS (default 7) since the login -> signed
//     out even if active.
// Two session fields drive it (both epoch ms, set at login):
//   adminLoginAt        when the privileged session began
//   adminLastActivity   last request seen, written at most every
//                       ACTIVITY_WRITE_EVERY_MS so the "no per-request session
//                       write" property (disableTouch in src/index.js) holds.
// Because lastActivity is only written every 5 minutes, a person is signed out
// after between 7h55 and 8h of silence, never later.
const { safeReturnTo } = require("./returnTo");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const DEFAULT_IDLE_HOURS = 8;
const DEFAULT_MAX_DAYS = 7;
const IDLE_HOURS_RANGE = [0.25, 72];
const MAX_DAYS_RANGE = [1, 30]; // the session cookie itself lasts 30 days
const ACTIVITY_WRITE_EVERY_MS = 5 * 60 * 1000;
const EXPIRED_NOTICE_PARAM = "expired";

function readNumber(env, name, fallback, [min, max], warnings) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < min || n > max) {
    warnings.push(`${name}=${JSON.stringify(raw)} is not a number between ${min} and ${max}; using the default (${fallback}).`);
    return fallback;
  }
  return n;
}

// Pure: { idleMs, maxMs, warnings }. Bad values are ignored with a warning.
function resolveAdminSessionConfig(env = process.env) {
  const warnings = [];
  const idleHours = readNumber(env, "ADMIN_SESSION_IDLE_HOURS", DEFAULT_IDLE_HOURS, IDLE_HOURS_RANGE, warnings);
  const maxDays = readNumber(env, "ADMIN_SESSION_MAX_DAYS", DEFAULT_MAX_DAYS, MAX_DAYS_RANGE, warnings);
  return { idleMs: idleHours * HOUR, maxMs: maxDays * DAY, warnings };
}

const isPrivileged = (user) => Boolean(user && (user.isAdmin || user.isTill));

// Pure decision. `session` is req.session (read), returns
//   { expired: false|"idle"|"max", set: { field: value } }
// where `set` is what the caller should write into the session (empty most of the time).
function evaluateAdminSession(session, now, cfg) {
  const user = session && session.user;
  if (!isPrivileged(user)) {
    // Demoted: forget the clocks so a later promotion starts fresh.
    return { expired: false, set: session && (session.adminLoginAt || session.adminLastActivity) ? { adminLoginAt: undefined, adminLastActivity: undefined } : {} };
  }
  const set = {};
  // Promoted mid-session (or a session from before this feature): the clocks start now.
  const loginAt = Number(session.adminLoginAt);
  if (!Number.isFinite(loginAt) || loginAt <= 0) set.adminLoginAt = now;
  const last = Number(session.adminLastActivity);
  const hasLast = Number.isFinite(last) && last > 0;
  if (!hasLast) set.adminLastActivity = now;
  if (!set.adminLoginAt && now - loginAt >= cfg.maxMs) return { expired: "max", set: {} };
  if (hasLast && now - last >= cfg.idleMs) return { expired: "idle", set: {} };
  if (hasLast && now - last >= ACTIVITY_WRITE_EVERY_MS) set.adminLastActivity = now;
  return { expired: false, set };
}

// Stamp a fresh login (called from loginAs).
function stampAdminLogin(session, user, now = Date.now()) {
  if (user.is_admin || user.is_till) {
    session.adminLoginAt = now;
    session.adminLastActivity = now;
  }
}

const JSON_PATHS = [/^\/admin\/till\//, /^\/admin\/inventory\/(lookup|price-suggestion)(\/|$)/];
// A fetch() from the till / scan pages (they send Accept: application/json and no text/html).
function wantsJson(req) {
  if (req.accepts && req.accepts(["html", "json"]) === "json") return true;
  const p = req.path || "";
  return req.method !== "GET" && JSON_PATHS.some((re) => re.test(p));
}

// Where to come back to after logging in again: the page that was requested
// (GET), or the page the form was on (POST; the Referer, same site only).
function returnToFor(req) {
  if (req.method === "GET" || req.method === "HEAD") return safeReturnTo(req.originalUrl);
  const ref = req.get && req.get("referer");
  if (!ref) return null;
  try {
    const u = new URL(ref);
    const host = req.get("host");
    if (host && u.host !== host) return null;
    return safeReturnTo(u.pathname + u.search);
  } catch {
    return null;
  }
}

function enforceAdminSession(cfg, now = Date.now) {
  return function (req, res, next) {
    if (!req.session) return next();
    const t = now();
    const verdict = evaluateAdminSession(req.session, t, cfg);
    if (!verdict.expired) {
      for (const [k, v] of Object.entries(verdict.set)) {
        if (v === undefined) delete req.session[k];
        else req.session[k] = v;
      }
      return next();
    }
    const target = returnToFor(req);
    const json = wantsJson(req);
    const finish = () => {
      res.clearCookie("umasbooks.sid", { path: "/" });
      if (json) {
        return res.status(401).set("Cache-Control", "no-store").json({
          error: "session_expired",
          reason: verdict.expired,
          message: "You were signed out after a period of inactivity. Please log in again.",
          loginUrl: "/login" + (target ? `?returnTo=${encodeURIComponent(target)}` : ""),
        });
      }
      const q = new URLSearchParams({ [EXPIRED_NOTICE_PARAM]: "1" });
      if (target) q.set("returnTo", target);
      res.set("Cache-Control", "no-store");
      return res.redirect(303, `/login?${q}`);
    };
    // After destroy(), express-session has already deleted req.session: respond now.
    req.session.destroy((err) => {
      if (err) console.error("Could not destroy expired admin session:", err.message);
      finish();
    });
  };
}

module.exports = {
  resolveAdminSessionConfig, evaluateAdminSession, stampAdminLogin, enforceAdminSession, wantsJson, returnToFor,
  ACTIVITY_WRITE_EVERY_MS, DEFAULT_IDLE_HOURS, DEFAULT_MAX_DAYS, EXPIRED_NOTICE_PARAM,
};
