// Awards found by AI web search: the LEAST trusted source. Off unless
// ANTHROPIC_API_KEY is set AND AWARDS_AI is '1'/'true'. Everything it returns
// is stored 'pending' and stays hidden from customers until an admin
// approves it (see lib/awards/index.js), because a language model can
// invent awards.
//
// Safeguards in this file:
//   - the prompt asks only for documented awards / shortlists / best-seller
//     lists of this exact title + author, each with a source URL;
//   - an item is kept only if its URL really appeared in the web search
//     results (or citations) of the same response, so an invented URL is
//     dropped, and only https URLs are kept;
//   - strict parsing (fences stripped, shape, label length, kind enum);
//   - a daily cap on books checked (AWARDS_AI_DAILY_MAX, default 100),
//     counted in memory AND in the database so a restart cannot reset it.
//
// Fails open: never throws. Returns { items, error, skipped }.

const { requestJson } = require("./http");
const { TEXT_MODEL } = require("../bookDescription");

const AI_TIMEOUT_MS = 45 * 1000; // a web search takes far longer than a plain lookup
const KINDS = new Set(["award", "shortlist", "bestseller", "list"]);
const MAX_ITEMS = 10;

function truthy(v) {
  return /^(1|true)$/i.test(String(v || "").trim());
}

function aiEnabled(env = process.env) {
  return Boolean(env.ANTHROPIC_API_KEY) && truthy(env.AWARDS_AI);
}

function dailyMax(env = process.env) {
  const n = parseInt(env.AWARDS_AI_DAILY_MAX, 10);
  return Number.isInteger(n) && n >= 0 ? n : 100;
}

// ---- daily cap -------------------------------------------------------------
const memory = { day: "", count: 0 };
const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

function memoryUsed(now) {
  if (memory.day !== today(now)) { memory.day = today(now); memory.count = 0; }
  return memory.count;
}
function noteAiCall(now) {
  memoryUsed(now);
  memory.count += 1;
}
function resetAiUsage() {
  memory.day = "";
  memory.count = 0;
}

// Books AI-checked since 00:00 UTC (the database half of the cap).
async function dbUsedToday(pool) {
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM books WHERE awards_ai_checked_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"
  );
  return rows[0].n;
}

// { used, max, remaining } using the larger of the two counters.
async function aiUsage(pool, { env = process.env, now } = {}) {
  let db = 0;
  try { db = await dbUsedToday(pool); } catch (err) { console.warn("Awards: AI usage count failed:", err.message); }
  const used = Math.max(db, memoryUsed(now));
  const max = dailyMax(env);
  return { used, max, remaining: Math.max(0, max - used) };
}

// ---- parsing ---------------------------------------------------------------
function normUrl(u) {
  try {
    const x = new URL(String(u));
    x.hash = "";
    return x.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function extractJson(text) {
  let s = String(text || "").trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

// allowedUrls: Set of normalised URLs seen in the search results. When it is
// null no URL check is done (unit tests of pure parsing); the live caller
// always passes a Set, and an empty Set rejects everything.
function parseAiItems(text, allowedUrls = null) {
  const data = extractJson(text);
  const list = data && Array.isArray(data.items) ? data.items : [];
  const out = [];
  const seen = new Set();
  for (const it of list) {
    if (!it || typeof it !== "object") continue;
    const label = typeof it.label === "string" ? it.label.replace(/\s+/g, " ").trim() : "";
    if (!label || label.length > 200) continue;
    if (!KINDS.has(it.kind)) continue;
    const y = Number.isInteger(it.year) ? it.year : parseInt(it.year, 10);
    const year = Number.isInteger(y) && y >= 1000 && y <= 2200 ? y : null;
    if (typeof it.source_url !== "string" || !/^https:\/\//i.test(it.source_url.trim())) continue;
    const url = normUrl(it.source_url.trim());
    if (!url || url.length > 500) continue;
    if (allowedUrls && !allowedUrls.has(url)) continue;
    const key = `${label.toLowerCase()}|${year || 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, year, kind: it.kind, source_url: url });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

// Pulls the answer text and every URL the search actually returned or cited.
function readResponse(data) {
  const blocks = data && Array.isArray(data.content) ? data.content : [];
  const urls = new Set();
  let text = "";
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === "text" && typeof b.text === "string") {
      text += b.text;
      for (const c of Array.isArray(b.citations) ? b.citations : []) {
        const u = c && normUrl(c.url);
        if (u) urls.add(u);
      }
    } else if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content) {
        const u = r && normUrl(r.url);
        if (u) urls.add(u);
      }
    }
  }
  return { text, urls };
}

function buildPrompt({ title, author, isbn, year }) {
  return `You are fact-checking one book for a bookshop's website. Use web search to find which major literary awards, award shortlists/nominations and best-seller lists THIS SPECIFIC BOOK (this title by this author) is documented to have.

Title: "${title}"
Author: ${author}
${isbn ? `ISBN: ${isbn}\n` : ""}${year ? `First published: ${year}\n` : ""}
Rules:
- Only include a result you found on a web page in your searches, and give that page's URL as source_url (an https URL that appeared in your search results).
- Include only named awards (e.g. a prize), shortlists or longlists of a named prize, and named best-seller lists (e.g. "New York Times Best Seller"). Do NOT include publisher marketing ("international bestseller"), reviews, "critically acclaimed", or awards won by the author's other books.
- If you are not sure, or the book is obscure, return an empty list. An empty list is a good answer.
- kind is one of: "award" (won), "shortlist" (shortlisted, nominated or longlisted), "bestseller" (a best-seller list), "list" (another notable list such as a "best books of the year" list).
- year is the year of the award or list, or null.

Respond with ONLY JSON, no other text: {"items":[{"label":"...","year":2019,"kind":"award","source_url":"https://..."}]}`;
}

async function lookupAiAwards(book, { fetch: fetchFn, env = process.env, timeoutMs = AI_TIMEOUT_MS } = {}) {
  if (!aiEnabled(env)) return { items: [], error: false, skipped: true };
  const title = book && String(book.title || "").trim();
  const author = book && String(book.authors || book.author || "").trim();
  if (!title || !author) return { items: [], error: false, skipped: true };
  try {
    const res = await requestJson("https://api.anthropic.com/v1/messages", {
      fetch: fetchFn, method: "POST", timeoutMs, secrets: [env.ANTHROPIC_API_KEY],
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        ...(env.ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": env.ANTHROPIC_WORKSPACE_ID } : {}),
      },
      body: JSON.stringify({
        model: env.AWARDS_AI_MODEL || TEXT_MODEL,
        max_tokens: 1500,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
        messages: [{ role: "user", content: buildPrompt({ title, author, isbn: book.isbn, year: book.published_year }) }],
      }),
    });
    if (!res.ok) {
      console.warn("Awards: AI lookup failed:", res.error);
      return { items: [], error: true, called: true };
    }
    if (res.json && res.json.type === "error") {
      console.warn("Awards: AI lookup returned an error.");
      return { items: [], error: true, called: true };
    }
    const { text, urls } = readResponse(res.json);
    return { items: parseAiItems(text, urls), error: false, called: true };
  } catch (err) {
    console.warn("Awards: AI lookup failed:", err.message);
    return { items: [], error: true, called: true };
  }
}

module.exports = { lookupAiAwards, parseAiItems, readResponse, aiEnabled, dailyMax, aiUsage, noteAiCall, resetAiUsage, buildPrompt };
