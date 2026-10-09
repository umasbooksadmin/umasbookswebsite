require("dotenv").config({ quiet: true });
// Site timezone (Europe/Paris) must be set before any date is created.
require("./lib/tz");
// Fail fast (production only) with one clear message, before db.js is loaded.
const envCheck = require("./lib/env").checkEnv();
// Test system (APP_ENV=staging) only: refuse live HelloAsso keys / the production database.
require("./lib/staging").enforceStagingBoot();
const path = require("path");
const express = require("express");
const compression = require("compression");
const helmet = require("helmet");
const multer = require("multer");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);

const { pool } = require("./db");
const { attachUser, requireAdmin } = require("./middleware/auth");
const { resolveAdminSessionConfig, enforceAdminSession } = require("./lib/adminSession");
const { csrfProtection, csrfTokenEndpoint } = require("./middleware/csrf");
const { csrfTokenLimiter } = require("./middleware/rateLimits");
const { genid, createAnonSessionGuard } = require("./lib/anonSessionGuard");
const { sessionLifetime, lifetimeFor, GUEST_MAX_AGE_MS } = require("./lib/sessionLifetime");
const { expireStaleReservations, sendPickupReminders } = require("./lib/reservations");
const { runCartMaintenance: sweepCart } = require("./lib/cart");
const { runOrderFollowUps } = require("./lib/orderSweeps");
const { guardJob } = require("./lib/jobGuard");
const { recordJobRun } = require("./lib/jobRuns");
const { processOutbox } = require("./lib/outbox");
const { alertUnmatchedPayments } = require("./lib/membership");
const { drainAwards } = require("./lib/awards");
const { purgeUnusedImages } = require("./lib/imageCleanup");
const { backfillCovers } = require("./lib/coverStore");
const { purgeExpiredPersonalData } = require("./lib/privacy");
const { membershipPageState } = require("./lib/membershipPage");
const { expireStaleMemberships, reconcileRecentMemberships } = require("./lib/membership");
const { alertOnError } = require("./lib/errorAlert");
const { errorHandler } = require("./lib/errorHandler");
const { noStoreForUsers } = require("./middleware/noStoreForUsers");
const { langMiddleware } = require("./middleware/lang");
const { resolveTrustProxyHops } = require("./lib/trustProxy");
const { healthzHandler } = require("./lib/health");
const seoRoutes = require("./routes/seo");
const { MARKETING_PAGES, setMarketingSeoLocals, seoLocals } = seoRoutes;

const { renderMarketing } = require("./lib/pageDictionary");
const { buildMarketingCsp } = require("./lib/marketingCsp");
const authRoutes = require("./routes/auth");
const twoFactorRoutes = require("./routes/twoFactor");
const dashboardRoutes = require("./routes/dashboard");
const accountRoutes = require("./routes/account");
const accountPrivacyRoutes = require("./routes/accountPrivacy");
const forumRoutes = require("./routes/forum");
const charityRoutes = require("./routes/charity");
const volunteerRoutes = require("./routes/volunteer");
const meetingsRoutes = require("./routes/meetings");
const eventsRoutes = require("./routes/events");
const { redirectWithFlash } = require("./lib/postRedirect");
const blogRoutes = require("./routes/blog");
const sessionsRoutes = require("./routes/sessions");
const booksRoutes = require("./routes/books");
const contactRoutes = require("./routes/contact");
const marketingFormRoutes = require("./routes/marketingForms");
const bookRequestRoutes = require("./routes/bookRequests");
const cartRoutes = require("./routes/cart");
const helloassoWebhookRoutes = require("./routes/helloassoWebhook");
const adminRoutes = require("./routes/admin");

const { latestArrivals } = require("./lib/latestArrivals");
const { assetUrl, staticHeaders, STATIC_SECURITY_HEADERS } = require("./lib/assetUrl");

const app = express();
const isProd = process.env.NODE_ENV === "production";

// Helmet turns this off too, but it is mounted after /healthz and the
// static mounts, which would otherwise still answer "X-Powered-By: Express".
app.disable("x-powered-by");
// First of all, so every response (static files, /healthz, images, redirects,
// pages) carries it. See lib/permissionsPolicy.js.
app.use(require("./lib/permissionsPolicy").permissionsPolicy);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));
// gzip/deflate for text responses (HTML, JSON, CSS, JS, SVG);
// compression() skips already-compressed types (images) on its own.
// First, so static files and JSON endpoints below are all covered.
// Live site only: any Host other than APP_BASE_URL's (e.g. the *.onrender.com
// address) is redirected to the canonical one. See middleware/canonicalHost.js.
app.use(require("./middleware/canonicalHost").canonicalHost());
app.use(require("./lib/preview").previewMiddleware); // res.locals.preview + X-Robots-Tag (lib/preview.js)
app.use(compression());

// maxAge 7d on static files: filenames aren't content-hashed (about.css,
// site.js, ... keep the same URL when they change), so a long immutable
// cache isn't safe. 7 days is a compromise — returning people stop
// re-downloading every asset on each page view, at the cost of an edited
// stylesheet/script taking up to a week to reach people who already have
// the old one cached. Pages therefore link these files with a content-hash
// query (assetUrl helper) so an edit is picked up at once. A URL carrying ?v=<content hash> (see lib/assetUrl.js, used by the page
// templates) is immutable: one year. Without it, 7 days.
const STATIC_MAX_AGE = "7d";
// These mounts come before helmet (no session, no cost per request), so they set
// the security headers helmet would have set themselves (staticHeaders).
app.use(express.static(path.join(__dirname, "..", "public"), { maxAge: STATIC_MAX_AGE, setHeaders: staticHeaders }));

// Marketing-site static assets live at the repo root, not under public/.
// Mounted here — before the session store and attachUser — so image/CSS/JS
// requests never cost a session read or a per-request user lookup.
const marketingRoot = path.join(__dirname, "..", "..");
app.use("/assets", express.static(path.join(marketingRoot, "assets"), { maxAge: STATIC_MAX_AGE, setHeaders: staticHeaders }));
// Uploaded images (covers, blog/announcement/charity photos): content-addressed,
// immutable, served from the DB with no session. See routes/img.js.
app.use(require("./routes/img"));
app.get("/logo.png", (req, res) => res.sendFile("logo.png", { root: marketingRoot, maxAge: STATIC_MAX_AGE, headers: STATIC_SECURITY_HEADERS }));

// For the external uptime check (see .github/workflows/uptime-check.yml)
// to actually catch what happened on 2026-09-26 — the process was up
// and answering "/" the whole time, but every DB-backed route was
// broken — this has to genuinely touch the database, not just confirm
// the process is alive. Registered before session/helmet/csrf so a
// broken DB can't also break the session store's own read on the way
// to this route.
app.get("/healthz", healthzHandler(pool));

// robots.txt and sitemap.xml: also before the session, so crawlers never
// create a session row (and so they bypass CSRF/attachUser entirely).
app.use(seoRoutes.router);

// Date/time display helpers, available in every view without importing.
Object.assign(app.locals, require("./lib/dates"));
// Session color-coding, used by the /sessions calendar.
Object.assign(app.locals, require("./lib/sessionTone"));
app.locals.assetUrl = assetUrl;
app.locals.mondayFirstWeeks = require("./lib/calendar").mondayFirstWeeks;

// form-action also governs the redirect after a form POST in Chromium. Nothing
// posts a form to, or redirects after a form POST to, another site: books and
// seats are reserved here and paid in the shop, and the membership payment form
// is a HelloAsso iframe/link (frame-src, marketing pages), not a form we post.
const formActionSources = ["'self'"];

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'"],
        // Book covers are copied to our own server (lib/coverStore.js), so no
        // third-party image host is listed: visitors' browsers never call one.
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: formActionSources,
        frameAncestors: ["'none'"],
      },
    },
  })
);
app.use(require("./middleware/stripNul").rejectNulInPath);
app.use(express.urlencoded({ extended: false }));
app.use(require("./middleware/stripNul").stripNulFromInput);

// A repeated form-field name (e.g. two inputs both named "email", or a
// scanner/extension re-submitting one) makes the urlencoded parser above
// produce an array instead of a string — every route handler assumes a
// scalar and calls .trim()/.toLowerCase() on it directly, which throws
// and 500s the request. The couple of fields that are genuinely meant to
// be multi-valued (a multi-select vote, a bulk-action checkbox list)
// already defend themselves with [].concat(...), so they're left alone;
// everything else collapses to its first value, the same as a normal
// single-submission form would send.
const MULTI_VALUE_BODY_FIELDS = new Set(["optionIds", "ids", "days", "times", "itemIds"]); // days/times: the pre-registration form
app.use((req, res, next) => {
  if (req.body && typeof req.body === "object") {
    for (const key of Object.keys(req.body)) {
      if (Array.isArray(req.body[key]) && !MULTI_VALUE_BODY_FIELDS.has(key)) {
        req.body[key] = req.body[key][0];
      }
    }
  }
  next();
});

if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET is not set");
}

// Session lifetimes (30 days logged in, 24 h guest cart, 2 h other guests) live in lib/sessionLifetime.js.
const SESSION_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
const adminSessionConfig = resolveAdminSessionConfig();
for (const w of adminSessionConfig.warnings) console.warn(`[session] WARNING: ${w}`);
// Number of trusted proxy hops (TRUST_PROXY_HOPS, default 2 in production:
// Cloudflare -> Render edge -> app). See lib/trustProxy.js.
const { hops: trustProxyHops, error: trustProxyError } = resolveTrustProxyHops();
if (trustProxyError) console.warn(`[proxy] WARNING: ${trustProxyError}`);
console.log(`[proxy] trusting ${trustProxyHops} proxy hop(s) (TRUST_PROXY_HOPS)`);
app.set("trust proxy", trustProxyHops);
app.use(
  session({
    // disableTouch: connect-pg-simple's touch() is an UPDATE run at the
    // end of EVERY request that carries a session cookie (on top of the
    // SELECT at the start). Marketing pages make several such requests
    // per view, so that was most of the app's write load. Instead, the
    // "refresh the expiry" middleware below saves the session at most
    // once a day. rolling stays false so the cookie isn't re-sent on
    // every response either.
    // pruneSessionInterval: connect-pg-simple deletes expired rows (DELETE ... WHERE expire < now())
    // every 15 minutes (randomised 50-150 %), so guest rows (2 h / 24 h) vanish soon after expiry.
    store: new pgSession({ pool, createTableIfMissing: true, disableTouch: true, pruneSessionInterval: 15 * 60 }),
    // genid flags brand-new sessions on the request (lib/anonSessionGuard.js).
    genid,
    name: "umasbooks.sid",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      // A NEW session starts as a short guest session; lib/sessionLifetime.js
      // lengthens it when the person logs in (30 days) or fills a cart (24 h).
      maxAge: GUEST_MAX_AGE_MS,
    },
  })
);
app.use(sessionLifetime);

// Sliding expiry without per-request writes: if the session was last saved long
// enough ago that fewer than (lifetime - REFRESH_AFTER) remain, record a
// timestamp so express-session saves it once, which pushes both the DB row's
// expiry and the cookie out by another full lifetime. REFRESH_AFTER is a day
// for a 30-day login (an active person stays logged in indefinitely; an idle
// one expires 30 days, give or take a day, after the last visit) and a quarter
// of the lifetime for the short guest sessions (2 h -> a write at most every
// 30 min; 24 h cart -> every 6 h).
app.use((req, res, next) => {
  const expires = req.session && req.session.cookie && req.session.cookie.expires;
  if (expires) {
    const lifetime = lifetimeFor(req.session);
    const refreshAfter = Math.min(SESSION_REFRESH_AFTER_MS, lifetime / 4);
    // A legacy 30-day guest row (older than this change) has MORE than `lifetime`
    // left: leave it alone, the guest-session prune below removes it.
    if (new Date(expires).getTime() - Date.now() < lifetime - refreshAfter) {
      req.session.refreshedAt = Date.now();
    }
  }
  next();
});

// Language (cookie / Accept-Language -> req.lang, tr(), localised dates).
// Reads headers only, so it never creates a session or touches the DB.
app.use(langMiddleware);
// After the language middleware (friendly 429 text), before anything that would put a guest into the session.
app.use(createAnonSessionGuard());
app.use(seoLocals);
app.use(attachUser(pool));
// Admin / till sessions: 8-hour idle and 7-day absolute limits (lib/adminSession.js).
// After attachUser (it needs the fresh role flags), before anything else that
// acts on the user, so an expired admin is signed out on ANY page, not only /admin.
app.use(enforceAdminSession(adminSessionConfig));
// Right after attachUser (it needs res.locals.user): logged-in responses are no-store.
app.use(noStoreForUsers);
app.use(require("./middleware/noStoreForUsers").noStoreForTokenPages);
app.use((req, res, next) => {
  res.locals.cartCount = Array.isArray(req.session.cart) ? req.session.cart.length : 0;
  next();
});

// requireAdmin gates each of these ahead of multer itself — without it,
// an anonymous request could make the server buffer an upload (up to
// 8MB) into memory before any admin/form check ever ran, just by POSTing
// a large multipart body to one of these paths. req.session.user is
// already fresh here (attachUser ran above), so this costs nothing extra
// to check.
//
// Multer must parse any multipart body under /admin/inventory (populating
// req.body._csrf and req.files) before the CSRF check below runs —
// csrfProtection only ever sees req.body as urlencoded-parsing (above)
// left it otherwise. Scoped as one middleware covering every field name
// used anywhere under this prefix (the ISBN-photo scan and the cover-photo
// upload), rather than one per route, so a single multipart request is
// never run through multer twice.
const inventoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
app.use("/admin/inventory", requireAdmin, inventoryUpload.fields([
  { name: "photo", maxCount: 1 },
  { name: "coverPhoto", maxCount: 1 },
]));

// Same reasoning as inventoryUpload above, for the announcement form's
// featured-image upload (see /admin/announcements in routes/admin/announcements.js).
const announcementUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
app.use("/admin/announcements", requireAdmin, announcementUpload.fields([{ name: "image", maxCount: 1 }]));

// Same again, for a charity's photo (see /admin/charities in routes/admin/charity.js).
const charityUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
app.use("/admin/charities", requireAdmin, charityUpload.fields([{ name: "image", maxCount: 1 }]));

// Same again, for a blog post's featured image (see /admin/blog in routes/admin/blog.js).
// 15 MB: a camera or phone photo is commonly 6-12 MB and is shrunk to 800x500 anyway.
// A refused upload sends the admin back to the form with a sentence, not a bare error page.
const blogUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const blogUploadFields = blogUpload.fields([{ name: "image", maxCount: 1 }]);
app.use("/admin/blog", requireAdmin, (req, res, next) => {
  blogUploadFields(req, res, (err) => {
    if (!err) return next();
    console.warn(`Blog upload refused: ${err.code || err.name}: ${err.message}`);
    const message = err.code === "LIMIT_FILE_SIZE"
      ? "The post was NOT saved: that picture is larger than 15 MB. Please choose a smaller picture and write the post again."
      : "The post was NOT saved: the upload could not be read. Please try again, with or without the picture.";
    redirectWithFlash(req, res, "/admin/blog", "adminBlog", { error: message }).catch(next);
  });
});

// HelloAsso calls this server-to-server with no CSRF token, so it's
// mounted ahead of the CSRF check below rather than with the rest of
// the app's routes further down.
app.use(helloassoWebhookRoutes);

app.use(csrfProtection);

// A CSRF token for client-side scripts that POST without a rendered
// form — e.g. the favorite-toggle button (public/favorites.js), which
// runs on both the marketing site's static HTML (no server templating,
// so no <input> to read a token from) and this app's own EJS pages.
app.get("/api/csrf-token", csrfTokenLimiter, csrfTokenEndpoint);

// Same idea as /api/cart/count above: the marketing site's static HTML
// has no server-side session rendering, so it can't know a person is
// logged in (to swap "Log In" for "Log Out"), a member (for the
// Member's Access icon), or an admin (for the Admin link) the way the
// EJS pages' shared header does (see partials/header.ejs) — this lets
// its plain <script> (assets/site.js) ask, and only exposes the
// booleans actually needed for those links. cartCount is folded in so a
// marketing page view needs ONE session-backed request, not two
// (/api/cart/count still exists for any other caller).
app.get("/api/session", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    cartCount: Array.isArray(req.session.cart) ? req.session.cart.length : 0,
    loggedIn: Boolean(req.session.user),
    isMember: Boolean(req.session.user && req.session.user.isMember),
    isVolunteer: Boolean(req.session.user && req.session.user.isVolunteer),
    isAdmin: Boolean(req.session.user && req.session.user.isAdmin),
  });
});

// The public marketing site (repo root, one level up from this app) is
// served from here too, so this app's own URL is the one link that shows
// everything — the marketing pages alongside the Members Area.
// Its inline <script> blocks (per-page i18n strings, the Latest Arrivals
// carousel) predate this app and aren't nonce-tagged, so these routes
// carry their own relaxed CSP instead of the strict app-wide one above;
// the Members Area's own routes keep the stricter policy untouched.
const marketingCsp = buildMarketingCsp(formActionSources);


app.get("/", (req, res, next) => {
  // Home is the public home page for everyone, signed in or not: the header's
  // Member's Access / Admin links (partials/mkt_chrome_header.ejs) are how a
  // signed-in person reaches their area. Signed-in responses are no-store
  // (middleware/noStoreForUsers.js), so the user-specific header is never cached.
  res.set("Content-Security-Policy", marketingCsp);
  setMarketingSeoLocals(req, res, "/");
  renderMarketing(req, res, next, "marketing/index");
});

// The booking calendar used to be called "classes", then "programs"; send
// old links and bookmarks to the current address. The marketing page at
// programs.html keeps its own name — it's a different thing (see
// MARKETING_PAGES below) from the /sessions calendar this app serves.
const qs = (req) => { const i = req.originalUrl.indexOf("?"); return i === -1 ? "" : req.originalUrl.slice(i); };
app.get("/classes.html", (req, res) => res.redirect(301, "/programs.html"));
app.get("/classes", (req, res) => res.redirect(301, "/sessions" + qs(req)));
app.get("/admin/classes", (req, res) => res.redirect(301, "/admin/sessions" + qs(req)));
app.get("/programs", (req, res) => res.redirect(301, "/sessions" + qs(req)));
app.get("/admin/programs", (req, res) => res.redirect(301, "/admin/sessions" + qs(req)));

// Becoming a member requires an account: the membership page shows the
// HelloAsso payment widget only to a logged-in account holder (see
// src/lib/membershipPage.js). Everyone else gets a login/signup prompt.
MARKETING_PAGES.forEach((file) => {
  app.get("/" + file, async (req, res, next) => {
    res.set("Content-Security-Policy", marketingCsp);
    setMarketingSeoLocals(req, res, "/" + file);
    if (file === "books.html") {
      // No-JavaScript fallback: the page fills its shelves from /api/books/*,
      // so the server also lists the newest books inside <noscript>.
      res.locals.noscriptBooks = await latestArrivals(pool, { limit: 12, days: 0 }).catch(() => []);
    }
    if (marketingFormRoutes.FORM_PAGES.includes("/" + file)) {
      // Server-side forms (routes/marketingForms.js): the page carries a CSRF token, so no shared cache.
      marketingFormRoutes.prepareFormPage(res);
      marketingFormRoutes.setFormState(req, res, file);
    }
    if (file === "membership.html") {
      // Personal (the account's email, membership end date): never cached.
      res.set("Cache-Control", "private, no-store");
      Object.assign(res.locals, await membershipPageState(pool, req.session));
    }
    renderMarketing(req, res, next, "marketing/" + file.replace(/\.html$/, ""));
  });
});

app.use(authRoutes);
app.use(twoFactorRoutes);
app.use(dashboardRoutes);
app.use(accountRoutes);
app.use(accountPrivacyRoutes);
app.use(forumRoutes);
app.use(charityRoutes);
app.use(volunteerRoutes);
app.use(meetingsRoutes);
app.use(eventsRoutes);
app.use(blogRoutes);
app.use(sessionsRoutes);
app.use(booksRoutes);
app.use(cartRoutes);
app.use(contactRoutes);
app.use(marketingFormRoutes);
app.use(bookRequestRoutes);
app.use(adminRoutes);

// Extensionless marketing addresses (/books, /membership, /about ...) are what
// people type and what old links use; the real pages end in ".html". Registered
// AFTER every app route, so an app page that owns the plain name (/events,
// /blog, /volunteer) keeps it. The query string is preserved (/books?genre=X).
MARKETING_PAGES.forEach((file) => {
  app.get("/" + file.replace(/\.html$/, ""), (req, res) => res.redirect(301, "/" + file + qs(req)));
});

app.use((req, res) => {
  res.status(404).render("404");
});

// Last-resort handler for anything a route threw or rejected with
// (Express 5 forwards a rejected async handler's promise here itself): see
// lib/errorHandler.js. A 4xx err.status (e.g. multer's 413) gets that
// status and a friendly page with no alert; anything else is a 500 + alert.
app.use(errorHandler);

// Both of these mean some error escaped every other net (route handlers
// are forwarded to the error handler by Express 5; the background jobs below
// already .catch() their own). Log either way; only exit for the
// synchronous case, where Node's own docs say the process is in an
// unknown state and continuing is unsafe — Render restarts it clean.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
  alertOnError("Unhandled rejection", err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  // Give the alert email a few seconds, but exit regardless — an
  // uncaught exception means the process is in an unknown state, and
  // that matters more than a best-effort notification landing.
  Promise.race([
    alertOnError("Uncaught exception (process restarting)", err),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]).finally(() => process.exit(1));
});

const port = process.env.PORT || 3000;
// Express 5 also passes a listen failure (e.g. EADDRINUSE) to this callback;
// the "error" handler below deals with that, so only announce real success.
const server = app.listen(port, (err) => {
  if (!err) console.log(`umas-books listening on port ${port}`);
});

// Launch-guard alerts from lib/env.js (live site with a wrong setup). force skips the throttle so they are never
// swallowed by an unrelated error alert; the text carries no personal data.
// At most once per 24 h per alert (lib/alertFlags.js), not once per deploy or
// restart; while the problem exists a red banner on every admin page shows it.
require("./lib/env").sendLaunchAlerts(envCheck && envCheck.alerts, alertOnError, pool)
  .catch((err) => console.error("Launch alerts failed:", err.message));

// Without a handler, a failed bind (most commonly EADDRINUSE) surfaces as
// an uncaughtException with a stack trace and, in production, an alert
// email that says nothing useful. Say what happened and exit non-zero.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use - is another instance of the app running? Exiting.`);
  } else {
    console.error("HTTP server error:", err);
  }
  process.exit(1);
});

// Belt-and-suspenders backstop for the 2-week reservation expiry — the
// public/admin inventory routes already expire stale reservations on
// read, which is what actually keeps the displayed status correct, but
// this catches it too whenever the process happens to be awake with no
// traffic (Render's free tier can sleep, so a timer alone isn't reliable
// on its own). Pickup-reminder emails (3 days before expiry) only ever
// run from here, not on page reads — sending mail is a side effect that
// doesn't belong in a GET request's hot path.
//
// Each of the four is its own tracked job (lib/jobGuard.js -> job_runs): a
// failure used to be only a console.error; now three in a row alert the admin
// and /admin/diagnostics/jobs shows when each last succeeded.
const SIX_HOURS = 6 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const maintenanceJobs = [
  guardJob("Reservation expiry", () => expireStaleReservations(pool), { pool, intervalMs: SIX_HOURS }),
  guardJob("Pickup reminders", () => sendPickupReminders(pool), { pool, intervalMs: SIX_HOURS }),
  guardJob("Membership expiry", () => expireStaleMemberships(pool), { pool, intervalMs: SIX_HOURS }),
  guardJob("Membership reconciliation", () => reconcileRecentMemberships(pool), { pool, intervalMs: SIX_HOURS }),
];
const runReservationMaintenance = () => Promise.all(maintenanceJobs.map((j) => j()));
runReservationMaintenance();
const reservationTimer = setInterval(runReservationMaintenance, SIX_HOURS);

// Follow-up for RESERVATIONS (lib/orderSweeps.js): releases reservations past
// their deadline and seats whose session is over, the day-10 customer reminder,
// the 24-hour drop-in seat reminder, the "your reservation has ended" email and
// the admin digest of reservations expiring within 2 days. Every 6 hours. Not run
// at boot: a restart-heavy host would repeat it on every restart, so the first run
// comes 5 minutes after boot (unref'd: it never keeps the process alive) and then
// every 6 h. (Releases also happen whenever a page reads copy status.)
const runOrderFollowUpJob = guardJob("Order follow-up", async () => {
  const results = await runOrderFollowUps(pool);
  console.log("Order follow-up:", JSON.stringify(results));
}, { pool, intervalMs: SIX_HOURS });
const orderFollowUpFirstRun = setTimeout(runOrderFollowUpJob, 5 * 60 * 1000);
orderFollowUpFirstRun.unref();
const orderFollowUpTimer = setInterval(runOrderFollowUpJob, 6 * 60 * 60 * 1000);

// Leftovers of the old online checkout (an unpaid order holding books 'in_cart'):
// released after an hour, so nothing stays stuck (lib/cart.js). Nothing creates
// such holds any more, and no payment provider is asked.
const runCartMaintenance = guardJob("Cart maintenance", () => sweepCart(pool), { pool, intervalMs: 10 * 60 * 1000 });
runCartMaintenance();
const cartTimer = setInterval(runCartMaintenance, 10 * 60 * 1000);

// Email outbox worker (lib/outbox.js): retries mail that could not be sent
// right away, with backoff, and alerts the admin when it gives up. Also the
// place that sends the throttled "membership payment matches no account" alert.
const runOutbox = guardJob("Email outbox", async () => {
  const r = await processOutbox(pool);
  if (r.sent || r.failed) console.log(`Email outbox: ${r.sent} sent, ${r.failed} failed.`);
  await alertUnmatchedPayments(pool);
}, { pool, intervalMs: 60 * 1000 });
setTimeout(runOutbox, 15 * 1000).unref();
const outboxTimer = setInterval(runOutbox, 60 * 1000);

// Retention purge: removes personal data past the periods promised in the
// privacy policy (lib/privacy.js). Daily is plenty; it also runs once at
// boot so a restart-heavy host still gets it.
// Every step is tracked on its own ("Retention purge: tokens", ...): a step
// that fails every day is a privacy-policy breach in the making, so it alerts
// like any other job (3 failures in a row) instead of only logging.
const runPrivacyPurge = guardJob("Retention purge", async () => {
  const counts = await purgeExpiredPersonalData(pool, {
    onStep: (step, err) => recordJobRun(pool, `Retention purge: ${step}`, { intervalMs: DAY, error: err }),
  });
  console.log("Retention purge:", JSON.stringify(counts));
});
runPrivacyPurge();
const privacyTimer = setInterval(runPrivacyPurge, DAY);

// Unused-image cleanup (lib/imageCleanup.js): not personal data, so its own
// daily step. Removes at most one batch of images older than 7 days that no
// row references any more. Counts only in the log line.
const runImageCleanup = guardJob("Image cleanup", async () => {
  const { deleted, bytes } = await purgeUnusedImages(pool);
  console.log("Image cleanup:", JSON.stringify({ deleted, bytes }));
}, { pool, intervalMs: DAY });
runImageCleanup();
const imageCleanupTimer = setInterval(runImageCleanup, DAY);

// Book lookup statistics (lib/lookupStats.js, report /admin/reports/lookup-sources): counts per catalog are
// kept in memory by the scan path and written to the database about every 30 s (and at shutdown), so a lookup never
// waits on it. Aggregate technical counts, no personal data; daily rows older than 36 months are pruned once a day.
const lookupStats = require("./lib/lookupStats");
lookupStats.getStats().start();
const runLookupStatsPrune = guardJob("Lookup statistics retention", async () => {
  const removed = await lookupStats.pruneLookupStats(pool);
  if (removed) console.log("Lookup statistics retention:", JSON.stringify({ removed }));
}, { pool, intervalMs: DAY });
runLookupStatsPrune();
const lookupStatsTimer = setInterval(runLookupStatsPrune, DAY);

// AI usage statistics (lib/aiUsageStats.js, same report): call/token counts per feature, same batching and retention.
const aiUsageStats = require("./lib/aiUsageStats");
aiUsageStats.getStats().start();
const runAiUsagePrune = guardJob("AI usage statistics retention", async () => {
  const removed = await aiUsageStats.pruneAiUsageStats(pool);
  if (removed) console.log("AI usage statistics retention:", JSON.stringify({ removed }));
  await require("./lib/aiLimits").pruneAiDailyCap(pool); // the daily cap counters (lib/aiLimits.js)
}, { pool, intervalMs: DAY });
runAiUsagePrune();
const aiUsageStatsTimer = setInterval(runAiUsagePrune, DAY);

// Guest session rows: connect-pg-simple prunes EXPIRED rows every 15 minutes; this also removes
// guest rows that would live longer than 24 h (the 30-day ones from before guest sessions were
// shortened, lib/sessionLifetime.js). Logged-in sessions are never touched.
const { pruneStaleGuestSessions } = require("./lib/sessionPrune");
const runGuestSessionPrune = guardJob("Guest session prune", async () => {
  const removed = await pruneStaleGuestSessions(pool);
  if (removed) console.log("Guest session prune:", JSON.stringify({ removed }));
}, { pool, intervalMs: 15 * 60 * 1000 });
setTimeout(runGuestSessionPrune, 20 * 1000).unref();
const guestSessionPruneTimer = setInterval(runGuestSessionPrune, 15 * 60 * 1000);

// Awards & best-seller lists (lib/awards): every 2 minutes look up a few
// books that have never been checked (newest first), plus retries of failed
// checks and a yearly refresh. This also back-fills old books gradually. No
// run at boot: the first tick comes after 2 minutes, so a restart-heavy host
// never hammers Wikidata, and a deploy is never slowed by it.
const runAwardsDrain = guardJob("Awards check", async () => {
  const { processed } = await drainAwards(pool);
  if (processed) console.log(`Awards check: ${processed} book(s) checked.`);
}, { pool, intervalMs: 2 * 60 * 1000 });
const awardsTimer = setInterval(runAwardsDrain, 2 * 60 * 1000);

// Book covers on our own server (lib/coverStore.js): every 5 minutes copy up to 20
// covers from their Open Library/Internet Archive source address into the image
// store (books on the shelves first), one at a time with a pause between, each
// with a time and size limit; a cover that keeps failing is tried at most 3
// times a week. New books are copied when they are added; this catches the books
// that existed before, and any download that failed. First tick after one minute
// (not at boot, so a restart-heavy host never hammers anyone); off in tests
// (COVER_BACKFILL=off) so they never reach the network.
let coverTimer = null;
let coverFirstTimer = null;
if (process.env.COVER_BACKFILL !== "off") {
  const runCoverBackfill = guardJob("Cover backfill", async () => {
    const { processed, stored, failed, transient } = await backfillCovers(pool);
    if (processed) console.log(`Cover backfill: ${stored} stored, ${failed} failed, ${transient} not reachable (will retry), ${processed} tried.`);
  }, { pool, intervalMs: 5 * 60 * 1000 });
  coverFirstTimer = setTimeout(runCoverBackfill, 60 * 1000);
  coverFirstTimer.unref();
  coverTimer = setInterval(runCoverBackfill, 5 * 60 * 1000);
}

// Graceful shutdown. Render sends SIGTERM on every deploy and spin-down;
// without a handler the process dies mid-request (an in-flight HelloAsso
// webhook or checkout would be cut off). Order matters:
//   1. stop the maintenance timers (no new background work),
//   2. server.close() stops accepting connections and waits for in-flight
//      requests to finish (idle keep-alive sockets are closed right away),
//   3. only then pool.end(), so those requests can still reach the DB,
//   4. exit 0. A hard-exit timer (unref'd, so it never keeps the process
//      alive by itself) forces exit 1 if requests do not drain in time.
const SHUTDOWN_TIMEOUT_MS = 10 * 1000;
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received - shutting down gracefully.`);
  clearInterval(reservationTimer);
  clearInterval(orderFollowUpTimer);
  clearTimeout(orderFollowUpFirstRun);
  clearInterval(cartTimer);
  clearInterval(outboxTimer);
  clearInterval(privacyTimer);
  clearInterval(imageCleanupTimer);
  clearInterval(awardsTimer);
  clearInterval(guestSessionPruneTimer);
  clearInterval(lookupStatsTimer);
  clearInterval(aiUsageStatsTimer);
  clearInterval(coverTimer);
  clearTimeout(coverFirstTimer);
  setTimeout(() => {
    console.error(`Shutdown did not finish within ${SHUTDOWN_TIMEOUT_MS / 1000}s - forcing exit.`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  server.close(() => {
    // the lookup counts still in memory go to the database before the pool closes (never fails the shutdown)
    Promise.all([lookupStats.getStats().stop().catch(() => {}), aiUsageStats.getStats().stop().catch(() => {})]).then(() => pool.end()).then(
      () => {
        console.log("Shutdown complete.");
        process.exit(0);
      },
      (err) => {
        console.error("Error closing database pool:", err);
        process.exit(1);
      }
    );
  });
  // A connection that was mid-request when we started closing becomes idle
  // (keep-alive) the moment its response is sent; without this sweep it
  // would hold the process open until Node's 5s keep-alive timeout.
  server.closeIdleConnections();
  setInterval(() => server.closeIdleConnections(), 250).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
