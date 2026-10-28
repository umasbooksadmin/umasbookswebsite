"use strict";
// The ONE client for the Anthropic Messages API. Every AI feature (descriptions, translations, genres, cover photo
// reading, the price check, collection suggestions and translations) goes through request() below, so the URL, the
// headers, the daily cap, the timeout, the error classification and the usage counts exist exactly once.
//
//   const anthropic = require("./anthropic");
//   const r = await anthropic.request({ feature: "genre", model: anthropic.MODELS.text.id, messages: [...], maxTokens: 60, timeoutMs: 8000 });
//   r.ok  -> { ok: true, data, status, ms }                       (data = the parsed response body)
//   else  -> { ok: false, kind, message, status?, body?, ms? }    kind: see FAILURE_KINDS
//
// request() never throws and never logs (the feature says what it wants in its own log line). It records every call it
// makes in ai_usage_stats (lib/aiUsageStats.js recordCall, counts only) and takes its slot of the shared daily cap
// (lib/aiLimits.js acquireAiCall) BEFORE the call. Nothing is sent without an API key, and no slot is taken without one.
//
// HOW TO ADD AN AI FEATURE: add its name to FEATURES in aiUsageStats.js (and the migration CHECK, if any, plus the
// report label), build the prompt in the feature's own module, call request() with the model key and the limits that
// feature needs, map the failure kinds to what that feature does (usually: null). HOW TO CHANGE A MODEL OR A PRICE:
// edit lib/anthropicModels.js only.

const config = require("./config");
const { getAiLimits } = require("./aiLimits");
const { recordCall, isCreditError } = require("./aiUsageStats");
const { MODELS } = require("./anthropicModels");

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

// no-key      ANTHROPIC_API_KEY is not set (nothing was sent, no slot taken)
// cap         the shared daily cap AI_DAILY_MAX_CALLS is used up (nothing was sent); failure.message says so
// no-credit   the Anthropic credit is used up (HTTP 400/402 "credit balance", or billing_error)
// rate-limit  HTTP 429
// http        any other HTTP error (failure.status, failure.body)
// timeout     the time limit passed (also while reading the answer), or the caller's signal aborted
// network     no connection / fetch threw
// invalid     the answer was 2xx but not readable JSON
const FAILURE_KINDS = ["no-key", "cap", "no-credit", "rate-limit", "http", "timeout", "network", "invalid"];

// The text of the first content block, or undefined (what every text feature reads).
function textOf(data) {
  return data && data.content && data.content[0] && data.content[0].text;
}

// Is there an API key? (the features that check their own input first ask this, to keep their order of checks)
const hasApiKey = (env) => Boolean(config.get("ANTHROPIC_API_KEY", env));

// request({ feature, model, system, messages, maxTokens, tools, toolChoice, timeoutMs, signal, env, fetchImpl, claim })
//   feature     usage-statistics feature (aiUsageStats FEATURES)
//   model       a model id (MODELS.text.id ...)
//   messages    the messages array, sent as is
//   system      optional system prompt (omitted from the body when absent)
//   tools       optional tools array (omitted when absent)
//   toolChoice  optional tool_choice object, e.g. { type: "tool", name: "..." } (omitted when absent)
//   timeoutMs   REQUIRED: each feature keeps its own limit (8 s texts, 20 s photos, 45 s collection suggestions ...)
//   signal      optional AbortSignal of the caller (counts as a timeout failure when it fires)
//   env         optional settings object for config.get (tests); default process.env
//   fetchImpl   optional fetch (tests); default globalThis.fetch looked up at call time
//   claim       "shared" (default): take one slot of the shared daily cap first. false: the caller already holds its
//               slot (the price check takes its own cap and the shared one together in lib/aiLimits acquirePriceCall)
async function request({ feature, model, system, messages, maxTokens, tools, toolChoice, timeoutMs, signal, env, fetchImpl, claim = "shared" }) {
  const apiKey = config.get("ANTHROPIC_API_KEY", env);
  if (!apiKey) return { ok: false, kind: "no-key", message: "ANTHROPIC_API_KEY not set." };

  if (claim) {
    const slot = await getAiLimits().acquireAiCall();
    if (!slot.ok) return { ok: false, kind: "cap", message: slot.message };
  }

  const workspace = config.get("ANTHROPIC_WORKSPACE_ID", env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let onAbort = null;
  if (signal) {
    if (signal.aborted) controller.abort();
    else { onAbort = () => controller.abort(); signal.addEventListener("abort", onAbort, { once: true }); }
  }

  const t0 = Date.now();
  let recorded = false; // usage statistics (counts only), see lib/aiUsageStats.js
  try {
    const doFetch = fetchImpl || globalThis.fetch;
    const res = await doFetch(API_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": API_VERSION,
        ...(workspace ? { "anthropic-workspace-id": workspace } : {}),
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        ...(tools ? { tools } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
        ...(system ? { system } : {}),
        messages,
      }),
    });

    if (!res.ok) {
      const body = typeof res.text === "function" ? await res.text().catch(() => "") : "";
      const ms = Date.now() - t0;
      recorded = true;
      recordCall(feature, { status: res.status, bodyText: body, ms });
      const kind = isCreditError(res.status, body) ? "no-credit" : res.status === 429 ? "rate-limit" : "http";
      return { ok: false, kind, status: res.status, body, ms, message: `HTTP ${res.status}` };
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      recorded = true;
      recordCall(feature, { failed: true, ms: Date.now() - t0 });
      return { ok: false, kind: "invalid", message: err.message, ms: Date.now() - t0 };
    }
    const ms = Date.now() - t0;
    recorded = true;
    recordCall(feature, { status: res.status, data, ms });
    return { ok: true, data, status: res.status, ms };
  } catch (err) {
    const ms = Date.now() - t0;
    if (!recorded) recordCall(feature, { failed: true, ms });
    const timedOut = err && err.name === "AbortError";
    return { ok: false, kind: timedOut ? "timeout" : "network", message: timedOut ? "request timed out" : err.message, ms };
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

// A single-prompt text question to MODELS.text, with the answer as { text, reason }. reason is null (worked), "no_key",
// "cap" (+ message), "credit", "rate", "timeout" or "error" (an HTTP error, no connection, an answer that is not
// JSON, or JSON without text). The admin screens that tell a person WHY (collection suggestions, "Translate to
// French") and the description helpers use it. Never throws, never logs a prompt.
//   opts.maxTokens (default 200), opts.timeoutMs (default 8 s), opts.feature (default "description"), opts.label (log)
const REASONS = { "no-key": "no_key", cap: "cap", "no-credit": "credit", "rate-limit": "rate", timeout: "timeout" };
async function askText(prompt, { maxTokens = 200, label, feature = "description", timeoutMs = 8000 } = {}) {
  const r = await request({ feature, model: MODELS.text.id, messages: [{ role: "user", content: prompt }], maxTokens, timeoutMs });
  if (!r.ok) {
    if (r.kind === "no-key") console.warn(`${label} skipped: ANTHROPIC_API_KEY not set.`);
    else if (r.kind === "cap") console.warn(`${label} skipped: ${r.message}`);
    else if (r.status) console.warn(`${label} request failed:`, r.status, r.body);
    else console.warn(`${label} skipped:`, r.message);
    return r.kind === "cap" ? { text: null, reason: "cap", message: r.message } : { text: null, reason: REASONS[r.kind] || "error" };
  }
  const text = textOf(r.data);
  if (!text) {
    console.warn(`${label} skipped: unexpected response shape:`, JSON.stringify(r.data).slice(0, 500));
    return { text: null, reason: "error" };
  }
  try {
    return { text: text.trim(), reason: null };
  } catch (err) { // a text that is not a string: same as any other unusable answer
    console.warn(`${label} skipped:`, err.message);
    return { text: null, reason: "error" };
  }
}

module.exports = { request, hasApiKey, askText, textOf, MODELS, FAILURE_KINDS, API_URL, API_VERSION };
