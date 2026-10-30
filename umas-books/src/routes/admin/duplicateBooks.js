// Admin > Reports > Possible duplicate books (lib/duplicateBooks.js). Read only: GET only, nothing is changed.

const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { listDuplicateBooks } = require("../../lib/duplicateBooks");

const router = express.Router();
const SHOWN = 200;

router.get("/admin/reports/possible-duplicate-books", requireAdmin, async (req, res) => {
  const groups = await listDuplicateBooks(pool);
  res.render("admin/reports/duplicate_books", {
    active: "reports", title: "Possible duplicate books", pageTitle: "Possible duplicate books",
    pageSub: "Books that may have been entered twice. Nothing here merges or changes a book.",
    total: groups.length, groups: groups.slice(0, SHOWN), shown: SHOWN,
  });
});

module.exports = router;
