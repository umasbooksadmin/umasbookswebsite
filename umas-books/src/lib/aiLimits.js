// Cost caps for the paid Anthropic API.
//
//  1. ONE daily cap for ALL AI features together (descriptions, French translations, genres, cover photos, price
//     checks): AI_DAILY_MAX_CALLS (default 600, Paris calendar day). Raise it in Render > Environment, see the runbook
//     section "AI limits". 0 switches every AI feature off.
//  2. The price check also has its own, lower cap: PRICING_AI_DAILY_MAX (default 150, lib/pricing/market.js).
//
// Both are ATOMIC: a call takes its slot with a single statement
//     INSERT ... ON CONFLICT DO UPDATE SET calls = calls + 1 WHERE calls < cap RETURNING calls
// on table ai_daily_cap (migration 089), so any number of concurrent requests (or instances) together can never use
// more slots than the cap. No slot is ever taken for a call that is not made (no API key, nothing to ask).
//
// At the cap the AI call is SKIPPED, not failed: the caller gets null exactly as for any other AI problem, so a book
// still saves (its description stays empty; Generate works again after midnight Paris time). The people see
// capMessage(). The first refused call of a day sends ONE email to ALERT_TO (alert_flags key 'ai-daily-cap').
//
// If the database cannot be reached, the process falls back to counting in memory (still capped, only per process
// and lost on restart) instead of letting calls through without any limit.
//
// This file also holds the length caps for what is sent to the AI (a title can be up to 100 KB in a request body).

const config = require("./config");
const { looseBaseUrl } = require("./baseUrl");
const { claimAlertSlot, releaseAlertSlot } = require("./alertFlags");
const { SITE_TIME_ZONE } = require("./tz");

const DEFAULT_DAILY_MAX = config.specFor("AI_DAILY_MAX_CALLS").default;
const ALERT_FLAG = "ai-daily-cap";
const MAX_TITLE = 200;
const MAX_AUTHOR = 200;
const MAX_DESCRIPTION = 2000;

// Control characters out, length capped. Never throws; non-strings become "".
function clampText(value, max) {
  return String(value == null ? "" : value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim().slice(0, max); // eslint-disable-line no-control-regex
}

function dailyMax(env = process.env) {
  return config.get("AI_DAILY_MAX_CALLS", env);
}

// The admin screens are English only; shown when one admin sends more than 10 AI requests a minute.
const AI_LIMIT_MESSAGE = "Too many AI requests: wait a minute and try again.";
const capMessage = (max) => `Daily AI limit reached (${max}). Resets at midnight Paris time.`;

const parisDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: SITE_TIME_ZONE });
// Whole minutes since the last Paris midnight (at least 1): "alert at most once since this midnight".
function minutesSinceParisMidnight(ms) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: SITE_TIME_ZONE, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return Math.max(1, get("hour") * 60 + get("minute"));
}

function alertText({ max, base }) {
  return (
    `The daily limit for the paid AI features (Anthropic) was reached today: ${max} calls.\n\n` +
    "Until midnight Paris time the AI helpers are paused:\n" +
    "  - book descriptions and their French translation\n  - genre suggestions\n  - reading a book from a cover photo\n  - the AI price check\n\n" +
    "Everything else keeps working: scanning by ISBN, saving books (a book saved meanwhile simply has no description; press Generate tomorrow), the till and reservations.\n\n" +
    "If this is a normal busy day and you want more room, raise the limit:\n" +
    "  1. Render dashboard > the umas-books web service > Environment.\n" +
    "  2. Edit (or add) the environment variable AI_DAILY_MAX_CALLS and set a higher number.\n" +
    "  3. Save: Render restarts the service by itself.\n" +
    "If you did not expect this many calls, check who is using the site: " + `${base}/admin/reports/lookup-sources\n\n` +
    "You get at most one of these emails a day."
  );
}

function createAiLimits({
  getPool = () => require("../db").pool,
  send = (m) => require("./errorAlert").sendAdminAlert(m),
  env = process.env,
  now = Date.now,
  log = (m) => console.warn(m),
} = {}) {
  const memory = new Map(); // fallback "day|scope" -> calls, only used while the database fails
  let hitDay = null; // Paris day on which this process refused a call
  let hitMax = 0;
  let alertedDay = null;
  let warned = false;

  const warnOnce = (err) => {
    if (warned) return;
    warned = true;
    try { log(`AI daily cap: database not reachable (${String((err && err.message) || err).slice(0, 120)}); counting in memory.`); } catch { /* ignore */ }
  };

  // -> true when a slot was taken. max <= 0 never takes one.
  async function claim(scope, max, pool) {
    if (!(max > 0)) return false;
    try {
      const { rowCount } = await (pool || getPool()).query(
        `INSERT INTO ai_daily_cap (day, scope, calls) VALUES ((now() AT TIME ZONE $1)::date, $2, 1)
         ON CONFLICT (day, scope) DO UPDATE SET calls = ai_daily_cap.calls + 1 WHERE ai_daily_cap.calls < $3
         RETURNING calls`,
        [SITE_TIME_ZONE, scope, max]
      );
      return rowCount === 1;
    } catch (err) {
      warnOnce(err);
      const key = `${parisDay(now())}|${scope}`;
      const n = memory.get(key) || 0;
      if (n >= max) return false;
      for (const k of memory.keys()) if (!k.startsWith(parisDay(now()))) memory.delete(k);
      memory.set(key, n + 1);
      return true;
    }
  }

  async function release(scope, pool) {
    try {
      await (pool || getPool()).query("UPDATE ai_daily_cap SET calls = calls - 1 WHERE day = (now() AT TIME ZONE $1)::date AND scope = $2 AND calls > 0", [SITE_TIME_ZONE, scope]);
    } catch {
      const key = `${parisDay(now())}|${scope}`;
      if (memory.get(key) > 0) memory.set(key, memory.get(key) - 1);
    }
  }

  function noteHit(max, pool) {
    hitDay = parisDay(now());
    hitMax = max;
    if (alertedDay === hitDay) return;
    alertedDay = hitDay;
    // Fire and forget: never in the way of a call or a save.
    Promise.resolve().then(async () => {
      pool = pool || getPool();
      if (!(await claimAlertSlot(pool, ALERT_FLAG, minutesSinceParisMidnight(now())))) return;
      const base = looseBaseUrl(env);
      const ok = await send({ subject: "[umas-books] Daily AI limit reached: the AI helpers are paused until midnight", text: alertText({ max, base }) });
      if (!ok) { await releaseAlertSlot(pool, ALERT_FLAG); alertedDay = null; } // the next refused call tries again
    }).catch((err) => { alertedDay = null; warnOnce(err); });
  }

  // One slot of the shared daily cap. -> { ok: true } | { ok: false, max, message }. Never throws.
  // opts (tests, and callers that already hold a pool): { pool, env }.
  async function acquireAiCall(opts = {}) {
    const max = dailyMax(opts.env || env);
    if (await claim("all", max, opts.pool)) return { ok: true };
    noteHit(max, opts.pool);
    return { ok: false, max, message: capMessage(max) };
  }

  // A price check: its own cap first, then the shared one (a slot taken in vain is given back).
  async function acquirePriceCall(priceMax, opts = {}) {
    if (!(await claim("price", priceMax, opts.pool))) return { ok: false, scope: "price", max: priceMax };
    const shared = await acquireAiCall(opts);
    if (!shared.ok) { await release("price", opts.pool); return { ...shared, scope: "all" }; }
    return { ok: true };
  }

  // Has the shared cap been used up today? -> { max, used, reached }. For the response messages and the report banner.
  async function status(opts = {}) {
    const max = dailyMax(opts.env || env);
    let used;
    try {
      const { rows } = await (opts.pool || getPool()).query("SELECT calls FROM ai_daily_cap WHERE scope = 'all' AND day = (now() AT TIME ZONE $1)::date", [SITE_TIME_ZONE]);
      used = rows.length ? rows[0].calls : 0;
    } catch { used = memory.get(`${parisDay(now())}|all`) || 0; }
    return { max, used, reached: used >= max, message: capMessage(max) };
  }

  // Cheap, no database: did THIS process refuse a call today? (for the scan lookup, which must stay fast)
  function reachedToday() {
    return hitDay === parisDay(now()) ? { reached: true, max: hitMax, message: capMessage(hitMax) } : { reached: false };
  }

  return { acquireAiCall, acquirePriceCall, status, reachedToday, claim, release };
}

let current = null;
const getAiLimits = () => current || (current = createAiLimits());
const setAiLimits = (l) => { current = l; };

// Daily rows older than 40 days are deleted (the daily job in index.js).
async function pruneAiDailyCap(pool) {
  const { rowCount } = await pool.query("DELETE FROM ai_daily_cap WHERE day < ((now() AT TIME ZONE $1)::date - 40)", [SITE_TIME_ZONE]);
  return rowCount;
}

module.exports = {
  AI_LIMIT_MESSAGE, createAiLimits, getAiLimits, setAiLimits, pruneAiDailyCap, clampText, dailyMax, capMessage, alertText, minutesSinceParisMidnight,
  DEFAULT_DAILY_MAX, ALERT_FLAG, MAX_TITLE, MAX_AUTHOR, MAX_DESCRIPTION,
};
