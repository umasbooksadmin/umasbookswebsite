const express = require("express");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { pool } = require("../db");

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

router.get("/signup", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.render("signup", { error: null });
});

router.post("/signup", authLimiter, async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";
  const displayName = (req.body.displayName || "").trim();

  if (!email || !password || !displayName) {
    return res.status(400).render("signup", { error: "All fields are required." });
  }
  if (password.length < 8) {
    return res.status(400).render("signup", { error: "Password must be at least 8 characters." });
  }

  try {
    const { rows: existing } = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.length) {
      return res.status(400).render("signup", { error: "An account with that email already exists." });
    }
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3)
       RETURNING id, email, display_name, is_admin`,
      [email, hash, displayName]
    );
    const user = rows[0];
    req.session.user = { id: user.id, email: user.email, displayName: user.display_name, isAdmin: user.is_admin };
    res.redirect("/dashboard");
  } catch (err) {
    console.error(err);
    res.status(500).render("signup", { error: "Something went wrong. Please try again." });
  }
});

router.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.render("login", { error: null });
});

router.post("/login", authLimiter, async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";

  try {
    const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    const user = rows[0];
    const ok = user && (await bcrypt.compare(password, user.password_hash));
    if (!ok) {
      return res.status(401).render("login", { error: "Incorrect email or password." });
    }
    req.session.user = { id: user.id, email: user.email, displayName: user.display_name, isAdmin: user.is_admin };
    res.redirect("/dashboard");
  } catch (err) {
    console.error(err);
    res.status(500).render("login", { error: "Something went wrong. Please try again." });
  }
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

module.exports = router;
