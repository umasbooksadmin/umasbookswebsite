"use strict";

// Behaviour-preserving proof for src/lib/config.js: for EVERY setting that was parsed before the
// registry existed, the ORIGINAL parser (copied below verbatim from the code as it was on main
// before the migration, only changed to read an `env` object instead of process.env) is run side
// by side with the new accessor over a matrix of inputs, and the results must be identical
// (same number, same boolean, same string, -0 and NaN included). The only thing the registry
// adds is a warning for a value that is SET but unusable; the last tests pin that.
//
// If a rule in configRegistry.js is changed, a case here fails: that is the point. Do not edit
// the legacy functions to make a test pass; they are the record of what production did.

const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../../src/lib/config");
const { REGISTRY } = require("../../src/lib/configRegistry");

// ---- inputs ------------------------------------------------------------------------------
const INPUTS = [
  undefined, "", " ", "0", "1", "2", "3", "8", "20", "50", "51", "72", "73", "30", "31", "0.25", "0.2",
  "off", "OFF", "Off", "false", "FALSE", "true", "TRUE", " true ", "on", "yes", "YES", "no", "disable", "require", "staging", " Staging ",
  " 5 ", "5.5", "abc", "-1", "-0", "1e3", "1e999", "Infinity", "-Infinity", "NaN", "0x10", "007", "99999999999999999999",
  " off", "off ", " 0 ", " false", "false ", "True", "1 ", " 1", "5abc", "\t3\n", "1000000", "1000001", "999", "1000", "12", "-5", "+5", "1_000", "", "\n",
];
const NODE_ENVS = [undefined, "production", "test", "development"];

const sameValue = (a, b) => Object.is(a, b);
function check(name, input, oldValue, newValue, extra = "") {
  assert.ok(
    sameValue(oldValue, newValue),
    `${name} with ${JSON.stringify(input)}${extra}: the original parser gives ${String(oldValue)} (${typeof oldValue}) but the registry gives ${String(newValue)} (${typeof newValue})`
  );
}

let cases = 0;
// run(name, oldFn(env) -> value, newFn(env) -> value): over every input and NODE_ENV.
function run(name, oldFn, newFn = (env) => config.get(name, env)) {
  for (const nodeEnv of NODE_ENVS) {
    for (const input of INPUTS) {
      const env = {};
      if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
      if (input !== undefined) env[name] = input;
      check(name, input, oldFn(env), newFn(env), nodeEnv ? ` (NODE_ENV=${nodeEnv})` : "");
      cases += 1;
    }
  }
}

// ---- the original parsers (verbatim, env passed in) -------------------------------------------
// src/lib/dbConfig.js parsePoolMax
function oldPoolMax(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return { value: 20 };
  const text = String(raw).trim();
  const n = Number(text);
  if (!/^\d+$/.test(text) || !Number.isInteger(n) || n < 2 || n > 50) {
    return { value: 20, warning: `DB_POOL_MAX="${text}" is not a whole number from 2 to 50; using 20.` };
  }
  return { value: n };
}
// src/lib/adminSession.js readNumber
function oldAdminReadNumber(env, name, fallback, [min, max], warnings) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < min || n > max) {
    warnings.push(`${name}=${JSON.stringify(raw)} is not a number between ${min} and ${max}; using the default (${fallback}).`);
    return fallback;
  }
  return n;
}
// src/lib/trustProxy.js resolveTrustProxyHops
function oldTrustProxy(env) {
  const fallback = env.NODE_ENV === "production" ? 2 : 1;
  const raw = env.TRUST_PROXY_HOPS;
  if (raw === undefined || String(raw).trim() === "") return { hops: fallback, error: null };
  const text = String(raw).trim();
  const n = Number(text);
  if (!/^\d+$/.test(text) || !Number.isInteger(n) || n < 1 || n > 5) {
    return { hops: fallback, error: `TRUST_PROXY_HOPS=${JSON.stringify(text)} is not an integer from 1 to 5; using ${fallback}.` };
  }
  return { hops: n, error: null };
}
// src/lib/aiLimits.js dailyMax and src/lib/bookSources.js isbndbDailyMax
function oldWholeCount(raw, def) {
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : def;
}
// src/lib/pricing/market.js dailyMax
function oldPricingDailyMax(env) {
  const n = parseInt(env.PRICING_AI_DAILY_MAX, 10);
  return Number.isFinite(n) && n >= 0 ? n : 150;
}
// src/lib/anonSessionGuard.js limitFromEnv
function oldAnonLimit(env) {
  const n = Number(String(env.ANON_SESSION_LIMIT || "").trim());
  return Number.isInteger(n) && n >= 1 && n <= 1000000 ? n : 60;
}
// src/lib/till.js maxTillVoidsPerDay
function oldTillVoids(env) {
  const raw = String(env.TILL_MAX_VOIDS_PER_DAY == null ? "" : env.TILL_MAX_VOIDS_PER_DAY).trim();
  return /^\d{1,3}$/.test(raw) ? Number(raw) : 3;
}
// src/lib/bookLookup.js envNumber, src/routes/admin/inventoryLookup.js envMs, src/lib/isbndbPrice.js priceTtl,
// src/routes/admin/dashboard.js countsTtlMs (all the same rule: unset or "" -> default; finite and >= 0)
function oldEnvNumber(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
function oldEnvMs(env, name, fallback) {
  const n = Number(env[name]);
  return env[name] !== undefined && env[name] !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
}
function oldPriceTtl(env) {
  const n = Number(env.ISBNDB_PRICE_TTL_MS);
  return env.ISBNDB_PRICE_TTL_MS !== undefined && env.ISBNDB_PRICE_TTL_MS !== "" && Number.isFinite(n) && n >= 0 ? n : 3 * 24 * 60 * 60 * 1000;
}
function oldDashboardMs(env) {
  const raw = env.DASHBOARD_COUNTS_CACHE_SECONDS;
  if (raw !== undefined && raw !== "" && Number.isFinite(Number(raw)) && Number(raw) >= 0) return Number(raw) * 1000;
  return env.NODE_ENV === "production" ? 30000 : 0;
}
// src/lib/coverStore.js prepareCover (no validation at all)
function oldCoverTtl(env) {
  return env.SCAN_CACHE_TTL_MS === undefined || env.SCAN_CACHE_TTL_MS === "" ? 10 * 60 * 1000 : Number(env.SCAN_CACHE_TTL_MS);
}
// src/lib/bookSources.js isbndbRequest
function oldMinInterval(env) {
  return Number(env.ISBNDB_MIN_INTERVAL_MS) >= 0 && env.ISBNDB_MIN_INTERVAL_MS !== undefined && env.ISBNDB_MIN_INTERVAL_MS !== "" ? Number(env.ISBNDB_MIN_INTERVAL_MS) : 1000;
}
// src/lib/isbndbPrice.js lookupListPrice (opts.timeoutMs unset)
function oldPriceTimeout(env) {
  return Number(env.ISBNDB_PRICE_TIMEOUT_MS) || 6000;
}
// src/lib/timing.js slowThreshold
function oldSlowThreshold(env) {
  const raw = env.SCAN_SLOW_LOG_MS;
  if (raw === undefined || raw === "") return 1500;
  if (String(raw).toLowerCase() === "off") return Infinity;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 1500;
}
// src/lib/outbox.js globalCap (the override part; undefined = use the per-kind cap)
function oldMailGlobal(env) {
  const override = Number(env.MAIL_GLOBAL_PER_HOUR);
  if (Number.isFinite(override) && override > 0) return override;
  return undefined;
}
// src/routes/seo.js booksPerFile
function oldSitemapPerFile(env) {
  const n = Number(env.SITEMAP_BOOKS_PER_FILE);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 20000 / 2) : 20000 / 2;
}

// ---- numbers ------------------------------------------------------------------------------------
test("DB_POOL_MAX: value and warning text are identical", () => {
  run("DB_POOL_MAX", (env) => oldPoolMax(env.DB_POOL_MAX).value);
  for (const input of INPUTS) {
    const old = oldPoolMax(input);
    const now = config.read("DB_POOL_MAX", input === undefined ? {} : { DB_POOL_MAX: input });
    assert.equal(now.state === "invalid" ? now.message : undefined, old.warning, `DB_POOL_MAX warning for ${JSON.stringify(input)}`);
  }
});

test("ADMIN_SESSION_IDLE_HOURS and ADMIN_SESSION_MAX_DAYS: value and warning text are identical", () => {
  for (const [name, def, range] of [["ADMIN_SESSION_IDLE_HOURS", 8, [0.25, 72]], ["ADMIN_SESSION_MAX_DAYS", 7, [1, 30]]]) {
    run(name, (env) => oldAdminReadNumber(env, name, def, range, []));
    for (const input of INPUTS) {
      const env = input === undefined ? {} : { [name]: input };
      const warnings = [];
      oldAdminReadNumber(env, name, def, range, warnings);
      const now = config.read(name, env);
      assert.equal(now.state === "invalid" ? now.message : undefined, warnings[0], `${name} warning for ${JSON.stringify(input)}`);
    }
  }
});

test("TRUST_PROXY_HOPS: value (default by NODE_ENV) and error text are identical", () => {
  run("TRUST_PROXY_HOPS", (env) => oldTrustProxy(env).hops);
  for (const nodeEnv of NODE_ENVS) {
    for (const input of INPUTS) {
      const env = {};
      if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
      if (input !== undefined) env.TRUST_PROXY_HOPS = input;
      const now = config.read("TRUST_PROXY_HOPS", env);
      assert.equal(now.state === "invalid" ? now.message : null, oldTrustProxy(env).error);
    }
  }
});

test("AI_DAILY_MAX_CALLS, ISBNDB_DAILY_MAX_CALLS, PRICING_AI_DAILY_MAX, ANON_SESSION_LIMIT, TILL_MAX_VOIDS_PER_DAY", () => {
  run("AI_DAILY_MAX_CALLS", (env) => oldWholeCount(env.AI_DAILY_MAX_CALLS, 600));
  run("ISBNDB_DAILY_MAX_CALLS", (env) => oldWholeCount(env.ISBNDB_DAILY_MAX_CALLS, 500));
  run("PRICING_AI_DAILY_MAX", oldPricingDailyMax);
  run("ANON_SESSION_LIMIT", oldAnonLimit);
  run("TILL_MAX_VOIDS_PER_DAY", oldTillVoids);
});

test("the SCAN_* durations and ISBNDB_PRICE_TTL_MS (unset or empty -> default, finite and >= 0)", () => {
  for (const [name, def] of [["SCAN_CACHE_TTL_MS", 600000], ["SCAN_NEGATIVE_TTL_MS", 120000], ["SCAN_LOOKUP_TIMEOUT_MS", 4000], ["SCAN_LOOKUP_HEDGE_MS", 1500], ["SCAN_LOOKUP_GRACE_MS", 300]]) {
    run(name, (env) => oldEnvNumber(env, name, def));
  }
  for (const [name, def] of [["SCAN_COVER_WAIT_MS", 1200], ["SCAN_PRICE_WAIT_MS", 3000]]) run(name, (env) => oldEnvMs(env, name, def));
  run("ISBNDB_PRICE_TTL_MS", oldPriceTtl);
});

test("DASHBOARD_COUNTS_CACHE_SECONDS (as milliseconds, default by NODE_ENV)", () => {
  run("DASHBOARD_COUNTS_CACHE_SECONDS", oldDashboardMs, (env) => config.get("DASHBOARD_COUNTS_CACHE_SECONDS", env) * 1000);
});

test("the numbers that keep their own odd rule: coverStore's unvalidated TTL, ISBNDB interval and timeout, SCAN_SLOW_LOG_MS, MAIL_GLOBAL_PER_HOUR, SITEMAP_BOOKS_PER_FILE", () => {
  run("SCAN_CACHE_TTL_MS", oldCoverTtl, (env) => config.get("SCAN_CACHE_TTL_MS", env, { lenient: true }));
  run("ISBNDB_MIN_INTERVAL_MS", oldMinInterval);
  run("ISBNDB_PRICE_TIMEOUT_MS", oldPriceTimeout);
  run("SCAN_SLOW_LOG_MS", oldSlowThreshold);
  run("MAIL_GLOBAL_PER_HOUR", oldMailGlobal);
  run("SITEMAP_BOOKS_PER_FILE", oldSitemapPerFile, (env) => Math.min(config.get("SITEMAP_BOOKS_PER_FILE", env), 20000 / 2));
});

// ---- on/off flags --------------------------------------------------------------------------------
test("flags: PREVIEW_MODE, PRICING_AI, COVER_BACKFILL, AWARDS_LOOKUPS, ADMIN_2FA_REQUIRED, PGSSLMODE, SEED_*, DEMO_*", () => {
  const trimLowerOneOrTrue = (name) => (env) => {
    const v = String((env && env[name]) || "").trim().toLowerCase();
    return v === "1" || v === "true";
  };
  // DELIBERATE CHANGE (Review C, C-L1): PREVIEW_MODE used to be "1" or "true" -> on, anything else -> off, so a
  // typo ("yes", "on", "enabled") silently made the site LIVE. Now: on-words and off-words are recognised
  // (any case, trimmed), blank is off, and any OTHER value is ON (fail closed) and reported by invalidSettings().
  // This is the only flag with a different rule from the original parser; the rule is pinned right here.
  run("PREVIEW_MODE", (env) => {
    const v = String((env && env.PREVIEW_MODE) || "").trim().toLowerCase();
    if (v === "") return false;
    if (["0", "false", "off", "no", "disabled"].includes(v)) return false;
    return true; // 1, true, on, yes, enabled, and every unrecognised value
  });
  run("PRICING_AI", trimLowerOneOrTrue("PRICING_AI"));
  run("COVER_BACKFILL", (env) => env.COVER_BACKFILL !== "off");
  run("AWARDS_LOOKUPS", (env) => !/^(off|0|false)$/i.test(String(env.AWARDS_LOOKUPS || "").trim()));
  run("ADMIN_2FA_REQUIRED", (env) => env.ADMIN_2FA_REQUIRED !== "false");
  run("PGSSLMODE", (env) => env.PGSSLMODE === "disable");
  run("SEED_SAMPLE_CONTENT", (env) => env.SEED_SAMPLE_CONTENT === "true");
  run("SEED_STRICT", (env) => env.SEED_STRICT === "true");
  run("DEMO_ALLOW_LOCAL", (env) => String(env.DEMO_ALLOW_LOCAL || "").trim() === "1");
  run("DEMO_CONFIRM", (env) => String(env.DEMO_CONFIRM || "").trim().toLowerCase() === "yes");
});

test("an env of null / undefined (isPreviewMode(null) was legal) reads as nothing set", () => {
  assert.equal(config.get("PREVIEW_MODE", null), false);
  assert.equal(config.get("APP_ENV", null), "");
});

// ---- text -------------------------------------------------------------------------------------------
test("text settings: the original `a || b`, String(a || \"\").trim() ... expressions", () => {
  const D = "admin@umasbooks.org";
  run("PORT", (env) => env.PORT || 3000);
  run("CONTACT_TO", (env) => env.CONTACT_TO || D);
  run("SEED_ADMIN_EMAIL", (env) => (env.SEED_ADMIN_EMAIL || D).trim());
  run("ALERT_TO", (env) => (env.ALERT_TO || "").trim());
  run("APP_ENV", (env) => String((env && env.APP_ENV) || "").trim().toLowerCase());
  run("STAGING_MAIL_TO", (env) => String(env.STAGING_MAIL_TO || "").trim());
  run("PRODUCTION_DATABASE_HOST", (env) => String(env.PRODUCTION_DATABASE_HOST || "").trim().toLowerCase());
  run("HELLOASSO_MEMBERSHIP_FORM_SLUG", (env) => (env.HELLOASSO_MEMBERSHIP_FORM_SLUG || "").trim().toLowerCase());
  run("ISBNDB_API_BASE", (env) => String(env.ISBNDB_API_BASE || "").trim());
  run("SCAN_LOOKUP_SOURCES", (env) => String(env.SCAN_LOOKUP_SOURCES || "openlibrary,bnf,google,openlibrary-data,isbndb"));
  run("DEMO_PASSWORD", (env) => String(env.DEMO_PASSWORD || ""));
  run("FISCAL_YEAR_START_MONTH", (env) => env.FISCAL_YEAR_START_MONTH || 1);
  run("DUMP_FILE", (env) => env.DUMP_FILE || "/tmp/i18n-fr-dump.txt");
  run("DUMP_EN_FILE", (env) => env.DUMP_EN_FILE || "/tmp/i18n-en-dump.txt");
  // raw reads (no default): the value comes back untouched, "" included
  for (const name of ["DATABASE_URL", "SESSION_SECRET", "TOTP_ENCRYPTION_KEY", "GMAIL_USER", "GMAIL_APP_PASSWORD", "APP_BASE_URL", "RENDER_EXTERNAL_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_WORKSPACE_ID", "PRICING_AI_MODEL", "NYT_API_KEY", "GOOGLE_BOOKS_API_KEY", "ISBNDB_API_KEY", "HELLOASSO_CLIENT_ID", "HELLOASSO_CLIENT_SECRET", "HELLOASSO_ORG_SLUG", "HELLOASSO_API_BASE", "SEED_ADMIN_PASSWORD", "NODE_ENV", "CI", "GITHUB_OUTPUT", "DEBUG_BLOBS"]) {
    run(name, (env) => env[name]);
  }
});

test("compound readings: ALERT_TO falls back to CONTACT_TO then the shop address; isSet; the base-URL fallbacks", () => {
  const legacyAlert = (env) => (env.ALERT_TO || "").trim() || env.CONTACT_TO || "admin@umasbooks.org";
  const newAlert = (env) => config.get("ALERT_TO", env) || config.get("CONTACT_TO", env);
  const words = [undefined, "", " ", "a@b.c", " a@b.c ", "x@y.z,u@v.w"];
  for (const a of words) for (const c of words) {
    const env = {};
    if (a !== undefined) env.ALERT_TO = a;
    if (c !== undefined) env.CONTACT_TO = c;
    check("ALERT_TO/CONTACT_TO", `${JSON.stringify(a)}/${JSON.stringify(c)}`, legacyAlert(env), newAlert(env));
    cases += 1;
  }
  const legacyIsSet = (env, name) => typeof env[name] === "string" && env[name].trim() !== "";
  for (const input of INPUTS) {
    const env = input === undefined ? {} : { DATABASE_URL: input };
    check("isSet", input, legacyIsSet(env, "DATABASE_URL"), config.isSet("DATABASE_URL", env));
    cases += 1;
  }
});

// ---- the only new behaviour: a warning for a value that is set but unusable -------------------------
test("a warning is reported for a set-but-unusable number or flag, never for unset / blank, and never quotes a secret", () => {
  for (const spec of REGISTRY) {
    if (spec.kind === "string") continue;
    assert.equal(spec.secret, false, `${spec.name}: a secret must be a string setting (messages quote the bad value)`);
    for (const input of INPUTS) {
      const env = input === undefined ? {} : { [spec.name]: input };
      const r = config.read(spec.name, env);
      if (r.state === "invalid") {
        assert.ok(input !== undefined && String(input) !== "", `${spec.name} warns about an unset/empty value`);
        assert.match(r.message, new RegExp(`^${spec.name}`), "the message starts with the variable name");
        assert.ok(/using|treating/.test(r.message), "the message says what is used instead");
      }
    }
  }
  assert.deepEqual(config.invalidSettings({}), [], "an empty environment reports nothing");
  const bad = config.invalidSettings({ PREVIEW_MODE: "yse", SCAN_SLOW_LOG_MS: "fast", AI_DAILY_MAX_CALLS: "lots" }).map((b) => b.name);
  assert.deepEqual(bad, ["PREVIEW_MODE", "AI_DAILY_MAX_CALLS", "SCAN_SLOW_LOG_MS"]);
});

test("warnInvalid logs one line per bad variable and skips the ones whose module already warns", () => {
  const lines = [];
  const bad = config.warnInvalid({ env: { PREVIEW_MODE: "yse", DB_POOL_MAX: "x", AI_DAILY_MAX_CALLS: "lots" }, log: { warn: (l) => lines.push(l) } });
  assert.deepEqual(bad.map((b) => b.name), ["PREVIEW_MODE", "AI_DAILY_MAX_CALLS"]);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.startsWith("[config] WARNING: ")));
  assert.deepEqual(config.warnInvalid({ env: { PREVIEW_MODE: "true", AI_DAILY_MAX_CALLS: "0" }, log: { warn: () => assert.fail("nothing to warn about") } }), []);
});

test("the generic helpers (for a one-off variable) use the same engines", () => {
  assert.equal(config.envInt("X_COUNT", { default: 5, integer: true, min: 1, max: 9 }, { X_COUNT: "7" }), 7);
  assert.equal(config.envInt("X_COUNT", { default: 5, integer: true, min: 1, max: 9 }, { X_COUNT: "70" }), 5);
  assert.equal(config.envInt("X_COUNT", { default: 5 }, {}), 5);
  assert.equal(config.envMs("X_WAIT_MS", { default: 100, min: 0 }, { X_WAIT_MS: "250" }), 250);
  assert.equal(config.envFlag("X_ON", { default: false, onWords: ["1"], offWords: ["0"] }, { X_ON: "1" }), true);
  assert.equal(config.envFlag("X_ON", { default: true, onWords: ["1"], offWords: ["0"] }, { X_ON: "0" }), false);
  assert.equal(config.envString("X_NAME", { default: "d", trim: true }, { X_NAME: "  v " }), "v");
  assert.equal(config.envString("X_NAME", { default: "d" }, { X_NAME: "" }), "d");
  assert.throws(() => config.get("NOT_A_DECLARED_SETTING", {}), /Unknown setting NOT_A_DECLARED_SETTING/);
});

test("the matrix really ran (guards against a silently empty loop)", () => {
  assert.ok(cases > 5000, `only ${cases} cases ran`);
});
