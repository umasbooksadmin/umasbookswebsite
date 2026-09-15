const express = require("express");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { pool } = require("../db");
const { hashToken } = require("../lib/resetTokens");
const { sendResetLink } = require("../lib/passwordReset");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

function baseUrl(req) {
  return process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get("host")}`;
}

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
  const notice = req.query.reset === "success" ? "Password updated — log in with your new password." : null;
  res.render("login", { error: null, notice });
});

router.post("/login", authLimiter, async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";

  try {
    const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    const user = rows[0];
    const ok = user && (await bcrypt.compare(password, user.password_hash));
    if (!ok) {
      return res.status(401).render("login", { error: "Incorrect email or password.", notice: null });
    }
    req.session.user = { id: user.id, email: user.email, displayName: user.display_name, isAdmin: user.is_admin };
    res.redirect("/dashboard");
  } catch (err) {
    console.error(err);
    res.status(500).render("login", { error: "Something went wrong. Please try again.", notice: null });
  }
});

router.get("/forgot-password", (req, res) => {
  res.render("forgot_password", { notice: null, error: null });
});

router.post("/forgot-password", authLimiter, async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const notice = "If an account exists for that email, we've sent a password reset link.";

  if (email) {
    try {
      const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
      const user = rows[0];
      if (user) {
        await sendResetLink(user, baseUrl(req));
      }
    } catch (err) {
      console.error(err);
    }
  }
  res.render("forgot_password", { notice, error: null });
});

router.get("/reset-password/:token", async (req, res) => {
  const tokenHash = hashToken(req.params.token);
  const { rows } = await pool.query(
    "SELECT * FROM password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()",
    [tokenHash]
  );
  if (!rows.length) {
    return res.status(400).render("reset_password", { error: "This reset link is invalid or has expired.", token: null });
  }
  res.render("reset_password", { error: null, token: req.params.token });
});

router.post("/reset-password/:token", authLimiter, async (req, res) => {
  const newPassword = req.body.newPassword || "";
  const tokenHash = hashToken(req.params.token);

  const { rows } = await pool.query(
    "SELECT * FROM password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()",
    [tokenHash]
  );
  const record = rows[0];
  if (!record) {
    return res.status(400).render("reset_password", { error: "This reset link is invalid or has expired.", token: null });
  }
  if (newPassword.length < 8) {
    return res.status(400).render("reset_password", { error: "Password must be at least 8 characters.", token: req.params.token });
  }

  const hash = await bcrypt.hash(newPassword, 12);
  await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, record.user_id]);
  await pool.query("UPDATE password_reset_tokens SET used_at = now() WHERE id = $1", [record.id]);

  res.redirect("/login?reset=success");
});

router.get("/account/password", requireAuth, (req, res) => {
  res.render("change_password", { error: null, notice: null });
});

router.post("/account/password", requireAuth, async (req, res) => {
  const currentPassword = req.body.currentPassword || "";
  const newPassword = req.body.newPassword || "";

  if (newPassword.length < 8) {
    return res.status(400).render("change_password", { error: "New password must be at least 8 characters.", notice: null });
  }

  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [req.session.user.id]);
  const user = rows[0];
  const ok = user && (await bcrypt.compare(currentPassword, user.password_hash));
  if (!ok) {
    return res.status(401).render("change_password", { error: "Current password is incorrect.", notice: null });
  }

  const hash = await bcrypt.hash(newPassword, 12);
  await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, user.id]);
  res.render("change_password", { error: null, notice: "Password updated." });
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

module.exports = router;
