const express = require("express");
const { pool } = require("../db");
const { requireMember } = require("../middleware/auth");
const { CHARITY_CATEGORIES } = require("../lib/charityCategories");

const router = express.Router();

async function loadActiveRound(userId) {
  const { rows: roundRows } = await pool.query(
    "SELECT * FROM charity_rounds WHERE is_active = TRUE ORDER BY opens_at DESC LIMIT 1"
  );
  if (!roundRows.length) return null;
  const round = roundRows[0];
  const { rows: options } = await pool.query(
    `SELECT o.id, COALESCE(c.name, o.name) AS name, COALESCE(c.description, o.description) AS description,
            c.category, c.image_url, c.website_url,
            (SELECT COUNT(*) FROM charity_votes v WHERE v.option_id = o.id)::int AS vote_count
     FROM charity_options o LEFT JOIN charities c ON c.id = o.charity_id
     WHERE o.round_id = $1 ORDER BY o.id ASC`,
    [round.id]
  );
  let myOptionIds = [];
  if (userId) {
    const { rows: myVotes } = await pool.query(
      "SELECT option_id FROM charity_votes WHERE round_id = $1 AND user_id = $2",
      [round.id, userId]
    );
    myOptionIds = myVotes.map((v) => v.option_id);
  }
  const isClosed = round.closes_at ? new Date(round.closes_at) <= new Date() : false;
  const showResults = round.show_results_during_vote || isClosed;
  return { round, options, myOptionIds, isClosed, showResults };
}

// Fully public route (no requireMember gate) so a round set to "visible to
// everyone" (see the Vote Settings panel in /admin/charity) can actually
// be seen by a logged-out visitor — voting and suggesting an idea still
// require membership, enforced on those two POST routes below. With no
// active round, or one still set to "members only", this keeps the prior
// behavior of sending a non-member away.
router.get("/charity", async (req, res) => {
  const user = req.session.user;
  const isMember = Boolean(user && (user.isAdmin || user.isMember || user.isVolunteer));
  const charity = await loadActiveRound(user ? user.id : null);

  const publiclyVisible = charity && charity.round.visible_to === "everyone";
  if (!publiclyVisible && !isMember) {
    return res.redirect(user ? "/" : "/login");
  }

  const { rows: myIdeas } = user
    ? await pool.query("SELECT * FROM charity_ideas WHERE submitted_by = $1 ORDER BY created_at DESC LIMIT 10", [user.id])
    : { rows: [] };

  res.render("charity", { charity, isMember, myIdeas, categories: CHARITY_CATEGORIES });
});

router.post("/charity/vote", requireMember, async (req, res) => {
  const userId = req.session.user.id;
  const { rows: roundRows } = await pool.query(
    "SELECT * FROM charity_rounds WHERE is_active = TRUE ORDER BY opens_at DESC LIMIT 1"
  );
  const round = roundRows[0];
  if (!round) return res.redirect("/charity");

  const { rows: validOptions } = await pool.query("SELECT id FROM charity_options WHERE round_id = $1", [round.id]);
  const validIds = new Set(validOptions.map((o) => o.id));

  let selected = [].concat(req.body.optionIds || []).map(Number).filter((id) => validIds.has(id));
  if (!round.allow_multiple) selected = selected.slice(0, 1);

  await pool.query("DELETE FROM charity_votes WHERE round_id = $1 AND user_id = $2", [round.id, userId]);
  for (const optionId of selected) {
    await pool.query(
      "INSERT INTO charity_votes (round_id, option_id, user_id) VALUES ($1, $2, $3)",
      [round.id, optionId, userId]
    );
  }
  res.redirect("/charity");
});

router.post("/charity/ideas", requireMember, async (req, res) => {
  const name = (req.body.name || "").trim();
  const description = (req.body.description || "").trim() || null;
  const category = CHARITY_CATEGORIES.includes(req.body.category) ? req.body.category : null;
  const websiteUrl = (req.body.websiteUrl || "").trim() || null;
  if (name) {
    await pool.query(
      "INSERT INTO charity_ideas (name, description, category, website_url, submitted_by) VALUES ($1, $2, $3, $4, $5)",
      [name, description, category, websiteUrl, req.session.user.id]
    );
  }
  res.redirect("/charity");
});

module.exports = router;
