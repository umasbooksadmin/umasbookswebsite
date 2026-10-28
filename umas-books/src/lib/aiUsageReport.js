// "AI usage" part of the report /admin/reports/lookup-sources: what the site asked the Anthropic API, per feature,
// over the same Period menu. Built from ai_usage_stats (counts per Paris day and feature, lib/aiUsageStats.js).
// Counts only: no prompt, title, ISBN, text or person.

const { AI_PRICES, FEATURES } = require("./aiUsageStats");
const { SITE_TIME_ZONE } = require("./tz");

const FEATURE_LABELS = {
  description: "Description",
  translation: "French translation",
  genre: "Genre suggestion",
  cover: "Cover photo reading",
  price: "Price check (web search)",
  search: "Inventory search (sentence)",
};
const SUMS = ["calls", "ok", "errors", "limited", "credit_errors", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "web_searches", "duration_ms_sum", "duration_n"];
const num = (v) => Number(v || 0);
const sortKey = (f) => { const i = FEATURES.indexOf(f); return i < 0 ? FEATURES.length : i; };

const blank = () => Object.fromEntries(SUMS.map((c) => [c, 0]));
const addInto = (t, r) => { for (const c of SUMS) t[c] += num(r[c]); };

// Estimated cost in USD from the token counts, or null when the model has no price in AI_PRICES.
function estimateUsd(t, prices = AI_PRICES) {
  const p = prices.usdPerMTok[prices.assumedModel];
  if (!p) return null;
  return (t.input_tokens * p.input + t.output_tokens * p.output) / 1e6;
}

function shape(feature, t, extra = {}, usdEur) {
  const usd = estimateUsd(t);
  return {
    ...extra,
    feature: FEATURE_LABELS[feature] || feature,
    calls: t.calls, ok: t.ok, errors: t.errors, limited: t.limited, credit_errors: t.credit_errors,
    input_tokens: t.input_tokens, output_tokens: t.output_tokens, web_searches: t.web_searches,
    avg_ms: t.duration_n ? Math.round(t.duration_ms_sum / t.duration_n) : null,
    est_usd: usd, est_eur: usd == null ? null : usd * usdEur,
  };
}

const cols = (first) => [
  ...first,
  { key: "calls", label: "Calls made", type: "int" },
  { key: "ok", label: "Succeeded", type: "int" },
  { key: "errors", label: "Failed (error)", type: "int" },
  { key: "limited", label: "Refused: rate limit (429)", type: "int" },
  { key: "credit_errors", label: "Credit balance too low / billing", type: "int" },
  { key: "input_tokens", label: "Input tokens", type: "int" },
  { key: "output_tokens", label: "Output tokens", type: "int" },
  { key: "web_searches", label: "Web searches", type: "int" },
  { key: "avg_ms", label: "Average response (ms)", type: "int" },
  { key: "est_usd", label: "Estimated cost (USD)", type: "usd" },
  { key: "est_eur", label: "Estimated cost (EUR)", type: "eur4" },
];

// -> { banner, sections, notes } to add to the report.
async function build(db, period, { csv = false } = {}) {
  const { DEFAULT_SETTINGS } = require("./pricing/rules");
  const usdEur = DEFAULT_SETTINGS.usdEur;
  try { await require("./aiUsageStats").getStats().flush(); } catch { /* what is in memory is simply not counted yet */ }

  const { rows } = await db.query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, feature, calls, ok, errors, limited, credit_errors,
            input_tokens::float8 AS input_tokens, output_tokens::float8 AS output_tokens,
            cache_read_tokens::float8 AS cache_read_tokens, cache_write_tokens::float8 AS cache_write_tokens,
            web_searches, duration_ms_sum::float8 AS duration_ms_sum, duration_n
     FROM ai_usage_stats
     WHERE ($1::date IS NULL OR day >= $1::date) AND ($2::date IS NULL OR day <= $2::date)
     ORDER BY day, feature`,
    [period.from, period.to]
  );
  const credit = await db.query(
    `SELECT max(last_credit_error_at) AS at FROM ai_usage_stats WHERE last_credit_error_at > now() - interval '24 hours'`
  );

  const byFeature = new Map();
  const byMonth = new Map();
  for (const r of rows) {
    if (!byFeature.has(r.feature)) byFeature.set(r.feature, blank());
    addInto(byFeature.get(r.feature), r);
    const mk = `${r.day.slice(0, 7)}|${r.feature}`;
    if (!byMonth.has(mk)) byMonth.set(mk, blank());
    addInto(byMonth.get(mk), r);
  }
  const total = blank();
  for (const t of byFeature.values()) addInto(total, t);

  const featureRows = FEATURES.map((f) => shape(f, byFeature.get(f) || blank(), {}, usdEur));
  const sumRow = shape("total", total, {}, usdEur);
  sumRow.feature = "All features";
  featureRows.push(sumRow);
  const monthRows = [...byMonth.entries()].map(([k, t]) => { const [month, feature] = k.split("|"); return { f: feature, row: shape(feature, t, { month }, usdEur) }; })
    .sort((a, b) => (a.row.month < b.row.month ? -1 : a.row.month > b.row.month ? 1 : sortKey(a.f) - sortKey(b.f))).map((x) => x.row);
  let dayRows = rows.slice().sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : sortKey(a.feature) - sortKey(b.feature)))
    .map((r) => shape(r.feature, Object.fromEntries(SUMS.map((c) => [c, num(r[c])])), { day: r.day }, usdEur));
  const dailyTotal = dayRows.length;
  const LIMIT = require("./reports").LIST_LIMIT;
  if (!csv && dayRows.length > LIMIT) dayRows = dayRows.slice(0, LIMIT);

  let banner = null;
  if (credit.rows[0] && credit.rows[0].at) {
    const at = new Date(credit.rows[0].at).toLocaleString("en-GB", { timeZone: SITE_TIME_ZONE, dateStyle: "medium", timeStyle: "short" });
    banner = { level: "danger", text: `Anthropic API credit ran out at ${at}: top up at console.anthropic.com > Billing. Until then the AI features (descriptions, translations, genres, cover photo reading, price checks) do not work; scanning by ISBN, saving, the till and reservations keep working.` };
  }

  // The shared daily cap (AI_DAILY_MAX_CALLS, lib/aiLimits.js) used up today: say so, and how to raise it.
  try {
    const cap = await require("./aiLimits").getAiLimits().status({ pool: db });
    if (cap.reached) {
      const text = `${cap.message} The AI helpers are paused until then; scanning, saving, the till and reservations keep working. To allow more calls a day, raise AI_DAILY_MAX_CALLS in Render > Environment (runbook: "AI limits").`;
      banner = banner ? { level: "danger", text: `${banner.text} ${text}` } : { level: "danger", text };
    }
  } catch { /* the report does not depend on it */ }

  const priced = AI_PRICES.usdPerMTok[AI_PRICES.assumedModel];
  return {
    banner,
    sections: [
      {
        key: "ai", title: `AI usage per feature: ${period.label.toLowerCase()}`, columns: cols([{ key: "feature", label: "Feature", type: "text" }]), rows: featureRows,
        note: "Each row counts calls to the Anthropic API (the paid AI service). Calls made = succeeded + failed + refused (rate limit) + credit balance too low.",
      },
      { key: "ai_monthly", title: "AI usage per month", columns: cols([{ key: "month", label: "Month", type: "text" }, { key: "feature", label: "Feature", type: "text" }]), rows: monthRows },
      {
        key: "ai_daily", title: "AI usage per day", columns: cols([{ key: "day", label: "Day (Paris)", type: "text" }, { key: "feature", label: "Feature", type: "text" }]), rows: dayRows,
        note: dailyTotal > dayRows.length ? `The latest ${dayRows.length} of ${dailyTotal} rows are shown here; the CSV has all of them.` : undefined,
      },
    ],
    notes: [
      `AI usage: ${priced
        ? `the estimated cost is computed from the token counts only, at ${priced.input} USD per million input tokens and ${priced.output} USD per million output tokens (${AI_PRICES.assumedModel}; prices last checked ${AI_PRICES.updated}; EUR at ${usdEur} per USD). It is a floor, not the bill: web searches (Price check) are billed by Anthropic on top and are not priced here, and if PRICING_AI_MODEL is set to another model the Price check estimate is wrong. Check Anthropic's price list and your invoice at console.anthropic.com > Billing.`
        : "no price is known for the model in use, so only token counts are shown."} "Credit balance too low / billing" counts answers where Anthropic refused because the account has no credit left. No prompts, titles, ISBNs or people are recorded: only counts per day and feature.`,
    ],
  };
}

module.exports = { build, estimateUsd, FEATURE_LABELS };
