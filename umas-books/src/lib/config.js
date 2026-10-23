"use strict";
// The ONE way the app reads its settings (environment variables).
//
//   const config = require("./config");
//   config.get("AI_DAILY_MAX_CALLS");          // a number: the value, or the default
//   config.get("PREVIEW_MODE", env);           // a boolean; `env` defaults to process.env
//   config.read("DB_POOL_MAX", env);           // { value, state: "unset"|"ok"|"invalid", raw, message }
//
// Every variable is declared once in configRegistry.js (name, kind, default, secret,
// where it is set, one-line doc). That registry drives these accessors, the table in
// ARCHITECTURE.md and .env.example (`npm run docs:env`), and the launch validation in
// env.js. To add a setting: add one entry there (docs/runbook.md, "Add a setting").
//
// Behaviour-preserving by design. The code used to have six number parsers and five
// on/off conventions, each with slightly different rules for "", whitespace, "0", "off",
// "5.5", "abc", "-1", "1e3". Those differences are real and in production use, so they are
// NOT unified here: each registry entry says which rule that variable has always followed
// (blank / trim / digits / integer / min / max / finite / parse / words ...), and the
// equivalence test (test/unit/configEquivalence.test.js) compares every variable against
// its original parser over a matrix of inputs. The only new behaviour: a value that is
// SET but unusable (so the default is used) is reported by invalidSettings() / warnInvalid()
// at boot, one line per variable, instead of falling back silently.
//
// Accessors read the environment on every call (nothing is cached), exactly like the
// `process.env.X` reads they replace, so tests may change process.env or pass an `env`
// object. Secrets are never put in a message: only int / ms / flag values (never secret)
// are ever quoted, and the registry test enforces it.

const { REGISTRY, GROUPS } = require("./configRegistry");

const BY_NAME = new Map(REGISTRY.map((spec) => [spec.name, spec]));

function specFor(name) {
  const spec = BY_NAME.get(name);
  if (!spec) throw new Error(`Unknown setting ${name}: declare it in src/lib/configRegistry.js (docs/runbook.md, "Add a setting").`);
  return spec;
}

const asEnv = (env) => (env == null ? {} : env);
const resolveDefault = (spec, env) => (typeof spec.default === "function" ? spec.default(env) : spec.default);

// Short, safe-to-log form of a bad value (numbers and flags only; never a secret).
const shown = (raw) => (String(raw).length > 60 ? `${String(raw).slice(0, 60)}...` : String(raw));

// ---- numbers -------------------------------------------------------------------------
// Options (all optional; each variable's own rule, see configRegistry.js):
//   blank       "empty" (default): only ""/unset mean "not set";  "trim": whitespace-only too
//   trim        trim the text before the `digits` test (Number()/parseInt() ignore edge spaces anyway)
//   digits      RegExp the text must match before it is converted (whole numbers only, no "1e3")
//   parse       "number" (default: Number(text)) or "parseInt" (parseInt(text, 10))
//   integer     must be a whole number
//   finite      false = Infinity is accepted (default true)
//   min / max / minExclusive   range
//   zeroIsDefault   0 (and NaN) fall back to the default (`Number(x) || default`)
//   lenient     no validation at all: Number(text), NaN included (one legacy reader)
//   words       { off: Infinity }: case-insensitive words with a fixed value
//   message(name, raw, text, defaultValue, spec)   custom text for a bad value
function readNumber(spec, name, env) {
  const raw = asEnv(env)[name];
  const fallback = resolveDefault(spec, asEnv(env));
  const unset = { value: fallback, state: "unset", raw };
  if (raw === undefined || raw === null) return unset;
  const asText = String(raw);
  if (spec.blank === "trim" ? asText.trim() === "" : asText === "") return unset;
  const text = spec.trim ? asText.trim() : asText;
  if (spec.words) {
    const w = asText.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(spec.words, w)) return { value: spec.words[w], state: "ok", raw };
  }
  if (spec.lenient) return { value: Number(text), state: "ok", raw };
  const n = spec.parse === "parseInt" ? parseInt(text, 10) : Number(text);
  let ok = !Number.isNaN(n);
  if (ok && spec.digits && !spec.digits.test(text)) ok = false;
  if (ok && spec.finite !== false && !Number.isFinite(n)) ok = false;
  if (ok && spec.integer && !Number.isInteger(n)) ok = false;
  if (ok && spec.min !== undefined && !(spec.minExclusive ? n > spec.min : n >= spec.min)) ok = false;
  if (ok && spec.max !== undefined && !(n <= spec.max)) ok = false;
  if (ok && spec.zeroIsDefault && !n) ok = false;
  if (ok) return { value: n, state: "ok", raw };
  return { value: fallback, state: "invalid", raw, message: numberMessage(spec, name, raw, text, fallback) };
}

function rangeText(spec) {
  if (spec.min !== undefined && spec.max !== undefined) return ` from ${spec.min} to ${spec.max}`;
  if (spec.min !== undefined) return spec.minExclusive ? ` above ${spec.min}` : ` of ${spec.min} or more`;
  return "";
}

function numberMessage(spec, name, raw, text, fallback) {
  if (spec.message) return spec.message(name, raw, text, fallback, spec);
  const what = spec.integer || spec.digits ? "a whole number" : "a number";
  const off = spec.words && "off" in spec.words ? ' (or "off")' : "";
  const def = fallback === undefined ? "the built-in behaviour" : `the default (${fallback})`;
  return `${name}=${JSON.stringify(shown(raw))} is not ${what}${rangeText(spec)}${off}; using ${def}.`;
}

// ---- on/off flags ----------------------------------------------------------------------
// Options: default, onWords, offWords (lower-case words), trim, lower (normalise before the
// test), ignoreWords (valid values of an enum-like variable that mean "neither"). A value
// that is none of these is "invalid": the default is used (as it always was) and it is reported.
function readFlag(spec, name, env) {
  const raw = asEnv(env)[name];
  const fallback = resolveDefault(spec, asEnv(env));
  if (raw === undefined || raw === null) return { value: fallback, state: "unset", raw };
  let s = String(raw);
  if (spec.trim) s = s.trim();
  if (spec.lower) s = s.toLowerCase();
  if ((spec.onWords || []).includes(s)) return { value: true, state: "ok", raw };
  if ((spec.offWords || []).includes(s)) return { value: false, state: "ok", raw };
  if (s.trim() === "" || (spec.ignoreWords || []).includes(s)) return { value: fallback, state: "ok", raw };
  const words = [...(spec.onWords || []), ...(spec.offWords || [])].map((w) => JSON.stringify(w)).join(", ");
  return {
    value: fallback,
    state: "invalid",
    raw,
    message: `${name}=${JSON.stringify(shown(raw))} is not a recognised on/off value (${words}); using the default (${fallback ? "on" : "off"}).`,
  };
}

// ---- text ------------------------------------------------------------------------------
// Without a default the raw value comes back untouched (undefined when unset, "" when empty).
// With a default, unset OR empty gives the default (the old `process.env.X || fallback`).
// trim / lower are applied to whatever was chosen.
function readString(spec, name, env) {
  const raw = asEnv(env)[name];
  const fallback = resolveDefault(spec, asEnv(env));
  let v = raw;
  if (fallback !== undefined && (raw === undefined || raw === null || raw === "")) v = fallback;
  if (v !== undefined && v !== null) {
    if (spec.trim) v = String(v).trim();
    if (spec.lower) v = String(v).toLowerCase();
  }
  return { value: v, state: raw === undefined ? "unset" : "ok", raw };
}

// ---- public accessors ------------------------------------------------------------------
function read(name, env = process.env) {
  const spec = specFor(name);
  if (spec.kind === "int" || spec.kind === "ms") return readNumber(spec, name, env);
  if (spec.kind === "flag") return readFlag(spec, name, env);
  return readString(spec, name, env);
}

// The value of a declared setting (see the file header). `override` adjusts the rule for one
// call site that has always had its own (only coverStore's SCAN_CACHE_TTL_MS does).
function get(name, env = process.env, override) {
  if (!override) return read(name, env).value;
  const spec = { ...specFor(name), ...override };
  const kind = spec.kind;
  if (kind === "int" || kind === "ms") return readNumber(spec, name, env).value;
  if (kind === "flag") return readFlag(spec, name, env).value;
  return readString(spec, name, env).value;
}

// "Is it set to something other than blanks?" (the launch checks use this, not get()).
function isSet(name, env = process.env) {
  specFor(name);
  const v = asEnv(env)[name];
  return typeof v === "string" && v.trim() !== "";
}

const isProduction = (env = process.env) => get("NODE_ENV", env) === "production";
const isTest = (env = process.env) => get("NODE_ENV", env) === "test";

// Generic helpers for a one-off variable that is not (yet) in the registry, e.g. in a test.
// Same engines, explicit options; production code declares the variable in the registry.
const envInt = (name, opts = {}, env = process.env) => readNumber({ kind: "int", ...opts }, name, env).value;
const envMs = envInt;
const envFlag = (name, opts = {}, env = process.env) => readFlag({ kind: "flag", ...opts }, name, env).value;
const envString = (name, opts = {}, env = process.env) => readString({ kind: "string", ...opts }, name, env).value;

// Every numeric / flag setting that is SET but unusable (so its default is in force).
// [{ name, raw, message }] - never includes a secret (the registry test forbids secret int/flag).
function invalidSettings(env = process.env) {
  const out = [];
  for (const spec of REGISTRY) {
    if (spec.kind === "string") continue;
    const r = read(spec.name, env);
    if (r.state === "invalid") out.push({ name: spec.name, raw: r.raw, message: r.message, ownWarning: Boolean(spec.ownWarning) });
  }
  return out;
}

// Boot-time report: ONE log line per bad variable, no alert email. Variables whose module already
// prints its own (identical-meaning) line at boot (spec.ownWarning) are skipped here.
function warnInvalid({ env = process.env, log = console } = {}) {
  const bad = invalidSettings(env).filter((b) => !b.ownWarning);
  for (const b of bad) log.warn(`[config] WARNING: ${b.message}`);
  return bad;
}

// Launch validation (src/lib/env.js): the registry's required names and optional groups.
const requiredNames = (env = process.env) => REGISTRY.filter((s) => (typeof s.required === "function" ? s.required(env) : s.required)).map((s) => s.name);
const optionalGroups = () =>
  GROUPS.map((g) => ({ vars: REGISTRY.filter((s) => s.group === g.id).map((s) => s.name), consequence: g.consequence }));

module.exports = {
  get, read, isSet, isProduction, isTest, envInt, envMs, envFlag, envString,
  invalidSettings, warnInvalid, requiredNames, optionalGroups, specFor, REGISTRY, BY_NAME,
};
