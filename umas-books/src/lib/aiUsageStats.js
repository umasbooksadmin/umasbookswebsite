// Counts of what the site asks the Anthropic API (report /admin/reports/lookup-sources, section "AI usage").
//
// COUNTS ONLY: never a prompt, a title, an ISBN, a text, a photo or a user. recordCall() adds to an in-memory total
// for (Paris day, feature); flush() writes the totals to ai_usage_stats with upsert increments, about every 30 s
// (start()) and at shutdown (stop()). Same contract as lookupStats.js: recording is synchronous, never throws and
// never waits on the database; a failed flush is swallowed (logged once) and the counts are kept for the next try.
//
// Outcomes are exclusive: calls = ok + errors + limited + credit_errors.
//   ok            the API answered 2xx
//   limited       HTTP 429 (rate limit)
//   credit_errors "credit balance too low" / billing (HTTP 400 or 402, error text mentions the credit balance, or
//                 error.type is "billing_error")
//   errors        everything else: other HTTP errors, timeouts, no connection

const { SITE_TIME_ZONE } = require("./tz");

// ---- PRICES: read from lib/anthropicModels.js (ONE place to edit models and prices). -----------------------------
// ESTIMATE ONLY (see the note there). Not priced (so the estimate is a floor, not the bill): cache tokens (the site does
// not use prompt caching, so they are normally 0) and web searches (the price-check feature uses the web search tool,
// which Anthropic bills per search on top of the tokens: see the invoice at console.anthropic.com). An unknown model is
// not estimated.
const { MODELS, PRICES_UPDATED } = require("./anthropicModels");

const AI_PRICES = {
  updated: PRICES_UPDATED,
  usdPerMTok: Object.fromEntries(Object.values(MODELS).map((m) => [m.id, { ...m.usdPerMTok }])),
  // The model the estimate assumes for every feature (the text model; PRICING_AI_MODEL can override the price check:
  // then its estimate is wrong, the page says so).
  assumedModel: MODELS.text.id,
};

const FEATURES = ["description", "translation", "genre", "cover", "price"];
const COUNTERS = ["calls", "ok", "errors", "limited", "credit_errors", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "web_searches", "duration_ms_sum", "duration_n"];
const BIGINTS = new Set(["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "duration_ms_sum"]);
const MAX_KEYS = 200;
const RETENTION_MONTHS = 36;

const parisDay = (ms = Date.now()) => new Date(ms).toLocaleDateString("en-CA", { timeZone: SITE_TIME_ZONE });

// Is this an "Anthropic credit is out" answer? Looks at the status and the error body text, never at anything else.
// Anthropic answers e.g. HTTP 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit
// balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}
function isCreditError(status, bodyText) {
  const text = String(bodyText || "");
  let type = "";
  let message = "";
  try {
    const j = JSON.parse(text);
    const e = j && (j.error || j);
    type = String((e && e.type) || "");
    message = String((e && e.message) || "");
  } catch { /* not JSON: look at the raw text */ }
  if (type === "billing_error") return true;
  if (status !== 400 && status !== 402) return false;
  return /credit balance/i.test(`${message} ${text}`);
}

const nonNeg = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);

// Token counts from a response body (`usage` field). Input = input_tokens (the API reports cache tokens apart).
function extractUsage(data) {
  const u = (data && typeof data === "object" && data.usage) || {};
  const st = u.server_tool_use || {};
  return {
    input_tokens: nonNeg(u.input_tokens),
    output_tokens: nonNeg(u.output_tokens),
    cache_read_tokens: nonNeg(u.cache_read_input_tokens),
    cache_write_tokens: nonNeg(u.cache_creation_input_tokens),
    web_searches: nonNeg(st.web_search_requests),
  };
}

// `alert` ({ creditOutOf(), creditWorking() }, lib/aiCreditAlert.js) is told about credit errors and successes, to email
// the admin once when the credit runs out; none by default (tests), the process-wide recorder passes the real one.
function createAiUsageStats({ getPool = () => require("../db").pool, flushMs = 30 * 1000, now = Date.now, log = (m) => console.warn(m), alert = null } = {}) {
  let totals = new Map(); // "day|feature" -> { day, feature, ...counters, last_credit_error_at }
  let timer = null;
  let flushing = null;
  let warned = false;

  const add = (target, day, feature, delta) => {
    const key = `${day}|${feature}`;
    let row = target.get(key);
    if (!row) {
      row = { day, feature, last_credit_error_at: null };
      for (const c of COUNTERS) row[c] = 0;
      target.set(key, row);
    }
    for (const c of COUNTERS) if (delta[c]) row[c] += delta[c];
    if (delta.last_credit_error_at && (!row.last_credit_error_at || delta.last_credit_error_at > row.last_credit_error_at)) row.last_credit_error_at = delta.last_credit_error_at;
  };

  // One finished call. outcome input: { status, bodyText, data, ms, failed }.
  //   - a 2xx answer: { status: 200, data: <parsed body>, ms }
  //   - an HTTP error: { status, bodyText, ms }
  //   - no answer at all (timeout, no connection, unreadable body): { failed: true, ms }
  function recordCall(feature, outcome = {}) {
    try {
      if (!FEATURES.includes(feature)) return;
      const { status, bodyText, data, ms } = outcome;
      const d = { calls: 1 };
      if (Number.isFinite(ms) && ms >= 0) { d.duration_ms_sum = Math.round(ms); d.duration_n = 1; }
      if (outcome.failed || !Number.isFinite(status)) d.errors = 1;
      else if (status >= 200 && status < 300) { d.ok = 1; Object.assign(d, extractUsage(data)); }
      else if (isCreditError(status, bodyText)) { d.credit_errors = 1; d.last_credit_error_at = new Date(now()).toISOString(); }
      else if (status === 429) d.limited = 1;
      else d.errors = 1;
      add(totals, parisDay(now()), feature, d);
      if (alert) {
        if (d.credit_errors) alert.creditOutOf();
        else if (d.ok) alert.creditWorking();
      }
    } catch { /* never in the way of a call */ }
  }

  async function writeRows(rows) {
    const col = (c) => rows.map((r) => r[c]);
    const sets = [...COUNTERS.map((c) => `${c} = ai_usage_stats.${c} + EXCLUDED.${c}`), "last_credit_error_at = GREATEST(ai_usage_stats.last_credit_error_at, EXCLUDED.last_credit_error_at)"].join(", ");
    await getPool().query(
      `INSERT INTO ai_usage_stats (day, feature, ${COUNTERS.join(", ")}, last_credit_error_at)
       SELECT * FROM unnest($1::date[], $2::text[], ${COUNTERS.map((c, i) => `$${i + 3}::${BIGINTS.has(c) ? "bigint" : "int"}[]`).join(", ")}, $${COUNTERS.length + 3}::timestamptz[])
       ON CONFLICT (day, feature) DO UPDATE SET ${sets}`,
      [col("day"), col("feature"), ...COUNTERS.map(col), col("last_credit_error_at")]
    );
  }

  // Writes what is in memory. Resolves { rows } and never rejects.
  function flush() {
    if (flushing) return flushing;
    if (!totals.size) return Promise.resolve({ rows: 0 });
    const batch = totals;
    totals = new Map();
    flushing = (async () => {
      try {
        const rows = [...batch.values()];
        await writeRows(rows);
        warned = false;
        return { rows: rows.length };
      } catch (err) {
        for (const row of batch.values()) if (totals.size < MAX_KEYS || totals.has(`${row.day}|${row.feature}`)) add(totals, row.day, row.feature, row);
        if (!warned) {
          warned = true;
          try { log(`AI usage statistics: could not be saved (${String((err && err.message) || err).slice(0, 120)}); will retry. The AI features are not affected.`); } catch { /* ignore */ }
        }
        return { rows: 0, failed: true };
      } finally {
        flushing = null;
      }
    })();
    return flushing;
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { flush(); }, flushMs);
    if (timer.unref) timer.unref();
  }
  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (flushing) await flushing;
    return flush();
  }

  return { recordCall, flush, start, stop, pending: () => totals.size, snapshot: () => [...totals.values()].map((r) => ({ ...r })) };
}

let current = null;
// The process-wide recorder (lazy, so requiring this file never touches the database).
const getStats = () => current || (current = createAiUsageStats({ alert: require("./aiCreditAlert").getCreditAlert() }));
// Tests inject a fake (or null to go back to the default).
const setStats = (s) => { current = s; };

// Convenience used by the Anthropic client (lib/anthropic.js): never throws, whatever happens.
function recordCall(feature, outcome) {
  try { getStats().recordCall(feature, outcome); } catch { /* ignore */ }
}

// Daily rows older than RETENTION_MONTHS are deleted (run by a daily job in index.js).
async function pruneAiUsageStats(pool) {
  const { rowCount } = await pool.query("DELETE FROM ai_usage_stats WHERE day < ((now() AT TIME ZONE $1)::date - make_interval(months => $2))", [SITE_TIME_ZONE, RETENTION_MONTHS]);
  return rowCount;
}

module.exports = { createAiUsageStats, getStats, setStats, recordCall, pruneAiUsageStats, isCreditError, extractUsage, AI_PRICES, FEATURES, COUNTERS, RETENTION_MONTHS, parisDay };
