// French law (LCEN, art. 6) requires every site to show who publishes it, who
// is responsible for its content and who hosts it. This pins the legal notice
// page: the facts come from the association's own records (JOAFE notice of
// 1 Sept 2026 and the SIRENE register), and the page must be bilingual and
// reachable from the footer of every page, public and members area alike.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");

const PORT = 3620; // distinct from the other test files' ports
let app;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
});
after(async () => {
  await app.stop();
});

const get = async (path) => {
  const res = await fetch(`${app.base}${path}`);
  return { status: res.status, text: await res.text() };
};

test("the legal notice page shows the publisher, director of publication and host", async () => {
  const { status, text } = await get("/mentions-legales.html");
  assert.equal(status, 200);
  for (const fact of [
    "Uma’s Books",
    "association",
    "5, rue Hippolyte Savary, 81000 Albi",
    "109 441 147 00013", // SIRET
    "109 441 147", // SIREN
    "06 98 95 67 91", // phone (LCEN art. 6: legal entities must give one)
    "W811011706", // RNA
    "law of 1 July 1901", // English wording
    "Sharon Bjeletich",
    "Render Services, Inc.",
    "525 Brannan Street",
    "admin@umasbooks.org",
    "Frankfurt",
  ]) {
    assert.ok(text.includes(fact), `legal notice should include: ${fact}`);
  }
  assert.match(text, /<title[^>]*>[^<]*Legal Notice/);
});

test("the French and English texts cover exactly the same keys", async () => {
  const { text } = await get("/mentions-legales.html");
  const m = text.match(/window\.PAGE_I18N = (\{.*?\});\s*<\/script>/s);
  assert.ok(m, "PAGE_I18N is embedded in the page");
  const i18n = JSON.parse(m[1]);
  const en = Object.keys(i18n.en).sort();
  const fr = Object.keys(i18n.fr).sort();
  assert.deepEqual(fr, en, "every English key has a French one and vice versa");
  assert.ok(en.length >= 14);
  // The French version names the same legal facts.
  const frText = JSON.stringify(i18n.fr);
  for (const fact of ["Directrice de la publication", "Hébergeur", "109 441 147 00013", "W811011706", "Render Services, Inc.", "Téléphone"]) {
    assert.ok(frText.includes(fact), `French notice should include: ${fact}`);
  }
});

test("every public page and the members area link to the legal notice from the footer", async () => {
  for (const path of ["/", "/about.html", "/books.html", "/privacy-policy.html", "/login"]) {
    const { text } = await get(path);
    assert.ok(text.includes('href="/mentions-legales.html"'), `${path} footer should link to /mentions-legales.html`);
  }
});

test("the footer label is translated (English and French)", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const siteJs = fs.readFileSync(path.join(__dirname, "..", "..", "..", "assets", "site.js"), "utf8");
  assert.match(siteJs, /"foot\.legal": "Legal Notice"/);
  assert.match(siteJs, /"foot\.legal": "Mentions légales"/);
});
