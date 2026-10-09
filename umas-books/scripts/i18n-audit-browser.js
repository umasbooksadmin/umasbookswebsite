/* global document */
// The browser half of the French audit: loads the pages whose text is built by JavaScript (home slider,
// books search and genres, events list, favourites, blog, calendars) in a real headless Chrome, in
// English and in French, and reports English still on the French page. Also presses the FR toggle.
// Not part of `npm test` (needs Chrome: puppeteer's, `npx puppeteer browsers install chrome`).
//   node scripts/i18n-audit-browser.js
// Known and expected: the blog posts are stored in English only (docs/i18n-audit.md, question 5);
// "Fiction" and "Romance" are French words too.
const puppeteer = require("puppeteer");
const { startTestApp } = require("../test/helpers/testApp");
const { seed, findEnglish } = require("../test/helpers/i18nCrawl");
const { ALLOW } = require("../test/i18n-allowlist");
(async () => {
  const app = await startTestApp({ port: 3696, isolated: true });
  try {
    const s = await seed(app);
    const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
    const pages = ["/", "/books.html", "/events.html", "/programs.html", "/blog.html", "/favorites", `/books/${s.bookId}`, "/sessions", "/immersion.html", "/membership.html"];
    const shot = async (lang, p) => {
      const page = await browser.newPage();
      await page.setCookie({ name: "umasbooks_lang", value: lang, url: app.base });
      await page.evaluateOnNewDocument((id) => { try { localStorage.setItem("umasbooks.favorites", JSON.stringify([id])); localStorage.setItem("umasbooks.lang", ""); } catch { /* none */ } }, s.bookId);
      await page.goto(app.base + p, { waitUntil: "networkidle0", timeout: 30000 }).catch(() => {});
      // exercise the books search and the genre buttons
      if (p === "/books.html") {
        await page.type("#bk-search, input[type=search]", "Crawl").catch(() => {});
        await page.keyboard.press("Enter").catch(() => {});
        await new Promise((r) => setTimeout(r, 1500));
      }
      await new Promise((r) => setTimeout(r, 800));
      const html = await page.evaluate(() => document.documentElement.outerHTML);
      const lang2 = await page.evaluate(() => document.documentElement.lang);
      await page.close();
      return { html, lang: lang2 };
    };
    // toggle test: load in en, press FR, compare with a fresh fr load
    for (const p of pages) {
      const en = await shot("en", p), fr = await shot("fr", p);
      const found = findEnglish(en.html, fr.html, ALLOW).filter((i) => !i.allowed);
      console.log(`${p} lang=${fr.lang} English left: ${found.length}`);
      for (const f of found) console.log("   -", f.reason, "|", f.text.slice(0, 120));
    }
    // the toggle: press FR on an English-loaded page
    const page = await browser.newPage();
    await page.goto(app.base + "/books.html", { waitUntil: "networkidle0" });
    await page.evaluate(() => { const b = [...document.querySelectorAll("button, a")].find((x) => /^FR$/.test(x.textContent.trim())); if (b) b.click(); });
    await new Promise((r) => setTimeout(r, 1000));
    const after = await page.evaluate(() => ({ lang: document.documentElement.lang, h1: (document.querySelector("h1") || {}).textContent, cookie: document.cookie }));
    console.log("toggle:", JSON.stringify(after));
    await browser.close();
  } finally {
    await app.stop();
  }
})().catch((e) => { console.error(e); process.exit(1); });
