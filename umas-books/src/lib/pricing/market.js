// AI market check: asks Claude (with its web search tool) what this exact
// edition currently sells for second-hand, so the price suggestion can be
// based on real listings. Off by default (PRICING_AI=1 and ANTHROPIC_API_KEY
// turn it on) and it FAILS OPEN: any problem returns null and the caller
// falls back to the rules.
//
// Only the ISBN, title, author and binding are sent: never anything about a
// person. Results are cached per ISBN-13 in price_lookups for 30 days, and a
// daily cap (PRICING_AI_DAILY_MAX, default 150) is counted from that same
// table, so a restart cannot reset it.

const { TEXT_MODEL } = require("../bookDescription");
const { DEFAULT_SETTINGS } = require("./rules");
const { toIsbn13 } = require("./isbn");
const { normalizeBinding } = require("../inventory");
const { recordCall } = require("../aiUsageStats");

const TIMEOUT_MS = 12000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TTL_MS = { ok: 30 * DAY_MS, empty: 7 * DAY_MS, failed: 60 * 60 * 1000 };
const DEFAULT_DAILY_MAX = 150;
const MIN_EUR = 0.5;
const MAX_EUR = 500;
const MAX_COMPARABLES = 12;
const CURRENCIES = new Set(["EUR", "USD", "GBP"]);

function aiEnabled(env = process.env) {
  const v = String(env.PRICING_AI || "").trim().toLowerCase();
  return (v === "1" || v === "true") && Boolean(env.ANTHROPIC_API_KEY);
}

function dailyMax(env = process.env) {
  const n = parseInt(env.PRICING_AI_DAILY_MAX, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_MAX;
}

function toEur(amount, currency, settings) {
  const a = Number(amount);
  if (!Number.isFinite(a)) return null;
  const rate = currency === "EUR" ? 1 : currency === "USD" ? settings.usdEur : currency === "GBP" ? settings.gbpEur : null;
  if (rate == null) return null;
  const eur = Math.round(a * rate * 100) / 100;
  return eur >= MIN_EUR && eur <= MAX_EUR ? eur : null;
}

function cleanText(value, max) {
  return String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max); // eslint-disable-line no-control-regex
}

function parseMoney(obj, settings) {
  if (!obj || typeof obj !== "object") return null;
  const currency = String(obj.currency || "").trim().toUpperCase();
  if (!CURRENCIES.has(currency)) return null;
  return toEur(obj.amount, currency, settings);
}

function httpsUrl(value) {
  try {
    const u = new URL(String(value || "").trim());
    if (u.protocol !== "https:" || !u.hostname.includes(".")) return null;
    const s = u.toString();
    return s.length <= 500 ? s : null;
  } catch {
    return null;
  }
}

// Pulls a JSON object out of model text: strips code fences and any chatter
// around it. Returns the parsed value or null.
function extractJson(text) {
  const t = String(text || "").replace(/```(?:json)?/gi, "");
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  try {
    return JSON.parse(t.slice(first, last + 1));
  } catch {
    return null;
  }
}

// Validates a model answer. Returns { originalPrice: number|null (EUR),
// comparables: [{ site, url, price (EUR), condition, note }] } or null when
// the text is not usable JSON of the expected shape.
function parseMarketResponse(text, settings = DEFAULT_SETTINGS) {
  const data = extractJson(text);
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const originalPrice = parseMoney(data.originalPrice, settings);
  const comparables = [];
  const seen = new Set();
  for (const c of Array.isArray(data.comparables) ? data.comparables : []) {
    if (!c || typeof c !== "object") continue;
    const url = httpsUrl(c.url);
    const price = parseMoney(c.price, settings);
    const site = cleanText(c.site, 40);
    if (!url || price == null || !site || seen.has(url)) continue;
    seen.add(url);
    comparables.push({ site, url, price, condition: cleanText(c.condition, 40) || null, note: cleanText(c.note, 200) || null });
    if (comparables.length >= MAX_COMPARABLES) break;
  }
  return { originalPrice, comparables };
}

function buildPrompt({ isbn13, title, author, binding }) {
  const bindingText = { hardcover: "hardcover", trade: "trade paperback", mass_market: "mass market paperback", other: "other format" }[normalizeBinding(binding)] || "unknown";
  return `You help a small second-hand English-language bookshop in France price a book. Use web search to find what THIS exact edition currently sells for second-hand.

ISBN-13: ${isbn13}
Title: ${cleanText(title, 200) || "unknown"}
Author: ${cleanText(author, 200) || "unknown"}
Binding: ${bindingText}

Return ONLY JSON, no other text, in exactly this shape:
{"originalPrice": {"amount": 12.5, "currency": "EUR"} or null, "comparables": [{"site": "AbeBooks", "url": "https://...", "price": {"amount": 7.2, "currency": "EUR"}, "condition": "Very Good", "note": "short remark"}]}

Rules:
- originalPrice is the publisher's list/cover price of this edition if you found it, else null.
- comparables are CURRENT or recent USED listings of THIS edition (same ISBN or clearly the same edition), from sites such as AbeBooks, eBay, Amazon marketplace, Momox, Rakuten, Vinted, Booklooker, BookFinder.
- Every comparable must have a real URL that you actually found in the search. No guesses, no invented listings, no new-copy prices.
- price is the item price only (not shipping), in EUR, USD or GBP.
- If you are unsure, return an empty comparables list. Fewer, reliable listings are better than many doubtful ones.`;
}

// One call to the API. Returns the parsed result, or null on any failure.
async function fetchMarketData(query, { fetchImpl, env = process.env, settings = DEFAULT_SETTINGS, timeoutMs = TIMEOUT_MS } = {}) {
  const apiKey = env.ANTHROPIC_API_KEY;
  const isbn13 = toIsbn13(query.isbn);
  if (!apiKey || !isbn13) return null;
  const doFetch = fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  let recorded = false; // usage statistics (counts only), see lib/aiUsageStats.js
  try {
    const res = await doFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        ...(env.ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": env.ANTHROPIC_WORKSPACE_ID } : {}),
      },
      body: JSON.stringify({
        model: env.PRICING_AI_MODEL || TEXT_MODEL,
        max_tokens: 2000,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }],
        messages: [{ role: "user", content: buildPrompt({ ...query, isbn13 }) }],
      }),
    });
    if (!res.ok) {
      const body = typeof res.text === "function" ? await res.text().catch(() => "") : "";
      recorded = true;
      recordCall("price", { status: res.status, bodyText: body, ms: Date.now() - t0 });
      console.warn("Price check request failed:", res.status);
      return null;
    }
    const data = await res.json();
    recorded = true;
    recordCall("price", { status: res.status, data, ms: Date.now() - t0 });
    const blocks = Array.isArray(data.content) ? data.content.filter((b) => b && b.type === "text" && typeof b.text === "string") : [];
    // Web search adds narration blocks; the JSON answer is normally the last text.
    for (let i = blocks.length - 1; i >= 0; i--) {
      const parsed = parseMarketResponse(blocks[i].text, settings);
      if (parsed) return parsed;
    }
    const joined = parseMarketResponse(blocks.map((b) => b.text).join("\n"), settings);
    if (!joined) console.warn("Price check skipped: answer was not usable JSON.");
    return joined;
  } catch (err) {
    if (!recorded) recordCall("price", { failed: true, ms: Date.now() - t0 });
    console.warn("Price check skipped:", err.name === "AbortError" ? "request timed out" : err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Cached, capped lookup. Returns { originalPrice, comparables, fromCache,
// fetchedAt } or null (disabled, no ISBN, cap reached, failure, or a recent
// failure still being waited out). Never throws.
async function lookupMarket(pool, query, { fetchImpl, env = process.env, settings = DEFAULT_SETTINGS, now = Date.now() } = {}) {
  try {
    if (!aiEnabled(env)) return null;
    const isbn13 = toIsbn13(query.isbn);
    if (!isbn13) return null;

    const { rows } = await pool.query("SELECT fetched_at, data, state FROM price_lookups WHERE isbn = $1", [isbn13]);
    if (rows.length) {
      const age = now - new Date(rows[0].fetched_at).getTime();
      const ttl = TTL_MS[rows[0].state] || TTL_MS.ok;
      if (age >= 0 && age < ttl) {
        if (rows[0].state === "failed") return null;
        const d = rows[0].data || {};
        return { originalPrice: d.originalPrice ?? null, comparables: Array.isArray(d.comparables) ? d.comparables : [], fromCache: true, fetchedAt: rows[0].fetched_at };
      }
    }

    // Daily cap, counted from the database (Paris calendar day).
    const { rows: used } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM price_lookups
       WHERE fetched_at >= (date_trunc('day', now() AT TIME ZONE 'Europe/Paris') AT TIME ZONE 'Europe/Paris')`
    );
    if (used[0].n >= dailyMax(env)) {
      console.warn("Price check skipped: daily limit reached.");
      return null;
    }

    const result = await fetchMarketData(query, { fetchImpl, env, settings });
    const state = !result ? "failed" : result.comparables.length || result.originalPrice != null ? "ok" : "empty";
    await pool.query(
      `INSERT INTO price_lookups (isbn, fetched_at, data, state) VALUES ($1, now(), $2, $3)
       ON CONFLICT (isbn) DO UPDATE SET fetched_at = now(), data = EXCLUDED.data, state = EXCLUDED.state`,
      [isbn13, result ? JSON.stringify(result) : null, state]
    );
    return result ? { ...result, fromCache: false, fetchedAt: new Date() } : null;
  } catch (err) {
    console.warn("Price lookup skipped:", err.message);
    return null;
  }
}

module.exports = {
  TIMEOUT_MS, TTL_MS, DEFAULT_DAILY_MAX, aiEnabled, dailyMax, toIsbn13, parseMarketResponse, buildPrompt, fetchMarketData, lookupMarket,
};
