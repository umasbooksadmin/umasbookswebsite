#!/usr/bin/env node
/* global document, getComputedStyle */
// Phone overflow audit (a developer tool; NOT run in CI or by `npm test`).
//
//   node scripts/phone-overflow-audit.js                  all pages, all widths, EN + FR
//   node scripts/phone-overflow-audit.js --only admin     only public | admin | member
//   node scripts/phone-overflow-audit.js --widths 320,375 --lang en
//   node scripts/phone-overflow-audit.js --page /admin/orders   only pages whose address contains this text
//   node scripts/phone-overflow-audit.js --desktop DIR   only save 1280x800 screenshots of every page (compare two runs)
//   node scripts/phone-overflow-audit.js --shots DIR      also saves a screenshot of every page that overflows
//   node scripts/phone-overflow-audit.js --shots DIR --all-shots   screenshot every page
//
// It starts a throwaway copy of the app (own database, a port between 6200 and 6299)
// with sample data that is hostile to phone layouts (a book whose title is 90 letters
// with no space, a 41-letter word, a long reservation name...), then opens every page
// in headless Chrome with a phone profile (touch, mobile viewport) at 320, 360, 375,
// 390 and 430 px wide plus 844x390 (a phone turned sideways) and reports
//   - pages where documentElement.scrollWidth > innerWidth, and
//   - elements whose right edge is past the screen (unless inside a region that scrolls
//     sideways on purpose: an ancestor with overflow-x auto/scroll/hidden/clip).
// Exit code 1 when anything is found. The permanent checks are the e2e steps G82 and
// A102 (e2e/specs) and test/integration/phoneOverflowCss.test.js.

const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const { Client } = require("pg");
const puppeteer = require("puppeteer");

process.env.SESSION_SECRET = "test-session-secret-not-for-production";
const { startTestApp } = require("../test/helpers/testApp");

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt; };
const has = (name) => args.includes(`--${name}`);

const WIDTHS = String(opt("widths", "320,360,375,390,430,844x390")).split(",").map((w) => {
  const [width, height] = w.split("x").map(Number);
  return { width, height: height || 800, label: height ? `${width}x${height}` : String(width) };
});
const LANGS = String(opt("lang", "en,fr")).split(",");
const ONLY = opt("only", "all");
const SHOTS = opt("shots", "");
const DESKTOP = opt("desktop", ""); // save a 1280 px wide screenshot of every page here (to compare before/after a CSS change), then stop
const PAGE_FILTER = opt("page", ""); // only pages whose address contains this text

const LONG_TITLE = "Averyveryveryverylongtitlewithoutanyspacesatallsothatitcannotbreakanywhereandkeepsgoingandgoing".slice(0, 90); // 90 letters, no space
const WORD_41 = "Pneumonoultramicroscopicsilicovolcanoconiosis".slice(0, 41); // a 41-letter word


const freePort = async () => {
  for (let p = 6200; p < 6300; p++) {
    const ok = await new Promise((resolve) => {
      const s = net.createServer();
      s.once("error", () => resolve(false));
      s.listen(p, "127.0.0.1", () => s.close(() => resolve(true)));
    });
    if (ok) return p;
  }
  throw new Error("no free port in 6200-6299");
};

const days = (n) => new Date(Date.now() + n * 86400000).toISOString();

async function seed(databaseUrl, creds) {
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    return await seedWith(db, creds);
  } finally {
    await db.end().catch(() => {});
  }
}

async function seedWith(db, creds) {
  const ids = {};
  const user = async (key, name, flags) => {
    const hash = await bcrypt.hash(creds[key].password, 10);
    const { rows } = await db.query(
      `INSERT INTO users (email, password_hash, display_name, is_admin, is_member, is_volunteer, email_verified_at)
       VALUES ($1,$2,$3,$4,$5,$6, now()) RETURNING id`,
      [creds[key].email, hash, name, !!flags.admin, !!flags.member, !!flags.volunteer]
    );
    ids[key] = rows[0].id;
  };
  await user("admin", "Audit Admin", { admin: true, member: true, volunteer: true });
  await user("member", "Audit Member", { member: true });
  await user("volunteer", "Audit Volunteer", { volunteer: true, member: true });
  await user("account", "Audit Account", {});

  const book = async (title, author, description, price = 6, genres = "Fiction") => {
    const { rows } = await db.query(
      "INSERT INTO books (title, authors, categories, categories_fr, binding, description, description_fr) VALUES ($1,$2,$3,$3,'trade',$4,$4) RETURNING id",
      [title, author, genres, description]
    );
    await db.query("INSERT INTO book_copies (book_id, condition, price, status, location, source) VALUES ($1,'very_good',$2,'in_stock','Shelf A','donation')", [rows[0].id, price]);
    return rows[0].id;
  };
  ids.longTitle = await book(LONG_TITLE, `${LONG_TITLE.slice(0, 40)} Author`, `${LONG_TITLE} ${WORD_41}`);
  ids.longWord = await book(`The ${WORD_41} Story`, WORD_41, `A description with ${WORD_41} inside it, and https://example.org/${"a".repeat(80)}`);
  ids.https = await book("https://example.org/a-very-long-link-used-as-a-title/" + "x".repeat(37), "Some Author", "Plain.");
  ids.normal = await book("A Perfectly Normal Title", "Normal Author", "A sample book.");
  for (let i = 0; i < 6; i++) await book(`Filler book number ${i}`, "Filler Author", "Filler.", 4 + i, i % 2 ? "Fiction, Classics" : "Mystery");

  // reservations (admin /admin/orders)
  const reserve = async (name, email, status, title) => {
    const { rows: o } = await db.query(
      `INSERT INTO orders (buyer_name, buyer_email, total_amount, status, lang, reserved_until, user_id)
       VALUES ($1,$2,12,$3,'en', now() + interval '10 days', $4) RETURNING id`, [name, email, status, ids.account]
    );
    const { rows: b } = await db.query("INSERT INTO books (title, authors) VALUES ($1,'Res Author') RETURNING id", [title]);
    const { rows: c } = await db.query(
      "INSERT INTO book_copies (book_id, status, price, cart_order_id, reserved_by_email, reserved_by_name, reserved_at) VALUES ($1,'reserved',12,$2,$3,$4,now()) RETURNING id",
      [b[0].id, o[0].id, email, name]
    );
    await db.query("INSERT INTO order_items (order_id, book_copy_id, item_title, price) VALUES ($1,$2,$3,12)", [o[0].id, c[0].id, title]);
    return o[0].id;
  };
  ids.order = await reserve("Margarethe Wilhelmina Hohenzollern-Sigmaringen", `a-long-address.${"x".repeat(40)}@example.test`, "reserved", LONG_TITLE);
  await reserve("Short Name", "short@example.test", "reserved", "Short");
  await db.query("UPDATE book_copies SET status='sold' WHERE id IN (SELECT book_copy_id FROM order_items WHERE order_id=$1)", [ids.order]).catch(() => {});
  await db.query("UPDATE book_copies SET status='reserved' WHERE id IN (SELECT book_copy_id FROM order_items WHERE order_id=$1)", [ids.order]);

  // events / sessions / calendar items: several on the same days so the month grid has events
  for (let i = 1; i <= 8; i++) {
    await db.query("INSERT INTO events (title, description, location, starts_at, ends_at, capacity) VALUES ($1,'Sample','Albi',$2,$3,10)",
      [i === 1 ? `Event ${WORD_41} ${LONG_TITLE}` : `A rather long event title that needs room, number ${i}`, days(i * 3), days(i * 3 + 0.1)]);
  }
  await db.query("INSERT INTO classes (title, description, location, starts_at, ends_at, capacity, dropin_price, program_type) VALUES ('Drop-in',  'Sample','Albi',$1,$2,6,8,'dropin')", [days(2), days(2.1)]);
  for (let i = 1; i <= 6; i++) {
    await db.query("INSERT INTO meetings (title, scheduled_at, location, agenda) VALUES ($1,$2,'Albi','Agenda')", [i === 1 ? `Meeting ${LONG_TITLE}` : `Board meeting about the spring programme ${i}`, days(i * 2 + 1)]);
    await db.query("INSERT INTO volunteer_shifts (role, starts_at, ends_at, capacity) VALUES ($1,$2,$3,2)", [i === 1 ? `Shelf stacking ${WORD_41}` : `Welcome desk and shelf stacking ${i}`, days(i * 2), days(i * 2 + 0.1)]);
  }
  await db.query("INSERT INTO blog_posts (title, body, slug, excerpt, status, published_at) VALUES ($1,$2,'audit-post',$3,'published',now())", [`Post ${LONG_TITLE}`, `<p>${WORD_41} ${LONG_TITLE}</p>`, `${WORD_41} ${LONG_TITLE}`]);
  await db.query("INSERT INTO announcements (title, body, created_by) VALUES ($1,$2,$3)", [`News ${LONG_TITLE}`, `${WORD_41} ${LONG_TITLE}`, ids.admin]);
  const { rows: th } = await db.query("INSERT INTO forum_threads (title, body, author_id) VALUES ($1,$2,$3) RETURNING id", [`Thread ${LONG_TITLE}`, `${WORD_41} ${LONG_TITLE}`, ids.member]);
  ids.thread = th[0].id;
  const { rows: round } = await db.query("INSERT INTO charity_rounds (title, is_active) VALUES ('Audit vote', TRUE) RETURNING id");
  await db.query("INSERT INTO charity_options (round_id, name, description) VALUES ($1,$2,$3)", [round[0].id, `Charity ${LONG_TITLE}`, WORD_41]);
  return ids;
}

const PUBLIC_PAGES = [
  "/", "/about.html", "/books.html", "/events.html", "/programs.html", "/immersion.html", "/membership.html", "/visit.html",
  "/volunteer.html", "/pre-registration.html", "/blog.html", "/privacy-policy.html", "/terms-of-sale.html", "/mentions-legales.html",
  "/membership-terms.html", "/sessions", "/events", "/contact", "/request-a-book", "/cart", "/login", "/signup", "/forgot-password", "/favorites",
];
const bookPages = (ids) => [`/books/${ids.longTitle}`, `/books/${ids.longWord}`, `/books/${ids.https}`, `/books/${ids.normal}`];
const MEMBER_PAGES = (ids) => ["/dashboard", "/announcements", "/charity", "/forum", "/forum/new", `/forum/${ids.thread}`, "/meetings", "/account", "/change-password"];
const VOLUNTEER_PAGES = ["/volunteer"];
const ADMIN_PAGES = (ids) => [
  "/admin", "/admin/inventory", "/admin/inventory?q=" + "Averyvery", "/admin/inventory/new", `/admin/inventory/${ids.longTitle}`, "/admin/inventory/scan", "/admin/inventory/move",
  "/admin/orders", `/admin/orders/${ids.order}`, "/admin/orders/pickup-list", "/admin/members", `/admin/members?view=${ids.account}`, "/admin/blog", "/admin/announcements",
  "/admin/events", "/admin/sessions", "/admin/meetings", "/admin/volunteer-shifts", "/admin/charity", "/admin/requests", "/admin/reports",
  "/admin/reports/accounting/mapping", "/admin/audit", "/admin/email-outbox", "/admin/privacy", "/admin/pricing", "/admin/pricing/settings", "/admin/pricing/review",
  "/admin/till", "/admin/till/day", "/admin/till/items", "/admin/diagnostics/jobs", "/admin/diagnostics/lookup", "/admin/diagnostics/client-ip",
];

// Runs inside the page. Returns { sw, iw, offenders: [...] }.
function measure(iw) {
  // iw is the width the phone really has: a mobile browser widens window.innerWidth to fit wide content,
  // so innerWidth itself would hide the very problem.
  const out = [];
  const scrollsSideways = (el) => {
    for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      if (/auto|scroll|hidden|clip/.test(getComputedStyle(a).overflowX)) return true;
    }
    return false;
  };
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    if (cs.position === "fixed" || cs.display === "none" || cs.visibility === "hidden") continue;
    if (el.closest("svg") && el.tagName !== "svg") continue;
    const b = el.getBoundingClientRect();
    if (!(b.width > 0 && b.height > 0 && b.right > iw + 1)) continue;
    if (scrollsSideways(el)) continue;
    if (el.closest("[aria-hidden='true'], [hidden]")) continue;
    // content of a closed <details> (a menu, a pill) is not on screen
    const det = el.closest("details:not([open])");
    if (det && !(el.closest("summary") && el.closest("summary").parentElement === det)) continue;
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    out.push(`${el.tagName.toLowerCase()}${id}${cls} right=${Math.round(b.right)}`);
  }
  // Text clipped by its own box (a word wider than its container with overflow hidden).
  const clipped = [];
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    if (/hidden|clip/.test(cs.overflowX) && cs.textOverflow !== "ellipsis" && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 8 && !/^(HTML|BODY)$/.test(el.tagName) && el.children.length === 0 && el.textContent.trim()) {
      const cls = typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
      clipped.push(`${el.tagName.toLowerCase()}${cls} text clipped (${el.scrollWidth} > ${el.clientWidth})`);
    }
  }
  return { sw: document.documentElement.scrollWidth, iw, offenders: out.slice(0, 6), clipped: clipped.slice(0, 4) };
}

async function main() {
  const port = await freePort();
  const secret = (k) => `Aa1!${k}${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
  const creds = ["admin", "member", "volunteer", "account"].reduce((o, k) => ({ ...o, [k]: { email: `audit-${k}@example.test`, password: secret(k) } }), {});
  console.log(`# starting a throwaway app on port ${port}`);
  const app = await startTestApp({ port, env: { ANON_SESSION_LIMIT: "100000", GMAIL_USER: "", GMAIL_APP_PASSWORD: "", ANTHROPIC_API_KEY: "" } });
  let browser;
  let problems = 0;
  try {
    const ids = await seed(app.databaseUrl, creds);
    browser = await puppeteer.launch({ headless: true });
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

    const login = async (context, who) => {
      const page = await context.newPage();
      await page.setViewport({ width: 1000, height: 800 });
      await page.goto(`${app.base}/login`, { waitUntil: "domcontentloaded" });
      await page.type("form[action='/login'] #email", creds[who].email);
      await page.type("form[action='/login'] #password", creds[who].password);
      await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.click("form[action='/login'] button[type='submit']")]);
      if (/\/login/.test(page.url())) throw new Error(`${who} could not log in`);
      await page.close();
    };

    const groups = [];
    if (ONLY === "all" || ONLY === "public") groups.push({ name: "guest", who: null, pages: [...PUBLIC_PAGES, ...bookPages(ids)] });
    if (ONLY === "all" || ONLY === "member") {
      groups.push({ name: "member", who: "member", pages: MEMBER_PAGES(ids) });
      groups.push({ name: "volunteer", who: "volunteer", pages: VOLUNTEER_PAGES });
    }
    if (ONLY === "all" || ONLY === "admin") groups.push({ name: "admin", who: "admin", pages: ADMIN_PAGES(ids) });

    let checked = 0;
    for (const g of groups) {
      const context = await browser.createBrowserContext();
      if (g.who) await login(context, g.who);
      const page = await context.newPage();
      page.setDefaultNavigationTimeout(30000);
      if (DESKTOP) {
        fs.mkdirSync(DESKTOP, { recursive: true });
        await context.setCookie({ name: "umasbooks_lang", value: "en", url: app.base });
        await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
        for (const p of g.pages.filter((x) => x.includes(PAGE_FILTER))) {
          await page.goto(`${app.base}${p}`, { waitUntil: "networkidle2" }).catch(() => {});
          await new Promise((r) => setTimeout(r, 300));
          await page.screenshot({ path: path.join(DESKTOP, `${g.name}-${p.replace(/[^a-z0-9]+/gi, "_")}.png`), fullPage: true }).catch(() => {});
          checked++;
        }
        await context.close();
        continue;
      }
      for (const lang of LANGS) {
        await context.setCookie({ name: "umasbooks_lang", value: lang, url: app.base });
        await page.evaluateOnNewDocument((l) => { try { localStorage.setItem("umasbooks.lang", l); } catch { /* none */ } }, lang);
        for (const vp of WIDTHS) {
          await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
          for (const p of g.pages.filter((x) => x.includes(PAGE_FILTER))) {
            const url = `${app.base}${p}`;
            let res;
            try { res = await page.goto(url, { waitUntil: "networkidle2" }); } catch (e) { console.log(`ERR   ${g.name} ${p} ${lang} ${vp.label}: ${e.message}`); problems++; continue; }
            if (p === "/books.html") {
              // fill the browse grid with the hostile books (the 90-letter title, then the 41-letter word)
              for (const term of ["Averyvery", "Pneumono"]) {
                await page.evaluate((t) => { const i = document.getElementById("shop-search-input"); if (i) { i.value = t; i.form && i.form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true })); } }, term);
                await new Promise((r) => setTimeout(r, 900));
                const m2 = await page.evaluate(measure, vp.width);
                if (m2.sw > m2.iw || m2.offenders.length || m2.clipped.length) { problems++; console.log(`FAIL  ${g.name.padEnd(9)} ${lang} ${vp.label.padEnd(8)} ${p} (search ${term}) scrollWidth=${m2.sw} ${m2.offenders.concat(m2.clipped).join("; ")}`); }
                if (SHOTS && has("all-shots")) await page.screenshot({ path: path.join(SHOTS, `${g.name}-${lang}-${vp.label}-books_search_${term}.png`) }).catch(() => {});
              }
            }
            if (res && res.status() >= 400 && res.status() !== 404) { console.log(`HTTP${res.status()} ${g.name} ${p}`); }
            const m = await page.evaluate(measure, vp.width);
            checked++;
            const bad = m.sw > m.iw || m.offenders.length || m.clipped.length;
            if (bad) {
              problems++;
              console.log(`FAIL  ${g.name.padEnd(9)} ${lang} ${vp.label.padEnd(8)} ${p}  scrollWidth=${m.sw} innerWidth=${m.iw}`);
              for (const o of m.offenders) console.log(`        past edge: ${o}`);
              for (const o of m.clipped) console.log(`        ${o}`);
              if (SHOTS) await page.screenshot({ fullPage: true, path: path.join(SHOTS, `${g.name}-${lang}-${vp.label}-${p.replace(/[^a-z0-9]+/gi, "_")}.png`) }).catch(() => {});
            } else if (SHOTS && has("all-shots")) {
              await page.screenshot({ fullPage: true, path: path.join(SHOTS, `${g.name}-${lang}-${vp.label}-${p.replace(/[^a-z0-9]+/gi, "_")}.png`) }).catch(() => {});
            }
          }
        }
      }
      await context.close();
    }
    console.log(`\n# ${checked} page views checked; ${problems} with a problem`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await app.stop().catch((e) => console.log(`# could not clean up the throwaway database: ${e.message.split("\n")[0]}`));
  }
  process.exit(problems ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
