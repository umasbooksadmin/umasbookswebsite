require("dotenv").config();
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);

const { pool } = require("./db");
const { attachUser } = require("./middleware/auth");

const authRoutes = require("./routes/auth");
const dashboardRoutes = require("./routes/dashboard");
const forumRoutes = require("./routes/forum");
const eventsRoutes = require("./routes/events");
const charityRoutes = require("./routes/charity");
const volunteerRoutes = require("./routes/volunteer");
const adminRoutes = require("./routes/admin");

const app = express();
const isProd = process.env.NODE_ENV === "production";

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));
app.use(express.static(path.join(__dirname, "..", "public")));

app.use(helmet({ contentSecurityPolicy: false }));
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

app.get("/", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.render("landing");
});

app.use(authRoutes);
app.use(dashboardRoutes);
app.use(forumRoutes);
app.use(eventsRoutes);
app.use(charityRoutes);
app.use(volunteerRoutes);
app.use(adminRoutes);

app.use((req, res) => {
  res.status(404).render("404");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Members app listening on port ${port}`);
});
