#!/usr/bin/env node
/* global document, innerWidth */
// Header width audit (a developer tool; NOT run in CI or by `npm test`).
//
//   node scripts/header-width-audit.js                 every visitor kind (guest, member, admin) x EN/FR x widths 901-2000
//   node scripts/header-width-audit.js --css FILE      measure another version of public/site-header.css (an absolute path)
//   node scripts/header-width-audit.js --strip         measure without the "Wide headers" rules (the natural fit of the one-row header)
//   node scripts/header-width-audit.js --pages /,/cart pages to measure (default: / and /books.html)
//
// For each visitor kind it loads the page, then resizes the window one pixel at a time and reports the widths where the header is
// ONE ROW (the menu is beside the logo, not under it) without overflowing sideways and without the menu links wrapping, as
// intervals, and the width from which that holds all the way to 2000px ("stableOneRowFrom"). The result decides the thresholds of
// the "Wide headers" rules in public/site-header.css; keep a 10px margin and re-run it when a menu link, icon or label changes.
// Starts a throwaway copy of the app (own database, port 6300-6399).
const fs = require("node:fs");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const { Client } = require("pg");
const puppeteer = require("puppeteer");

process.env.SESSION_SECRET = "test-session-secret-not-for-production";
const { startTestApp } = require("../test/helpers/testApp");

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt; };
const CSS_FILE = path.join(__dirname, "..", "public", "site-header.css");
const PAGES = String(opt("pages", "/,/books.html")).split(",");

async function main() {
  const port = 6300 + Math.floor(Math.random() * 90);
  const app = await startTestApp({ port, env: { ANON_SESSION_LIMIT: "100000", GMAIL_USER: "", GMAIL_APP_PASSWORD: "", ANTHROPIC_API_KEY: "" } });
  let browser;
  try {
    const password = `Aa1!${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
    const hash = await bcrypt.hash(password, 10);
    const db = new Client({ connectionString: app.databaseUrl });
    await db.connect();
    for (const [who, admin] of [["member", false], ["admin", true]]) {
      await db.query("INSERT INTO users (email, password_hash, display_name, is_admin, is_member, email_verified_at) VALUES ($1,$2,$3,$4,true,now())", [`${who}@example.test`, hash, who, admin]);
    }
    await db.end();

    const orig = fs.readFileSync(opt("css", CSS_FILE), "utf8");
    const a = orig.indexOf("/* Wide headers"), b = orig.indexOf("/* PHONES.");
    const css = args.includes("--strip") ? orig.slice(0, a) + orig.slice(b) : orig;

    browser = await puppeteer.launch({ headless: true });
    for (const who of ["guest", "member", "admin"]) {
      const context = await browser.createBrowserContext();
      if (who !== "guest") {
        const p = await context.newPage();
        await p.goto(`${app.base}/login`, { waitUntil: "domcontentloaded" });
        await p.type("form[action='/login'] #email", `${who}@example.test`);
        await p.type("form[action='/login'] #password", password);
        await Promise.all([p.waitForNavigation({ waitUntil: "domcontentloaded" }), p.click("form[action='/login'] button[type='submit']")]);
        await p.close();
      }
      for (const lang of ["en", "fr"]) {
        for (const pagePath of PAGES) {
          const page = await context.newPage();
          await page.setRequestInterception(true);
          page.on("request", (r) => (/site-header\.css/.test(r.url()) ? r.respond({ status: 200, contentType: "text/css", body: css }) : r.continue()));
          await page.setViewport({ width: 1280, height: 800 });
          await page.goto(`${app.base}${lang === "fr" ? "/fr" : ""}${pagePath}`, { waitUntil: "networkidle2" });
          const good = new Set();
          for (let w = 901; w <= 2000; w++) {
            await page.setViewport({ width: w, height: 800 });
            const m = await page.evaluate(() => {
              const hd = document.querySelector("header.mkt-header");
              const logo = hd.querySelector(".h-logo").getBoundingClientRect();
              const nav = hd.querySelector(".h-nav").getBoundingClientRect();
              let right = 0;
              for (const e of hd.querySelectorAll(".h-header-row *")) { const r = e.getBoundingClientRect(); if (r.width && r.right > right) right = r.right; }
              const links = [...hd.querySelectorAll(".h-menu-links a")].map((e) => e.getBoundingClientRect());
              return { oneRow: nav.top < logo.bottom - 5, over: right > innerWidth + 0.5 || document.documentElement.scrollWidth > innerWidth, wrapped: links.some((l) => l.top > links[0].top + 5) };
            });
            if (m.oneRow && !m.over && !m.wrapped) good.add(w);
          }
          const intervals = [];
          for (const w of [...good]) { const last = intervals[intervals.length - 1]; if (last && last[1] === w - 1) last[1] = w; else intervals.push([w, w]); }
          let stable = null;
          for (let w = 2000; w >= 901 && good.has(w); w--) stable = w;
          console.log(`${who.padEnd(6)} ${lang} ${pagePath.padEnd(12)} one row at ${intervals.map((i) => i.join("-")).join(" ") || "never"}; stable from ${stable}`);
          await page.close();
        }
      }
      await context.close();
    }
  } finally {
    if (browser) await browser.close();
    await app.stop();
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
