// The small framework every scenario file uses.
//
//   const e2e = require("../helpers/harness");
//   const s = e2e.persona("guest");
//   s.test("V1 (must) home page ...", async (ctx) => { ... });
//   s.write("V28 ...", fn)        needs E2E_ALLOW_WRITES=1, else skipped
//   s.manual("V29 ...", "reason") skipped, counted as manual-only
//   s.todo("...", "known issue", fn)  runs, shown, never fails the run
//
// Each test gets its own private browser window (an incognito-style context),
// closed afterwards; a persona that needs a login reuses ONE login per run
// (session cookies copied into each window) so the site's login rate limits
// are never a factor. A failing test saves a screenshot and the page HTML in
// e2e/artifacts/. Requests to HelloAsso are always blocked at the browser:
// the tests can never reach, let alone fill in, a payment page (only the
// membership is paid online; books and seats are reserved and paid in the shop).

const { test, after } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const puppeteer = require("puppeteer");
const cfg = require("./config");
const { evaluateTarget } = require("./guard");
const { freshCode } = require("./totp");

const ARTIFACTS = path.join(__dirname, "..", "artifacts");
const BASE = cfg.baseUrl();
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);

class SkipSignal extends Error {}

let readyPromise = null;
let browser = null;
let guardResult = null;

// Guard first (prints which rule allowed the run), then the browser.
function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      guardResult = await evaluateTarget(BASE);
      if (!guardResult.allowed) {
        console.error(`\nE2E SAFETY GUARD: ${guardResult.reason}\n`);
        process.exit(2);
      }
      console.log(`# e2e target ${BASE} allowed by rule "${guardResult.rule}": ${guardResult.reason}`);
      browser = await puppeteer.launch({
        headless: true,
        args: cfg.truthy(process.env.E2E_NO_SANDBOX) ? ["--no-sandbox", "--disable-setuid-sandbox"] : [],
      });
    })();
  }
  return readyPromise;
}

after(async () => {
  if (browser) await browser.close().catch(() => {});
});

const sessions = {}; // persona -> cookies (one login per persona per run)

function record(kind, label, where) {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.appendFileSync(path.join(ARTIFACTS, `created-${cfg.runId()}.jsonl`), JSON.stringify({ kind, label, where: where || "" }) + "\n");
}

// Fills the login form and, for the admin, the two-step page. Returns where
// the browser ended up. Never prints the password or a code.
async function performLogin(page, persona) {
  const c = cfg.credentials(persona);
  if (c.missing.length) throw new Error(`missing ${c.missing.join(", ")}`);
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.type("form[action='/login'] #email", c.email);
  await page.type("form[action='/login'] #password", c.password);
  await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.click("form[action='/login'] button[type='submit']")]);
  if (new URL(page.url()).pathname === "/login/2fa") {
    if (!c.totpSecret && !c.recoveryCode) throw new Error("two-step page shown but E2E_ADMIN_TOTP_SECRET is not set");
    const code = c.totpSecret ? await freshCode(c.totpSecret) : c.recoveryCode;
    await page.type("#code", code);
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.click("form[action='/login/2fa'] button[type='submit']")]);
  }
  return new URL(page.url()).pathname;
}

class NotAnAccountHolder extends Error {}

// The account-holder persona must NOT be a member, volunteer or admin, or
// the "member pages are refused" tests would prove nothing. What the site
// shows tells: /dashboard (Member's Access) opens for a member, volunteer or
// admin and answers everyone else with the "This area is for members" page (403).
async function requireNotMember(page) {
  const res = await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
  if ((new URL(page.url()).pathname === "/dashboard" && res.status() < 400) || new URL(page.url()).pathname.startsWith("/admin")) {
    throw new NotAnAccountHolder("the E2E_ACCOUNT_* login is a member, volunteer or admin: Member's Access opened for it. Use a plain account (confirmed email, NOT marked as member, volunteer or admin), or the account tests prove nothing. The account tests were skipped.");
  }
}

const refused = {}; // persona -> why its login was refused (not tried again)

async function sessionFor(persona) {
  if (sessions[persona]) return sessions[persona];
  if (refused[persona]) throw refused[persona];
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    const where = await performLogin(page, persona);
    if (where === "/login" || where === "/login/2fa") {
      const err = await page.$eval(".error-box", (e) => e.textContent.trim()).catch(() => "no message");
      throw new Error(`${persona} login did not work (${err}). Check the E2E_${persona.toUpperCase()}_* values.`);
    }
    const cookies = await context.cookies();
    if (persona === "account") {
      try { await requireNotMember(page); } catch (err) { refused[persona] = err; throw err; }
    }
    sessions[persona] = cookies;
    return sessions[persona];
  } finally {
    await context.close();
  }
}

async function makeCtx(opts, testName, t) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(30000);
  const baseOrigin = new URL(BASE).origin;
  const blocked = [];
  const consoleErrors = [];
  const failedRequests = [];
  // HelloAsso is blocked in the browser before any request leaves it: the
  // Fetch domain is switched on for addresses containing "helloasso" ONLY (so
  // nothing else, cookies included, is touched), and every such request, a
  // redirect hop or an embedded iframe included, is failed and its address
  // recorded in `blocked`. (X7 in specs/edge.e2e.js checks this works.)
  const cdp = await page.createCDPSession();
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*helloasso*", requestStage: "Request" }] });
  cdp.on("Fetch.requestPaused", (e) => {
    blocked.push(e.request.url);
    cdp.send("Fetch.failRequest", { requestId: e.requestId, errorReason: "BlockedByClient" }).catch(() => {});
  });
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("requestfailed", (r) => failedRequests.push({ url: r.url(), reason: r.failure() && r.failure().errorText }));
  page.on("dialog", (d) => d.accept().catch(() => {})); // data-confirm / confirm() boxes

  if (opts.viewport) await page.setViewport(opts.viewport);
  // A guest who chose a language has it in BOTH the cookie and localStorage
  // (assets/site.js writes both); lang: null is a guest who has not chosen
  // yet, so the site follows the browser's language (opts.browserLang).
  const lang = opts.lang === undefined ? "en" : opts.lang;
  if (lang) {
    await context.setCookie({ name: "umasbooks_lang", value: lang, url: baseOrigin });
    await page.evaluateOnNewDocument((l) => { try { if (localStorage.getItem("umasbooks.lang") === null) localStorage.setItem("umasbooks.lang", l); } catch { /* no storage */ } }, lang);
  } else {
    const bl = opts.browserLang || "en-US";
    await page.setExtraHTTPHeaders({ "Accept-Language": bl });
    await page.evaluateOnNewDocument((l) => {
      Object.defineProperty(navigator, "language", { get: () => l });
      Object.defineProperty(navigator, "languages", { get: () => [l] });
    }, bl);
  }
  // The login window's own language cookie must not override this test's.
  if (opts.as) {
    try {
      await context.setCookie(...(await sessionFor(opts.as)).filter((c) => c.name !== "umasbooks_lang"));
    } catch (err) {
      if (!(err instanceof NotAnAccountHolder)) throw err;
      await context.close().catch(() => {});
      t.skip(err.message);
      throw new SkipSignal(err.message);
    }
  }

  const ctx = {
    base: BASE, page, context, blocked, consoleErrors, failedRequests, rule: guardResult.rule, preview: guardResult.preview,
    isLocal: guardResult.local, isHttps: BASE.startsWith("https:"),
    url: (p) => (p.startsWith("http") ? p : `${BASE}${p}`),
    async goto(p, wait = "domcontentloaded") {
      const res = await page.goto(ctx.url(p), { waitUntil: wait });
      return res;
    },
    // Send a form POST the way a browser does (a real page navigation) and follow the redirect it answers.
    // Not fetch(): on a plain-http site (e2e:local) Chrome upgrades a fetch() redirect target to https because
    // the pages send upgrade-insecure-requests, and the fetch dies with "Failed to fetch". A navigation does not.
    // The current page must be on the site (the CSRF token comes from it).
    async postForm(action, fields) {
      const { token } = await page.evaluate(async () => (await fetch("/api/csrf-token")).json());
      const nav = page.waitForNavigation({ waitUntil: "domcontentloaded" });
      await page.evaluate((a, f, tk) => {
        const form = document.createElement("form");
        form.method = "POST";
        form.action = a;
        for (const [k, v] of Object.entries({ _csrf: tk, ...f })) {
          const i = document.createElement("input");
          i.type = "hidden"; i.name = k; i.value = v;
          form.appendChild(i);
        }
        document.body.appendChild(form);
        form.submit();
      }, action, fields, token);
      const res = await nav;
      return { status: res.status(), redirected: res.request().redirectChain().length > 0, path: new URL(page.url()).pathname, body: await ctx.text() };
    },
    text: () => page.evaluate(() => document.body.innerText),
    html: () => page.content(),
    // Skip from inside a test (e.g. the site has no suitable sample data).
    skip(reason) { t.skip(reason); throw new SkipSignal(reason); },
    // Pick a language the way the toggle does: cookie plus localStorage.
    async setLang(l) {
      await context.setCookie({ name: "umasbooks_lang", value: l, url: baseOrigin });
      if (!page.url().startsWith(baseOrigin)) await page.goto(`${BASE}/healthz`, { waitUntil: "domcontentloaded" });
      await page.evaluate((x) => { try { localStorage.setItem("umasbooks.lang", x); } catch { /* no storage */ } }, l);
    },
    // Click the EN/FR button like a person, then reload so server-rendered text follows.
    async clickLang(l) {
      await page.click(`.langtoggle [data-lang='${l}']`);
      await page.waitForFunction((x) => document.cookie.includes(`umasbooks_lang=${x}`), {}, l);
      await page.reload({ waitUntil: "domcontentloaded" });
    },
    cookies: () => context.cookies(),
    // Remember this window's login as the persona's session for later tests.
    async keepSession(who) { sessions[who] = await context.cookies(); },
    // Plain HTTP with this window's cookies (for header / API checks).
    async fetchRaw(p, init = {}) {
      const jar = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
      return fetch(ctx.url(p), { redirect: "manual", ...init, headers: { cookie: jar, ...(init.headers || {}) } });
    },
    async json(p) {
      const res = await fetch(ctx.url(p), { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`${p} answered ${res.status}`);
      return res.json();
    },
    created: record,
    async snap() {
      try {
        fs.mkdirSync(ARTIFACTS, { recursive: true });
        const file = path.join(ARTIFACTS, `${cfg.runId()}-${slug(testName)}`);
        await page.screenshot({ path: `${file}.png`, fullPage: true });
        fs.writeFileSync(`${file}.html`, await page.content());
        console.error(`# saved e2e/artifacts/${path.basename(file)}.png (+ .html), page was ${page.url()}`);
      } catch { /* the page may already be gone */ }
    },
  };
  return ctx;
}

function persona(name) {
  const credSkip = cfg.skipReason(name);
  const selected = cfg.selectedPersonas().includes(name);
  const skipAll = !selected ? `not selected (E2E_ONLY=${process.env.E2E_ONLY})` : credSkip;

  function register(testName, opts, fn) {
    const o = { timeout: opts.timeout || 90000 };
    if (opts.todo) o.todo = opts.todo;
    // opts.anon: needs no login even in a persona file. opts.needs: other
    // personas whose logins this test uses (besides opts.as).
    const needed = [...(opts.needs || []), ...(opts.as ? [opts.as] : [])].map((p) => cfg.skipReason(p)).find(Boolean);
    const personaSkip = !selected ? skipAll : opts.anon ? null : credSkip;
    if (personaSkip) o.skip = personaSkip;
    else if (needed) o.skip = needed;
    if (!o.skip && opts.write && !cfg.allowWrites()) o.skip = "needs E2E_ALLOW_WRITES=1 (this step creates data or sends email)";
    return test(testName, o, async (t) => {
      await ready();
      let ctx;
      try {
        ctx = await makeCtx(opts, testName, t);
      } catch (err) {
        if (err instanceof SkipSignal) return;
        throw err;
      }
      try {
        await fn(ctx, t);
      } catch (err) {
        if (err instanceof SkipSignal) return;
        await ctx.snap();
        throw err;
      } finally {
        await ctx.context.close().catch(() => {});
      }
    });
  }

  const split = (args) => (typeof args[0] === "object" && args[0] !== null ? [args[0], args[1]] : [{}, args[0]]);
  return {
    name,
    // test(name, [opts,] fn)   opts: { as, lang, viewport, write, timeout }
    test: (n, ...a) => { const [o, f] = split(a); return register(n, o, f); },
    write: (n, ...a) => { const [o, f] = split(a); return register(n, { ...o, write: true }, f); },
    todo: (n, note, ...a) => { const [o, f] = split(a); return register(n, { ...o, todo: note }, f); },
    manual: (n, reason) => test(n, { skip: `manual: ${reason}` }, () => {}),
  };
}

// ---- data discovery (read only) ----
const cache = {};
const once = (key, fn) => (cache[key] || (cache[key] = fn()));

async function getJson(p) {
  const res = await fetch(`${BASE}${p}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${p} answered ${res.status}`);
  return res.json();
}
const books = () => getJson("/api/books/search?q="); // fresh each time: stock changes during a run
async function bookPage(id) {
  const res = await fetch(`${BASE}/books/${id}`);
  return { status: res.status, html: await res.text() };
}
// An out-of-stock book: scan the first ids for the "Currently unavailable" box.
const unavailableBookId = () => once("unavail", async () => {
  const ids = Array.from({ length: 60 }, (_, i) => i + 1);
  const pages = await Promise.all(ids.map((id) => bookPage(id).catch(() => ({ status: 0, html: "" }))));
  const i = pages.findIndex((p) => p.status === 200 && /is-out/.test(p.html));
  return i < 0 ? null : ids[i];
});

module.exports = {
  persona, cfg, BASE, ARTIFACTS, record, performLogin, sessionFor, books, bookPage, unavailableBookId, getJson, ready,
  guard: () => guardResult,
};
