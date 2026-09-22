const express = require("express");
const { pool } = require("../db");

const router = express.Router();

// Public — no login required. Anyone can request a title for the shop
// to look out for; staff review requests in admin.

router.get("/wishlist", (req, res) => {
  res.render("wishlist", { error: null, success: req.query.success === "1" });
});

router.post("/wishlist", async (req, res) => {
  const title = (req.body.title || "").trim();
  const author = (req.body.author || "").trim() || null;
  const email = (req.body.email || "").trim().toLowerCase();

  if (!title || !email) {
    return res.status(400).render("wishlist", {
      error: "Please enter the book's title and your email.",
      success: false,
    });
  }

  await pool.query(
    "INSERT INTO wishlist_requests (title, author, email) VALUES ($1, $2, $3)",
    [title, author, email]
  );
  res.redirect("/wishlist?success=1");
});

module.exports = router;
