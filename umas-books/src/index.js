require("dotenv").config();
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
const helmet = require("helmet");
const multer = require("multer");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);

const { pool } = require("./db");
const { attachUser } = require("./middleware/auth");
const { csrfProtection } = require("./middleware/csrf");
const { expireStaleReservations, sendPickupReminders } = require("./lib/reservations");
const { expireStaleCartHolds, reconcilePendingOrders } = require("./lib/cart");

const authRoutes = require("./routes/auth");
const dashboardRoutes = require("./routes/dashboard");
const accountRoutes = require("./routes/account");
const forumRoutes = require("./routes/forum");
const charityRoutes = require("./routes/charity");
const volunteerRoutes = require("./routes/volunteer");
const meetingsRoutes = require("./routes/meetings");
const eventsRoutes = require("./routes/events");
const sessionsRoutes = require("./routes/sessions");
const booksRoutes = require("./routes/books");
const wishlistRoutes = require("./routes/wishlist");
const contactRoutes = require("./routes/contact");
const cartRoutes = require("./routes/cart");
const helloassoWebhookRoutes = require("./routes/helloassoWebhook");
const adminRoutes = require("./routes/admin");

const app = express();
const isProd = process.env.NODE_ENV === "production";

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));
app.use(express.static(path.join(__dirname, "..", "public")));

// Date/time display helpers, available in every view without importing.
Object.assign(app.locals, require("./lib/dates"));
// Session color-coding, shared by /sessions and /immersion/calendar.
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

app.set("trust proxy", 1);
app.use(
  session({
    store: new pgSession({ pool, createTableIfMissing: true }),
    name: "umasbooks.sid",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  })
);

app.use(attachUser(pool));
app.use((req, res, next) => {
  res.locals.cartCount = Array.isArray(req.session.cart) ? req.session.cart.length : 0;
  next();
});

// Multer must parse any multipart body under /admin/inventory (populating
// req.body._csrf and req.files) before the CSRF check below runs —
// csrfProtection only ever sees req.body as urlencoded-parsing (above)
// left it otherwise. Scoped as one middleware covering every field name
// used anywhere under this prefix (the ISBN-photo scan and the cover-photo
// upload), rather than one per route, so a single multipart request is
// never run through multer twice.
const inventoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
app.use("/admin/inventory", inventoryUpload.fields([
  { name: "photo", maxCount: 1 },
  { name: "coverPhoto", maxCount: 1 },
]));

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
  res.json({ token: res.locals.csrfToken });
});

// The public marketing site (repo root, one level up from this app) is
// served from here too, so this app's own URL is the one link that shows
// everything — the marketing pages alongside the Members Area.
// Its inline <script> blocks (per-page i18n strings, the Latest Arrivals
// carousel) predate this app and aren't nonce-tagged, so these routes
// carry their own relaxed CSP instead of the strict app-wide one above;
// the Members Area's own routes keep the stricter policy untouched.
const marketingRoot = path.join(__dirname, "..", "..");
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
  "volunteer.html", "wishlist.html", "privacy-policy.html", "membership-terms.html",
];

app.use("/assets", express.static(path.join(marketingRoot, "assets")));
app.get("/logo.png", (req, res) => res.sendFile(path.join(marketingRoot, "logo.png")));

app.get("/", (req, res) => {
  // Only an actual member/admin gets bounced to the Member's Access
  // dashboard — a logged-in visitor who isn't a member sees the regular
  // homepage like anyone else (see requireMember), otherwise this and
  // /dashboard's own redirect would loop forever on each other.
  const u = req.session.user;
  if (u && (u.isAdmin || u.isMember)) return res.redirect("/dashboard");
  res.set("Content-Security-Policy", marketingCsp);
  res.sendFile(path.join(marketingRoot, "index.html"));
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
    res.sendFile(path.join(marketingRoot, file));
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
app.use(sessionsRoutes);
app.use(booksRoutes);
app.use(cartRoutes);
app.use(wishlistRoutes);
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
process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  process.exit(1);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`umas-books listening on port ${port}`);
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
}
runReservationMaintenance();
setInterval(runReservationMaintenance, 6 * 60 * 60 * 1000);

// Same idea for the online-checkout cart, but on a much shorter interval
// than the reservation job above: a cart hold is only good for an hour
// (see CART_HOLD_TTL_MINUTES in lib/cart.js) and a buyer who closes the
// tab mid-payment is relying on this to notice their order never got
// reconciled by the webhook or the /cart/return page.
function runCartMaintenance() {
  expireStaleCartHolds(pool).catch((err) => console.error("Cart hold expiry failed:", err));
  reconcilePendingOrders(pool).catch((err) => console.error("Order reconciliation failed:", err));
}
runCartMaintenance();
setInterval(runCartMaintenance, 10 * 60 * 1000);
