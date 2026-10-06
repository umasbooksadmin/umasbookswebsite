require("dotenv").config({ quiet: true });
// Site timezone (Europe/Paris) must be set before any date is created.
require("./lib/tz");
// Fail fast (production only) with one clear message, before db.js is loaded.
const envCheck = require("./lib/env").checkEnv();
const path = require("path");
const express = require("express");
const compression = require("compression");
const helmet = require("helmet");
const { helloassoPaymentOrigins } = require("./lib/helloassoHosts");
const multer = require("multer");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);

const { pool } = require("./db");
const { attachUser, requireAdmin } = require("./middleware/auth");
const { csrfProtection, csrfTokenEndpoint } = require("./middleware/csrf");
const { csrfTokenLimiter } = require("./middleware/rateLimits");
const { expireStaleReservations, sendPickupReminders } = require("./lib/reservations");
const { runCartMaintenance: sweepCart } = require("./lib/cart");
const { guardJob } = require("./lib/jobGuard");
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
const { MARKETING_PAGES, setMarketingSeoLocals } = seoRoutes;

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
const blogRoutes = require("./routes/blog");
const sessionsRoutes = require("./routes/sessions");
const booksRoutes = require("./routes/books");
const contactRoutes = require("./routes/contact");
const marketingFormRoutes = require("./routes/marketingForms");
const bookRequestRoutes = require("./routes/bookRequests");
const cartRoutes = require("./routes/cart");
const helloassoWebhookRoutes = require("./routes/helloassoWebhook");
const adminRoutes = require("./routes/admin");

const app = express();
const isProd = process.env.NODE_ENV === "production";

// Helmet turns this off too, but it is mounted after /healthz and the
// static mounts, which would otherwise still answer "X-Powered-By: Express".
app.disable("x-powered-by");

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
// the old one cached. Versioning the filenames would allow much longer.
const STATIC_MAX_AGE = "7d";
app.use(express.static(path.join(__dirname, "..", "public"), { maxAge: STATIC_MAX_AGE }));

// Marketing-site static assets live at the repo root, not under public/.
// Mounted here — before the session store and attachUser — so image/CSS/JS
// requests never cost a session read or a per-request user lookup.
const marketingRoot = path.join(__dirname, "..", "..");
app.use("/assets", express.static(path.join(marketingRoot, "assets"), { maxAge: STATIC_MAX_AGE }));
// Uploaded images (covers, blog/announcement/charity photos): content-addressed,
// immutable, served from the DB with no session. See routes/img.js.
app.use(require("./routes/img"));
app.get("/logo.png", (req, res) => res.sendFile("logo.png", { root: marketingRoot }));

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
app.locals.mondayFirstWeeks = require("./lib/calendar").mondayFirstWeeks;

// form-action also governs the redirect after a form POST in Chromium, so the
// checkout's 302 to the HelloAsso payment page needs those origins listed.
const formActionSources = ["'self'", ...helloassoPaymentOrigins()];

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
app.use(express.urlencoded({ extended: false }));

// A repeated form-field name (e.g. two inputs both named "email", or a
// scanner/extension re-submitting one) makes the urlencoded parser above
// produce an array instead of a string — every route handler assumes a
// scalar and calls .trim()/.toLowerCase() on it directly, which throws
// and 500s the request. The couple of fields that are genuinely meant to
// be multi-valued (a multi-select vote, a bulk-action checkbox list)
// already defend themselves with [].concat(...), so they're left alone;
// everything else collapses to its first value, the same as a normal
// single-submission form would send.
const MULTI_VALUE_BODY_FIELDS = new Set(["optionIds", "ids", "days", "times"]); // days/times: the pre-registration form
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

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
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
    store: new pgSession({ pool, createTableIfMissing: true, disableTouch: true }),
    name: "umasbooks.sid",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      maxAge: SESSION_MAX_AGE_MS,
    },
  })
);

// Sliding 30-day expiry without per-request writes: if the session was
// last saved more than a day ago (its stored cookie.expires is under
// 29 days away), record a timestamp so express-session saves it once,
// which pushes both the DB row's expiry and the cookie out by another
// 30 days. An active person therefore stays logged in indefinitely; an
// idle one still expires 30 days (give or take a day) after last visit.
app.use((req, res, next) => {
  const expires = req.session && req.session.cookie && req.session.cookie.expires;
  if (expires && new Date(expires).getTime() - Date.now() < SESSION_MAX_AGE_MS - SESSION_REFRESH_AFTER_MS) {
    req.session.refreshedAt = Date.now();
  }
  next();
});

// Language (cookie / Accept-Language -> req.lang, tr(), localised dates).
// Reads headers only, so it never creates a session or touches the DB.
app.use(langMiddleware);
app.use(attachUser(pool));
// Right after attachUser (it needs res.locals.user): logged-in responses are no-store.
app.use(noStoreForUsers);
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
const blogUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
app.use("/admin/blog", requireAdmin, blogUpload.fields([{ name: "image", maxCount: 1 }]));

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
  // Only an actual member/volunteer/admin gets bounced to the Member's
  // Access dashboard — a logged-in user who isn't gets the regular
  // homepage like anyone else (see requireMember), otherwise this and
  // /dashboard's own redirect would loop forever on each other.
  const u = req.session.user;
  if (u && (u.isAdmin || u.isMember || u.isVolunteer)) return res.redirect("/dashboard");
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
    if (marketingFormRoutes.FORM_PAGES.includes("/" + file)) {
      // Server-side forms (routes/marketingForms.js): the page carries a CSRF token, so no shared cache.
      marketingFormRoutes.prepareFormPage(res);
      res.locals.form = { sent: req.query.sent === "1" };
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

// Launch-guard alerts from lib/env.js (live site with a wrong setup): ONE
// email per alert per boot. force skips the throttle so they are never
// swallowed by an unrelated error alert; the text carries no personal data.
require("./lib/env").sendLaunchAlerts(envCheck && envCheck.alerts, alertOnError);

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
const runReservationMaintenance = guardJob("Reservation maintenance", async () => {
  await Promise.allSettled([
    expireStaleReservations(pool).catch((err) => console.error("Reservation expiry failed:", err)),
    sendPickupReminders(pool).catch((err) => console.error("Pickup reminders failed:", err)),
    expireStaleMemberships(pool).catch((err) => console.error("Membership expiry failed:", err)),
    reconcileRecentMemberships(pool).catch((err) => console.error("Membership reconciliation failed:", err)),
  ]);
});
runReservationMaintenance();
const reservationTimer = setInterval(runReservationMaintenance, 6 * 60 * 60 * 1000);

// Same idea for the online-checkout cart, but on a much shorter interval
// than the reservation job above: a cart hold is only good for an hour
// (see CART_HOLD_TTL_MINUTES in lib/cart.js) and a buyer who closes the
// tab mid-payment is relying on this to notice their order never got
// reconciled by the webhook or the /cart/return page.
//
// Every 6th tick (hourly, starting with the one at boot) the sweep also
// re-checks orders expired/cancelled in the last 7 days for a payment that
// landed after the hold lapsed — see "LATE PAYMENTS" in lib/cart.js.
let cartMaintenanceTick = 0;
// Sweeps run sequentially (expiry, then reconcile) and a slow run is not
// overlapped by the next tick - see runCartMaintenance in lib/cart.js.
const runCartMaintenance = guardJob("Cart maintenance", () => {
  const includeClosed = cartMaintenanceTick++ % 6 === 0;
  return sweepCart(pool, { includeClosed });
});
runCartMaintenance();
const cartTimer = setInterval(runCartMaintenance, 10 * 60 * 1000);

// Retention purge: removes personal data past the periods promised in the
// privacy policy (lib/privacy.js). Daily is plenty; it also runs once at
// boot so a restart-heavy host still gets it.
function runPrivacyPurge() {
  purgeExpiredPersonalData(pool)
    .then((counts) => console.log("Retention purge:", JSON.stringify(counts)))
    .catch((err) => console.error("Retention purge failed:", err));
}
runPrivacyPurge();
const privacyTimer = setInterval(runPrivacyPurge, 24 * 60 * 60 * 1000);

// Unused-image cleanup (lib/imageCleanup.js): not personal data, so its own
// daily step. Removes at most one batch of images older than 7 days that no
// row references any more. Counts only in the log line.
const runImageCleanup = guardJob("Image cleanup", async () => {
  const { deleted, bytes } = await purgeUnusedImages(pool);
  console.log("Image cleanup:", JSON.stringify({ deleted, bytes }));
});
runImageCleanup();
const imageCleanupTimer = setInterval(runImageCleanup, 24 * 60 * 60 * 1000);

// Awards & best-seller lists (lib/awards): every 2 minutes look up a few
// books that have never been checked (newest first), plus retries of failed
// checks and a yearly refresh. This also back-fills old books gradually. No
// run at boot: the first tick comes after 2 minutes, so a restart-heavy host
// never hammers Wikidata, and a deploy is never slowed by it.
const runAwardsDrain = guardJob("Awards check", async () => {
  const { processed } = await drainAwards(pool);
  if (processed) console.log(`Awards check: ${processed} book(s) checked.`);
});
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
    const { processed, stored, failed } = await backfillCovers(pool);
    if (processed) console.log(`Cover backfill: ${stored} stored, ${failed} failed, ${processed} tried.`);
  });
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
  clearInterval(cartTimer);
  clearInterval(privacyTimer);
  clearInterval(imageCleanupTimer);
  clearInterval(awardsTimer);
  clearInterval(coverTimer);
  clearTimeout(coverFirstTimer);
  setTimeout(() => {
    console.error(`Shutdown did not finish within ${SHUTDOWN_TIMEOUT_MS / 1000}s - forcing exit.`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  server.close(() => {
    pool.end().then(
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
