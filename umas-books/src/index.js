require("dotenv").config();
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const multer = require("multer");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);

const { pool } = require("./db");
const { attachUser } = require("./middleware/auth");
const { csrfProtection } = require("./middleware/csrf");

const authRoutes = require("./routes/auth");
const dashboardRoutes = require("./routes/dashboard");
const forumRoutes = require("./routes/forum");
const charityRoutes = require("./routes/charity");
const volunteerRoutes = require("./routes/volunteer");
const meetingsRoutes = require("./routes/meetings");
const eventsRoutes = require("./routes/events");
const classesRoutes = require("./routes/classes");
const booksRoutes = require("./routes/books");
const adminRoutes = require("./routes/admin");

const app = express();
const isProd = process.env.NODE_ENV === "production";

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));
app.use(express.static(path.join(__dirname, "..", "public")));

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

app.use(csrfProtection);

app.get("/", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.render("landing");
});

app.use(authRoutes);
app.use(dashboardRoutes);
app.use(forumRoutes);
app.use(charityRoutes);
app.use(volunteerRoutes);
app.use(meetingsRoutes);
app.use(eventsRoutes);
app.use(classesRoutes);
app.use(booksRoutes);
app.use(adminRoutes);

app.use((req, res) => {
  res.status(404).render("404");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`umas-books listening on port ${port}`);
});
