// The French audit: every customer-facing page as every persona, the form posts, the JSON
// APIs and the emails, in English and French, and the English text still left on the French
// side. Run from umas-books/ (needs a local Postgres: it makes and drops a throwaway database):
//
//   node scripts/i18n-audit.js              print the pages with English still in them (and a total)
//   node scripts/i18n-audit.js --write      also refresh the counts table in docs/i18n-audit.md
//   node scripts/i18n-audit.js --dump       write every French text to /tmp/i18n-fr-dump.txt (DUMP_FILE=...)
//   node scripts/i18n-audit.js --dump-en    write the English text of every page (DUMP_EN_FILE=...):
//                                           diff two of these to prove English did not change
const fs = require("node:fs");
const path = require("node:path");
const { startTestApp } = require("../test/helpers/testApp");
const { crawl, captureEnv } = require("../test/helpers/i18nCrawl");
const { ALLOW } = require("../test/i18n-allowlist");

const AREAS = [
  ["Shared chrome and error pages", (p) => /^(\/|\/this-page-does-not-exist)$/.test(p) || /CSRF|admin page as a customer|members-only page|volunteer page as a member|500 page/.test(p)],
  ["Marketing and legal pages (.html)", (p) => /^\/[a-z-]+\.html$/.test(p)],
  ["Catalogue, book pages, favourites, cart, reservations", (p) => /^\/(books\/|favorites|cart)/.test(p) || /POST cart|after reserve|cart with|cart after|account after/.test(p)],
  ["Sign up, log in, account, privacy, two-step", (p) => /^\/(login|signup|forgot|reset|verify|account)/.test(p) || /POST (login|signup|membership|forgot|reset|resend|verify|2FA|change password|privacy)/.test(p)],
  ["Events, sessions, forum, meetings, volunteers, charity, dashboard", (p) => /^\/(events|sessions|immersion|forum|meetings|volunteer|charity|dashboard|announcements)/.test(p) || /POST (event|forum|charity|meeting|volunteer)/.test(p)],
  ["Contact and book requests", (p) => /^\/(contact|request-a-book|my-requests)/.test(p) || /POST (contact|request|find)/.test(p)],
  ["JSON APIs and downloads", (p) => /\((json)\)|event ics/.test(p)],
  ["Emails sent to customers", (p) => /^EMAIL /.test(p)],
];

(async () => {
  const app = await startTestApp({ port: 3697, isolated: true, env: captureEnv() });
  let result;
  try {
    result = await crawl(app, { allow: ALLOW });
  } finally {
    await app.stop();
  }
  const flagged = result.pages.map((p) => ({ ...p, items: p.items.filter((i) => !i.allowed) }));
  if (process.argv.includes("--dump")) {
    const seen = new Set();
    const out = [];
    for (const p of result.pages) for (const t of p.texts) if (!seen.has(t)) { seen.add(t); out.push(`${p.persona} ${p.path}\t${t}`); }
    fs.writeFileSync(process.env.DUMP_FILE || "/tmp/i18n-fr-dump.txt", out.join("\n"));
  }
  if (process.argv.includes("--dump-en")) {
    const out = [];
    for (const p of result.pages) out.push(`## ${p.persona} ${p.path.replace(/order=[0-9a-f-]{36}/, "order=X")}`, ...(p.enTexts || []).filter((t) => !/^[A-Z2-7]{32}$/.test(t)));
    fs.writeFileSync(process.env.DUMP_EN_FILE || "/tmp/i18n-en-dump.txt", out.join("\n"));
  }

  // Each page goes to the first area that claims it (anything unclaimed counts under "Other").
  const areaOf = (page) => (AREAS.find(([, test]) => test(page.path.replace(/^POST /, "")) || test(page.path)) || ["Other"])[0];
  const byArea = new Map([...AREAS.map(([n]) => n), "Other"].map((n) => [n, { name: n, pages: 0, texts: new Set(), left: 0, allowed: new Set() }]));
  for (const page of result.pages) {
    const r = byArea.get(areaOf(page));
    r.pages += 1;
    page.texts.forEach((t) => r.texts.add(t));
    r.left += page.items.filter((i) => !i.allowed).length;
    page.items.filter((i) => i.allowed).forEach((i) => r.allowed.add(i.text));
  }
  const rows = [...byArea.values()].filter((r) => r.pages).map((r) => ({ ...r, texts: r.texts.size, allowed: r.allowed.size }));
  const total = flagged.reduce((n, p) => n + p.items.length, 0);

  const lines = [];
  for (const p of flagged) {
    lines.push(`${p.persona.padEnd(9)} ${p.path} [${p.status}${p.htmlLang ? " lang=" + p.htmlLang : ""}] ${p.items.length}`);
    for (const i of p.items) lines.push(`      - (${i.reason}) ${i.text}`);
  }
  lines.push(`TOTAL flagged: ${total}`);
  console.log(lines.join("\n"));

  if (process.argv.includes("--write")) {
    const doc = path.join(__dirname, "..", "..", "docs", "i18n-audit.md");
    const table = [
      "| Area | Pages / messages crawled | Distinct French texts read | English left | Allow-listed (distinct) |",
      "|------|-------------------------:|---------------------------:|-------------:|-------------:|",
      ...rows.map((r) => `| ${r.name} | ${r.pages} | ${r.texts} | ${r.left} | ${r.allowed} |`),
      `| **Total** | **${flagged.length}** | **${new Set(flagged.flatMap((p) => p.texts)).size}** | **${total}** | **${new Set(result.pages.flatMap((p) => p.items.filter((i) => i.allowed).map((i) => i.text))).size}** |`,
      "",
      `Generated by \`node scripts/i18n-audit.js --write\` on ${new Date().toISOString().slice(0, 10)}.`,
    ].join("\n");
    const src = fs.readFileSync(doc, "utf8");
    fs.writeFileSync(doc, src.replace(/<!-- audit:start -->[\s\S]*<!-- audit:end -->/, `<!-- audit:start -->\n${table}\n<!-- audit:end -->`));
  }
})().catch((e) => { console.error(e); process.exit(1); });
