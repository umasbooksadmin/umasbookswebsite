require("dotenv").config();
// Fail fast (production only) with one clear message, before db.js is loaded.
require("./lib/env").checkEnv();
const path = require("path");
const express = require("express");
// Patches Express's router so a rejected promise from any async route
// handler below is forwarded to the error-handling middleware at the
// bottom of this file, instead of becoming an unhandled rejection.
// Express 4 doesn't do this itself (fixed in Express 5) — without it, a
// single transient error (e.g. a dropped DB connection) in any one of
// this app's ~50 async handlers, none of which wrap their own
// try/catch, crashes the whole process for every visitor rather than
// just failing that one request. Must load before any router below is
// required, since it patches Router/Layer as they're defined.
require("express-async-errors");
const compression = require("compression");
const helmet = require("helmet");
const multer = require("multer");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);

const { pool } = require("./db");
const { attachUser, requireAdmin } = require("./middleware/auth");
const { csrfProtection, ensureToken } = require("./middleware/csrf");
const { expireStaleReservations, sendPickupReminders } = require("./lib/reservations");
const { expireStaleCartHolds, reconcilePendingOrders } = require("./lib/cart");
const { expireStaleMemberships, reconcileRecentMemberships } = require("./lib/membership");
const { alertOnError } = require("./lib/errorAlert");

const authRoutes = require("./routes/auth");
const dashboardRoutes = require("./routes/dashboard");
const accountRoutes = require("./routes/account");
const forumRoutes = require("./routes/forum");
const charityRoutes = require("./routes/charity");
const volunteerRoutes = require("./routes/volunteer");
const meetingsRoutes = require("./routes/meetings");
const eventsRoutes = require("./routes/events");
const blogRoutes = require("./routes/blog");
const sessionsRoutes = require("./routes/sessions");
const booksRoutes = require("./routes/books");
const contactRoutes = require("./routes/contact");
const cartRoutes = require("./routes/cart");
const helloassoWebhookRoutes = require("./routes/helloassoWebhook");
const adminRoutes = require("./routes/admin");

const app = express();
const isProd = process.env.NODE_ENV === "production";

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));
// gzip/deflate for text responses (HTML, JSON, CSS, JS, SVG);
// compression() skips already-compressed types (images) on its own.
// First, so static files and JSON endpoints below are all covered.
app.use(compression());

// maxAge 7d on static files: filenames aren't content-hashed (about.css,
// site.js, ... keep the same URL when they change), so a long immutable
// cache isn't safe. 7 days is a compromise — repeat visitors stop
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
app.get("/logo.png", (req, res) => res.sendFile(path.join(marketingRoot, "logo.png")));

// For the external uptime check (see .github/workflows/uptime-check.yml)
// to actually catch what happened on 2026-09-26 — the process was up
// and answering "/" the whole time, but every DB-backed route was
// broken — this has to genuinely touch the database, not just confirm
// the process is alive. Registered before session/helmet/csrf so a
// broken DB can't also break the session store's own read on the way
// to this route.
app.get("/healthz", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({ ok: true });
  } catch (err) {
    // This route is public and unauthenticated (the uptime-check workflow
    // and Render's own health probe both hit it with no login) — logging
    // the real error server-side, rather than handing a raw database
    // error message (connection details, driver internals, ...) to
    // whoever's asking, same reasoning as never surfacing a raw err in
    // any other response.
    console.error("Health check failed:", err.message);
    res.status(503).json({ ok: false });
  }
});

// Date/time display helpers, available in every view without importing.
Object.assign(app.locals, require("./lib/dates"));
// Session color-coding, used by the /sessions calendar.
Object.assign(app.locals, require("./lib/sessionTone"));
app.locals.mondayFirstWeeks = require("./lib/calendar").mondayFirstWeeks;

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https://covers.openlibrary.org", "https://archive.org", "https://*.archive.org"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
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
const MULTI_VALUE_BODY_FIELDS = new Set(["optionIds", "ids"]);
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
app.set("trust proxy", 1);
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
// 30 days. An active visitor therefore stays logged in indefinitely; an
// idle one still expires 30 days (give or take a day) after last visit.
app.use((req, res, next) => {
  const expires = req.session && req.session.cookie && req.session.cookie.expires;
  if (expires && new Date(expires).getTime() - Date.now() < SESSION_MAX_AGE_MS - SESSION_REFRESH_AFTER_MS) {
    req.session.refreshedAt = Date.now();
  }
  next();
});

app.use(attachUser(pool));
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
app.get("/api/csrf-token", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ token: ensureToken(req) });
});

// Same idea as /api/cart/count above: the marketing site's static HTML
// has no server-side session rendering, so it can't know a visitor is
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
const marketingCsp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https://covers.openlibrary.org https://archive.org https://*.archive.org",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
const MARKETING_PAGES = [
  "about.html", "blog.html", "books.html", "events.html", "programs.html",
  "immersion.html", "pre-registration.html", "membership.html", "visit.html",
  "volunteer.html", "privacy-policy.html", "membership-terms.html",
];


app.get("/", (req, res) => {
  // Only an actual member/volunteer/admin gets bounced to the Member's
  // Access dashboard — a logged-in visitor who isn't gets the regular
  // homepage like anyone else (see requireMember), otherwise this and
  // /dashboard's own redirect would loop forever on each other.
  const u = req.session.user;
  if (u && (u.isAdmin || u.isMember || u.isVolunteer)) return res.redirect("/dashboard");
  res.set("Content-Security-Policy", marketingCsp);
  res.render("marketing/index");
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

MARKETING_PAGES.forEach((file) => {
  app.get("/" + file, (req, res) => {
    res.set("Content-Security-Policy", marketingCsp);
    res.render("marketing/" + file.replace(/\.html$/, ""));
  });
});

app.use(authRoutes);
app.use(dashboardRoutes);
app.use(accountRoutes);
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
app.use(adminRoutes);

app.use((req, res) => {
  res.status(404).render("404");
});

// Last-resort handler for anything a route threw or rejected with
// (forwarded here automatically by express-async-errors, above). Never
// shows the visitor error detail — that goes to the log only — and
// falls back to a plain text response if even rendering the error page
// itself fails (e.g. the DB is down and a view needs res.locals.user).
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  alertOnError(`Error on ${req.method} ${req.originalUrl}`, err);
  if (res.headersSent) return next(err);
  res.status(500);
  res.render("500", (renderErr, html) => {
    if (renderErr) return res.type("text").send("Something went wrong. Please try again.");
    res.send(html);
  });
});

// Both of these mean some error escaped every other net (route handlers
// go through express-async-errors above; the background jobs below
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
const server = app.listen(port, () => {
  console.log(`umas-books listening on port ${port}`);
});

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
function runReservationMaintenance() {
  expireStaleReservations(pool).catch((err) => console.error("Reservation expiry failed:", err));
  sendPickupReminders(pool).catch((err) => console.error("Pickup reminders failed:", err));
  expireStaleMemberships(pool).catch((err) => console.error("Membership expiry failed:", err));
  reconcileRecentMemberships(pool).catch((err) => console.error("Membership reconciliation failed:", err));
}
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
function runCartMaintenance() {
  const includeClosed = cartMaintenanceTick++ % 6 === 0;
  expireStaleCartHolds(pool).catch((err) => console.error("Cart hold expiry failed:", err));
  reconcilePendingOrders(pool, { includeClosed }).catch((err) => console.error("Order reconciliation failed:", err));
}
runCartMaintenance();
const cartTimer = setInterval(runCartMaintenance, 10 * 60 * 1000);

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
