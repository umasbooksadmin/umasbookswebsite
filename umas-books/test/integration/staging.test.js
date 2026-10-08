// Test system (APP_ENV=staging): banner in English and French, noindex,
// robots.txt, empty sitemap, the admin note, and the boot refusals. A second
// app WITHOUT APP_ENV proves a normal site is unchanged.
//
// Ports 4360 (staging) and 4361 (normal) are reserved for this file.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { startTestApp } = require("../helpers/testApp");

let staging, normal;

before(async () => {
  staging = await startTestApp({ port: 4360, isolated: true, env: { APP_ENV: "staging", PREVIEW_MODE: "true", STAGING_MAIL_TO: "me@example.org", HELLOASSO_API_BASE: "https://api.helloasso-sandbox.com/v5" } });
  normal = await startTestApp({ port: 4361, isolated: true, env: { APP_ENV: "", PREVIEW_MODE: "" } });
});
after(async () => {
  await staging.stop();
  await normal.stop();
});

const get = (app, p, lang) => fetch(`${app.base}${p}`, { headers: lang ? { cookie: `umasbooks_lang=${lang}` } : {} });
const bannerOf = (html) => (html.match(/<div class="preview-banner staging-banner"[\s\S]*?<\/div>/) || [""])[0];
const unescape = (s) => s.replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const EN = "TEST SITE: not the real Uma’s Books. Nothing here is real, no email goes to real people and no payment is taken.";
const FR = "SITE DE TEST : ce n’est pas le vrai site d’Uma’s Books. Rien n’est réel ici, aucun e-mail n’est envoyé à de vraies personnes et aucun paiement n’est pris.";

test("staging: banner on every page type, English and French (French typography: no-break space before the colon)", async () => {
  for (const p of ["/", "/books.html", "/membership.html", "/cart", "/login", "/contact", "/no-such-page"]) {
    const en = await (await get(staging, p, "en")).text();
    const fr = await (await get(staging, p, "fr")).text();
    assert.ok(unescape(bannerOf(en)).includes(EN), `${p} en`);
    assert.ok(unescape(bannerOf(fr)).includes(FR), `${p} fr`);
    assert.match(bannerOf(fr), /SITE DE TEST :/, `${p} fr nbsp`);
    assert.match(bannerOf(en), /role="region"/);
    assert.ok(en.indexOf("staging-banner") < en.indexOf("<header"), `${p} banner before header`);
    assert.match(en, /<meta name="robots" content="noindex, nofollow">/, `${p} robots meta`);
    assert.ok(!/preview-banner">/.test(en), `${p}: not the yellow preview banner`);
  }
});

test("staging: X-Robots-Tag noindex, robots.txt disallows all, sitemap is empty", async () => {
  for (const p of ["/", "/robots.txt", "/assets/logo.png", "/no-such-page"]) {
    assert.match((await get(staging, p)).headers.get("x-robots-tag") || "", /noindex/, p);
  }
  assert.equal(await (await get(staging, "/robots.txt")).text(), "User-agent: *\nDisallow: /\n");
  const sm = await (await get(staging, "/sitemap.xml")).text();
  assert.ok(!sm.includes("<url>"));
  assert.ok(sm.includes("<urlset"));
});

test("staging also has the site-wide site.js French string for the banner (language switch on marketing pages)", async () => {
  const js = await (await get(staging, "/assets/site.js")).text();
  assert.ok(js.includes('"staging.text": "TEST SITE: not the real Uma’s Books.'));
  assert.ok(js.includes('"staging.text": "SITE DE TEST : ce n’est pas le vrai site'));
});

test("without APP_ENV: no staging banner, no noindex, robots.txt and sitemap as before", async () => {
  const html = await (await get(normal, "/", "en")).text();
  assert.ok(!html.includes("staging-banner"));
  assert.ok(!html.includes("preview-banner"));
  assert.ok(!/name="robots" content="noindex/.test(html));
  assert.equal((await get(normal, "/")).headers.get("x-robots-tag"), null);
  const robots = await (await get(normal, "/robots.txt")).text();
  assert.ok(!/Disallow: \/\n/.test(robots.replace(/Disallow: \/[a-z]/g, "")));
  assert.match(robots, /Sitemap:/);
});

test("boot: APP_ENV=staging with live HelloAsso credentials exits 1 with a clear message; sandbox credentials pass the guard", () => {
  const run = (extra, script) => spawnSync("node", [script], {
    cwd: path.join(__dirname, "..", ".."),
    env: { ...process.env, APP_ENV: "staging", DATABASE_URL: "postgres://localhost:1/none", PGSSLMODE: "disable", ...extra },
    encoding: "utf8",
    timeout: 20000,
  });
  const live = { HELLOASSO_CLIENT_ID: "a", HELLOASSO_CLIENT_SECRET: "b", HELLOASSO_ORG_SLUG: "c" };
  for (const script of ["src/index.js", "src/migrate.js", "src/seed.js"]) {
    const r = run(live, script);
    assert.equal(r.status, 1, script);
    assert.match(r.stderr, /\[staging\] FATAL: HelloAsso credentials/, script);
  }
  const prod = run({ PRODUCTION_DATABASE_HOST: "dpg-prod123-a", DATABASE_URL: "postgres://u:p@dpg-prod123-a/x" }, "src/migrate.js");
  assert.equal(prod.status, 1);
  assert.match(prod.stderr, /PRODUCTION database host/);
  // sandbox: the guard passes (the process then fails later on the unreachable database, not with the guard message)
  const ok = run({ ...live, HELLOASSO_API_BASE: "https://api.helloasso-sandbox.com/v5" }, "src/migrate.js");
  assert.ok(!/\[staging\] FATAL/.test(ok.stderr));
});
