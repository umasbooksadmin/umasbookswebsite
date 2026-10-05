// The end-to-end suite (e2e/) drives a real browser against a real URL. This
// file covers ONLY its safety guard and configuration helpers, with a fake
// fetch, so `npm test` never touches a network and never starts the suite.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { evaluateTarget, parseTarget, isLocalHost, looksLikePreview } = require("../../e2e/helpers/guard");
const cfg = require("../../e2e/helpers/config");
const { stepIdOf, manualStepIds, SCRIPT } = require("../../e2e/helpers/steps");

const E2E = path.join(__dirname, "..", "..", "e2e");

// A fake fetch answering "/" like a site would.
const site = ({ noindex = false, banner = false, status = 200 } = {}) => async () => ({
  status,
  headers: new Headers(noindex ? { "x-robots-tag": "noindex, nofollow" } : {}),
  text: async () => (banner ? '<div class="preview-banner" role="region">Preview</div>' : "<html>Home</html>"),
});
const down = async () => { throw new Error("getaddrinfo ENOTFOUND"); };
const check = (url, opts = {}) => evaluateTarget(url, { env: {}, ...opts });

test("local addresses are allowed, by the 'local' rule", async () => {
  for (const url of ["http://localhost:3000", "http://127.0.0.1:55029", "http://[::1]:8080", "http://LOCALHOST"]) {
    const r = await check(url, { fetchFn: down });
    assert.equal(r.allowed, true, url);
    assert.equal(r.rule, "local", url);
  }
});

test("look-alike hosts are not local", async () => {
  for (const url of ["http://localhost.evil.example", "http://127.0.0.1.nip.io", "https://umasbooks.org@evil.example", "http://0.0.0.0:3000", "http://192.168.1.20:3000"]) {
    const r = await check(url, { fetchFn: site() });
    assert.equal(r.allowed, false, url);
  }
  assert.equal(isLocalHost(new URL("http://localhost.evil.example")), false);
});

test("a live site is refused when it is not in preview mode", async () => {
  const r = await check("https://umasbooks.org", { fetchFn: site() });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /Refusing to run/);
  assert.match(r.reason, /E2E_ALLOW_LIVE=1/);
});

test("a site is refused when the preview signs are only half there", async () => {
  assert.equal((await check("https://umasbooks.org", { fetchFn: site({ noindex: true }) })).allowed, false, "noindex header alone");
  assert.equal((await check("https://umasbooks.org", { fetchFn: site({ banner: true }) })).allowed, false, "banner alone");
});

test("a site in preview mode (noindex header and banner) is allowed by the 'preview' rule", async () => {
  const r = await check("https://umasbooks.org", { fetchFn: site({ noindex: true, banner: true }) });
  assert.equal(r.allowed, true);
  assert.equal(r.rule, "preview");
  assert.equal(r.preview, true);
});

test("E2E_ALLOW_LIVE=1 allows a live site, by the 'allow-live' rule; other values do not", async () => {
  const on = await check("https://umasbooks.org", { env: { E2E_ALLOW_LIVE: "1" }, fetchFn: site() });
  assert.deepEqual([on.allowed, on.rule], [true, "allow-live"]);
  for (const v of ["0", "", "true", "yes", "2"]) {
    assert.equal((await check("https://umasbooks.org", { env: { E2E_ALLOW_LIVE: v }, fetchFn: site() })).allowed, false, `E2E_ALLOW_LIVE=${v}`);
  }
});

test("local wins over preview, and preview wins over allow-live (the first rule that applies is reported)", async () => {
  assert.equal((await check("http://localhost:3000", { env: { E2E_ALLOW_LIVE: "1" }, fetchFn: site({ noindex: true, banner: true }) })).rule, "local");
  assert.equal((await check("https://x.example", { env: { E2E_ALLOW_LIVE: "1" }, fetchFn: site({ noindex: true, banner: true }) })).rule, "preview");
});

test("an unreachable live site is refused (it cannot be shown to be safe) unless E2E_ALLOW_LIVE=1", async () => {
  const r = await check("https://umasbooks.org", { fetchFn: down });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /could not reach/);
  assert.equal((await check("https://umasbooks.org", { env: { E2E_ALLOW_LIVE: "1" }, fetchFn: down })).allowed, true);
});

test("a missing, malformed or non-web address is refused", async () => {
  for (const url of ["", undefined, "umasbooks.org", "ftp://localhost", "file:///etc/passwd", "javascript:alert(1)"]) {
    const r = await check(url, { fetchFn: site({ noindex: true, banner: true }) });
    assert.equal(r.allowed, false, String(url));
  }
  assert.equal(parseTarget("https://umasbooks.org").ok, true);
});

test("looksLikePreview needs both the header and the banner", () => {
  const h = (v) => new Headers(v ? { "x-robots-tag": v } : {});
  assert.equal(looksLikePreview({ headers: h("noindex"), html: '<div class="preview-banner">' }).preview, true);
  assert.equal(looksLikePreview({ headers: h("all"), html: '<div class="preview-banner">' }).preview, false);
  assert.equal(looksLikePreview({ headers: h(null), html: "" }).preview, false);
});

// ---- configuration ----

test("a persona without its variables is skipped with a message naming them; guest and edge need none", () => {
  assert.equal(cfg.skipReason("guest", {}), null);
  assert.equal(cfg.skipReason("edge", {}), null);
  assert.match(cfg.skipReason("account", {}), /E2E_ACCOUNT_EMAIL, E2E_ACCOUNT_PASSWORD/);
  assert.equal(cfg.skipReason("account", { E2E_ACCOUNT_EMAIL: "a@b.c", E2E_ACCOUNT_PASSWORD: "x" }), null);
  assert.match(cfg.skipReason("member", {}), /E2E_MEMBER_EMAIL, E2E_MEMBER_PASSWORD/);
  assert.match(cfg.skipReason("volunteer", { E2E_VOLUNTEER_EMAIL: "a@b.c" }), /E2E_VOLUNTEER_PASSWORD/);
  assert.equal(cfg.skipReason("member", { E2E_MEMBER_EMAIL: "a@b.c", E2E_MEMBER_PASSWORD: "x" }), null);
});

test("the admin needs a two-step secret (or a recovery code) as well as email and password", () => {
  const base = { E2E_ADMIN_EMAIL: "a@b.c", E2E_ADMIN_PASSWORD: "x" };
  assert.match(cfg.skipReason("admin", base), /E2E_ADMIN_TOTP_SECRET/);
  assert.equal(cfg.skipReason("admin", { ...base, E2E_ADMIN_TOTP_SECRET: "JBSWY3DPEHPK3PXP" }), null);
  assert.equal(cfg.skipReason("admin", { ...base, E2E_ADMIN_TOTP_RECOVERY: "ABCDE-FGHIJ" }), null);
});

test("describeConfig never contains a secret value", () => {
  const env = {
    E2E_BASE_URL: "http://localhost:3000", E2E_ACCOUNT_EMAIL: "account@example.test", E2E_ACCOUNT_PASSWORD: "S3cret-account-pw!", E2E_MEMBER_EMAIL: "member@example.test", E2E_MEMBER_PASSWORD: "S3cret-member-pw!",
    E2E_ADMIN_EMAIL: "admin@example.test", E2E_ADMIN_PASSWORD: "S3cret-admin-pw!", E2E_ADMIN_TOTP_SECRET: "JBSWY3DPEHPK3PXP", E2E_ADMIN_TOTP_RECOVERY: "ZZZZZ-YYYYY",
  };
  const text = JSON.stringify(cfg.describeConfig(env));
  for (const secret of ["S3cret-account-pw!", "account@example.test", "S3cret-member-pw!", "S3cret-admin-pw!", "JBSWY3DPEHPK3PXP", "ZZZZZ-YYYYY", "member@example.test", "admin@example.test"]) assert.ok(!text.includes(secret), `leaked ${secret}`);
});

test("test e-mail addresses use a placeholder domain and the run tag; writes are off unless E2E_ALLOW_WRITES is set", () => {
  const env = { E2E_RUN_ID: "E2E-20261004-120000" };
  assert.equal(cfg.testEmail("Contact form", env), "e2e+e2e-20261004-120000-contact-form@example.invalid");
  assert.equal(cfg.allowWrites({}), false);
  assert.equal(cfg.allowWrites({ E2E_ALLOW_WRITES: "0" }), false);
  assert.equal(cfg.allowWrites({ E2E_ALLOW_WRITES: "1" }), true);
  assert.match(cfg.newRunId(new Date(Date.UTC(2026, 9, 4, 12, 0, 0))), /^E2E-20261004-120000$/);
});

test("E2E_ONLY selects personas and rejects unknown names", () => {
  assert.deepEqual(cfg.selectedPersonas({}), cfg.PERSONAS);
  assert.deepEqual(cfg.selectedPersonas({ E2E_ONLY: "account, guest" }), ["guest", "account"]);
  assert.throws(() => cfg.selectedPersonas({ E2E_ONLY: "guest,hacker" }), /Unknown persona/);
  assert.deepEqual(cfg.PERSONAS, ["guest", "account", "member", "volunteer", "admin", "edge"], "the five personas plus the edge cases");
  for (const p of cfg.PERSONAS) for (const f of cfg.PERSONA_FILES[p]) assert.ok(fs.existsSync(path.join(E2E, "specs", f)), `${p}: specs/${f} exists`);
});

// ---- the suite stays out of `npm test` and in step with the manual script ----

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "artifacts" ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)]));
}

test("nothing under e2e/ can be picked up by `node --test` (so npm test never runs it against a real site)", () => {
  for (const file of walk(E2E)) {
    const rel = path.relative(path.join(__dirname, "..", ".."), file);
    const base = path.basename(file);
    assert.ok(!/\.test\.(c|m)?js$/.test(base) && !/[-_]test\.(c|m)?js$/.test(base) && !/^test-.*\.js$/.test(base) && base !== "test.js", `${rel} matches a node:test file pattern`);
    assert.ok(!rel.split(path.sep).includes("test"), `${rel} is inside a directory named test`);
  }
});

test("every step of the manual test script has a test (or a manual-only placeholder) in e2e/specs, named with its id", () => {
  const ids = manualStepIds(SCRIPT);
  assert.ok(ids.length > 150, `found only ${ids.length} steps in the manual script`);
  const specDir = path.join(E2E, "specs");
  const named = new Set();
  for (const f of fs.readdirSync(specDir)) {
    const text = fs.readFileSync(path.join(specDir, f), "utf8");
    for (const m of text.matchAll(/["'`]((?:VO|AC|[GMAE])\d+[a-z]?) /g)) named.add(m[1]);
  }
  const missing = ids.filter((id) => !named.has(id));
  assert.deepEqual(missing, [], `steps with no e2e test: ${missing.join(", ")}`);
  assert.equal(stepIdOf("G12 book page shows condition grade"), "G12");
  assert.equal(stepIdOf("AC44 (must) /dashboard is refused"), "AC44");
  assert.equal(stepIdOf("VO3 (must) sign up"), "VO3");
  assert.equal(stepIdOf("A5b (must) x"), "A5b");
});

test("the 'old id -> new id' table at the top of the manual script loses nothing: every new id exists, and no old id is mapped twice", () => {
  const text = fs.readFileSync(SCRIPT, "utf8");
  const ids = new Set(manualStepIds(SCRIPT));
  const pairs = [...text.matchAll(/\|\s*((?:VO|[VGMAE])\d+[a-z]?)\s*\|\s*((?:VO|AC|[GMAE])\d+[a-z]?)\s*(?=\|)/g)].map((m) => [m[1], m[2]]);
  assert.ok(pairs.length > 60, `found only ${pairs.length} rows in the mapping table`);
  const seenOld = new Set();
  for (const [oldId, newId] of pairs) {
    assert.ok(!seenOld.has(oldId), `old id ${oldId} appears twice in the mapping table`);
    seenOld.add(oldId);
    assert.ok(ids.has(newId), `${oldId} maps to ${newId}, which is not a step of the manual script`);
  }
});

test("the manual script and the e2e suite know exactly the five kinds of user (plus edge cases), and the old word 'visitor' is gone", () => {
  const text = fs.readFileSync(SCRIPT, "utf8");
  for (const heading of ["Script 1. Guest", "Script 2. Account holder", "Script 3. Member", "Script 4. Volunteer", "Script 5. Admin", "Script 6. Edge"]) {
    assert.ok(text.includes(`## ${heading}`), `missing "## ${heading}"`);
  }
  assert.ok(!/visitor/i.test(text), "the manual script still says 'visitor'");
  for (const f of walk(E2E)) assert.ok(!/visitor/i.test(fs.readFileSync(f, "utf8")), `${path.relative(E2E, f)} still says 'visitor'`);
});

test("the specs never type into or open a HelloAsso page, and never read credentials from files", () => {
  const specDir = path.join(E2E, "specs");
  for (const f of fs.readdirSync(specDir)) {
    const text = fs.readFileSync(path.join(specDir, f), "utf8");
    assert.ok(!/helloasso\.com\/|helloasso-sandbox\.com\//.test(text.replace(/\/\/.*$/gm, "")), `${f} mentions a HelloAsso address outside comments`);
    assert.ok(!/readFileSync\([^)]*(env|cred|secret|password)/i.test(text), `${f} reads a credentials file`);
  }
});
