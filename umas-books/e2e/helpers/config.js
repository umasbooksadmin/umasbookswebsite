// Everything the end-to-end tests read from the environment, in one place.
// Credentials come ONLY from environment variables (never from a file in the
// repository) and are never printed: describeConfig() is the only thing that
// reports on them, and it says "set" / "not set", never a value.

const PERSONAS = ["visitor", "guest", "member", "volunteer", "admin", "edge"];

const truthy = (v) => ["1", "true", "yes"].includes(String(v || "").trim().toLowerCase());

function baseUrl(env = process.env) {
  return String(env.E2E_BASE_URL || "").trim().replace(/\/+$/, "");
}

// A short, sortable tag. run.js creates it once and hands it to every test
// file (each file is its own process); a direct `node --test` run makes one.
function newRunId(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `E2E-${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
}

function runId(env = process.env) {
  return env.E2E_RUN_ID || (env.E2E_RUN_ID = newRunId());
}

// Which personas to run: E2E_ONLY=visitor,guest (empty or unset = all).
function selectedPersonas(env = process.env) {
  const raw = String(env.E2E_ONLY || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!raw.length) return PERSONAS.slice();
  const bad = raw.filter((p) => !PERSONAS.includes(p));
  if (bad.length) throw new Error(`Unknown persona "${bad.join(", ")}". Choose from: ${PERSONAS.join(", ")}.`);
  return PERSONAS.filter((p) => raw.includes(p));
}

// Credentials of a persona that needs them, or { missing: [names] }.
function credentials(persona, env = process.env) {
  const need = {
    member: ["E2E_MEMBER_EMAIL", "E2E_MEMBER_PASSWORD"],
    volunteer: ["E2E_VOLUNTEER_EMAIL", "E2E_VOLUNTEER_PASSWORD"],
    admin: ["E2E_ADMIN_EMAIL", "E2E_ADMIN_PASSWORD"],
  }[persona];
  if (!need) return { email: null, password: null, missing: [] };
  const missing = need.filter((n) => !String(env[n] || "").trim());
  const up = persona.toUpperCase();
  const out = { email: env[`E2E_${up}_EMAIL`], password: env[`E2E_${up}_PASSWORD`], missing };
  if (persona === "admin") {
    out.totpSecret = String(env.E2E_ADMIN_TOTP_SECRET || "").replace(/\s/g, "");
    out.recoveryCode = String(env.E2E_ADMIN_TOTP_RECOVERY || "").trim();
    // An admin cannot get past two-step verification without one of the two.
    if (!out.totpSecret && !out.recoveryCode) missing.push("E2E_ADMIN_TOTP_SECRET");
  }
  return out;
}

// Why a persona's tests are skipped, or null when they can run.
function skipReason(persona, env = process.env) {
  const c = credentials(persona, env);
  if (!c.missing.length) return null;
  return `no credentials: set ${c.missing.join(", ")} to run the ${persona} tests`;
}

const allowWrites = (env = process.env) => truthy(env.E2E_ALLOW_WRITES);

// A placeholder address that can never receive mail, tagged with the run id.
function testEmail(label, env = process.env) {
  const slug = String(label || "x").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `e2e+${runId(env).toLowerCase()}-${slug}@example.invalid`;
}

// What is configured, without any value of a secret.
function describeConfig(env = process.env) {
  const set = (n) => (String(env[n] || "").trim() ? "set" : "not set");
  return {
    baseUrl: baseUrl(env),
    personas: selectedPersonas(env),
    allowWrites: allowWrites(env),
    allowLive: String(env.E2E_ALLOW_LIVE || "") === "1",
    member: set("E2E_MEMBER_EMAIL") === "set" && set("E2E_MEMBER_PASSWORD") === "set" ? "credentials set" : "no credentials",
    volunteer: set("E2E_VOLUNTEER_EMAIL") === "set" && set("E2E_VOLUNTEER_PASSWORD") === "set" ? "credentials set" : "no credentials",
    admin: skipReason("admin", env) ? "no credentials" : "credentials set",
  };
}

module.exports = {
  PERSONAS, truthy, baseUrl, newRunId, runId, selectedPersonas, credentials, skipReason,
  allowWrites, testEmail, describeConfig,
};
