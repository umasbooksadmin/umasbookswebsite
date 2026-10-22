const express = require("express");
const { saveImage } = require("../../lib/imageStore");
const { sharpFromUpload } = require("../../lib/uploadImage");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { audit } = require("../../lib/audit");
const { parseLocalDateTime } = require("../../lib/dates");
const { CHARITY_CATEGORIES } = require("../../lib/charityCategories");

const { validateIdParams } = require("../../middleware/idParams");
const { cleanHttpUrl, parseId, clean } = require("../../lib/validation");
const { likeContains } = require("../../lib/parseParams");

const router = express.Router();
// Garbage ids get the 404 page, not a Postgres 22P02 and a 500.
validateIdParams(router, "id");

// ---------- Charity vote ----------

async function processCharityImage(file) {
  const resized = await sharpFromUpload(file.buffer)
    .rotate()
    .resize(600, 400, { fit: "cover" })
    .jpeg({ quality: 78 })
    .toBuffer();
  return saveImage(resized, "image/jpeg");
}

// Every round-options query joins back to the library this way — a
// library-linked option (charity_id set) always shows the charity's
// current name/description/etc, never a stale copy; a pre-redesign
// free-text option (charity_id NULL) falls back to its own columns.
const CHARITY_OPTION_SELECT = `
  SELECT o.id, o.round_id, o.charity_id,
         COALESCE(c.name, o.name) AS name,
         COALESCE(c.description, o.description) AS description,
         c.category, c.image_url, c.website_url,
         (SELECT COUNT(*) FROM charity_votes v WHERE v.option_id = o.id)::int AS vote_count
  FROM charity_options o LEFT JOIN charities c ON c.id = o.charity_id
`;

router.get("/admin/charity", requireAdmin, async (req, res) => {
  const tab = ["current", "library", "ideas", "past"].includes(req.query.tab) ? req.query.tab : "current";
  const ideasSubTab = ["pending", "approved", "rejected"].includes(req.query.ideasTab) ? req.query.ideasTab : "pending";
  const q = clean(req.query.q, 100);

  const { rows: activeRounds } = await pool.query("SELECT * FROM charity_rounds WHERE is_active = TRUE ORDER BY opens_at DESC LIMIT 1");
  const activeRound = activeRounds[0] || null;

  let currentOptions = [];
  if (activeRound) {
    const { rows } = await pool.query(`${CHARITY_OPTION_SELECT} WHERE o.round_id = $1 ORDER BY o.id ASC`, [activeRound.id]);
    currentOptions = rows;
  }
  const totalCurrentVotes = currentOptions.reduce((sum, o) => sum + o.vote_count, 0);

  const libParams = [];
  let libWhere = "WHERE is_archived = FALSE";
  if (q) {
    libParams.push(likeContains(q));
    libWhere += ` AND (name ILIKE $${libParams.length} OR category ILIKE $${libParams.length})`;
  }
  const { rows: libraryCharities } = await pool.query(`SELECT * FROM charities ${libWhere} ORDER BY name ASC`, libParams);
  const includedCharityIds = new Set(currentOptions.filter((o) => o.charity_id).map((o) => o.charity_id));
  const availableCharities = libraryCharities.filter((c) => !includedCharityIds.has(c.id));

  const { rows: allIdeas } = await pool.query(
    "SELECT i.*, u.display_name AS submitted_by_name FROM charity_ideas i LEFT JOIN users u ON u.id = i.submitted_by ORDER BY i.created_at DESC"
  );
  const ideaCounts = { pending: 0, approved: 0, rejected: 0 };
  for (const idea of allIdeas) ideaCounts[idea.status]++;
  const ideas = allIdeas.filter((i) => i.status === ideasSubTab);

  const { rows: pastRounds } = await pool.query("SELECT * FROM charity_rounds WHERE is_active = FALSE ORDER BY opens_at DESC LIMIT 20");
  const pastRoundsWithResults = [];
  for (const r of pastRounds) {
    const { rows: opts } = await pool.query(
      `${CHARITY_OPTION_SELECT} WHERE o.round_id = $1 ORDER BY vote_count DESC`,
      [r.id]
    );
    pastRoundsWithResults.push({ round: r, options: opts, total: opts.reduce((sum, o) => sum + o.vote_count, 0) });
  }

  res.render("admin/charity", {
    active: "charity",
    tab,
    ideasSubTab,
    q,
    activeRound,
    currentOptions,
    totalCurrentVotes,
    libraryCharities,
    availableCharities,
    categories: CHARITY_CATEGORIES,
    ideas,
    ideaCounts,
    pastRoundsWithResults,
  });
});

router.post("/admin/charity-rounds", requireAdmin, async (req, res) => {
  const title = (req.body.title || "").trim();
  const label = (req.body.label || "").trim() || null;
  const opensAt = parseLocalDateTime(req.body.opensAt);
  const closesAt = parseLocalDateTime(req.body.closesAt);
  const allowMultiple = req.body.allowMultiple === "on";
  const visibleTo = req.body.visibleTo === "everyone" ? "everyone" : "members";
  const showResultsDuringVote = req.body.showResultsDuringVote === "on";

  if (title) {
    await pool.query("UPDATE charity_rounds SET is_active = FALSE WHERE is_active = TRUE");
    await pool.query(
      `INSERT INTO charity_rounds (title, label, opens_at, closes_at, allow_multiple, visible_to, show_results_during_vote, is_active)
       VALUES ($1, $2, COALESCE($3::timestamptz, now()), $4, $5, $6, $7, TRUE)`,
      [title, label, opensAt, closesAt, allowMultiple, visibleTo, showResultsDuringVote]
    );
  }
  res.redirect("/admin/charity?tab=current");
});

router.post("/admin/charity-rounds/:id/settings", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const title = (req.body.title || "").trim();
  const label = (req.body.label || "").trim() || null;
  const opensAt = parseLocalDateTime(req.body.opensAt);
  const closesAt = parseLocalDateTime(req.body.closesAt);
  const allowMultiple = req.body.allowMultiple === "on";
  const visibleTo = req.body.visibleTo === "everyone" ? "everyone" : "members";
  const showResultsDuringVote = req.body.showResultsDuringVote === "on";

  if (title) {
    await pool.query(
      `UPDATE charity_rounds SET title=$1, label=$2, opens_at = COALESCE($3::timestamptz, opens_at), closes_at=$4,
         allow_multiple=$5, visible_to=$6, show_results_during_vote=$7 WHERE id=$8`,
      [title, label, opensAt, closesAt, allowMultiple, visibleTo, showResultsDuringVote, id]
    );
  }
  res.redirect("/admin/charity?tab=current");
});

router.post("/admin/charity-rounds/:id/close", requireAdmin, async (req, res) => {
  await pool.query(
    "UPDATE charity_rounds SET is_active = FALSE, closes_at = COALESCE(closes_at, now()) WHERE id = $1",
    [Number(req.params.id)]
  );
  res.redirect("/admin/charity?tab=past");
});

router.post("/admin/charities", requireAdmin, async (req, res) => {
  const name = (req.body.name || "").trim();
  const description = (req.body.description || "").trim() || null;
  const category = CHARITY_CATEGORIES.includes(req.body.category) ? req.body.category : null;
  const websiteUrl = cleanHttpUrl(req.body.websiteUrl);
  const addToCurrentVote = req.body.addToCurrentVote === "on";
  const returnTab = req.body.returnTab === "current" ? "current" : "library";

  if (!name) return res.redirect(`/admin/charity?tab=${returnTab}`);

  const imageFile = req.files && req.files.image && req.files.image[0];
  const imageUrl = imageFile ? await processCharityImage(imageFile) : null;

  const { rows } = await pool.query(
    `INSERT INTO charities (name, description, category, website_url, image_url, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [name, description, category, websiteUrl, imageUrl, req.session.user.id]
  );

  if (addToCurrentVote) {
    const { rows: activeRounds } = await pool.query("SELECT id FROM charity_rounds WHERE is_active = TRUE LIMIT 1");
    if (activeRounds.length) {
      await pool.query(
        "INSERT INTO charity_options (round_id, charity_id, name) VALUES ($1, $2, $3) ON CONFLICT (round_id, charity_id) DO NOTHING",
        [activeRounds[0].id, rows[0].id, name]
      );
    }
  }
  res.redirect(`/admin/charity?tab=${returnTab}`);
});

router.post("/admin/charities/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const name = (req.body.name || "").trim();
  const description = (req.body.description || "").trim() || null;
  const category = CHARITY_CATEGORIES.includes(req.body.category) ? req.body.category : null;
  const websiteUrl = cleanHttpUrl(req.body.websiteUrl);
  const returnTab = req.body.returnTab === "current" ? "current" : "library";

  if (!name) return res.redirect(`/admin/charity?tab=${returnTab}`);

  const imageFile = req.files && req.files.image && req.files.image[0];
  if (imageFile) {
    const imageUrl = await processCharityImage(imageFile);
    await pool.query(
      "UPDATE charities SET name=$1, description=$2, category=$3, website_url=$4, image_url=$5 WHERE id=$6",
      [name, description, category, websiteUrl, imageUrl, id]
    );
  } else {
    await pool.query(
      "UPDATE charities SET name=$1, description=$2, category=$3, website_url=$4 WHERE id=$5",
      [name, description, category, websiteUrl, id]
    );
  }
  res.redirect(`/admin/charity?tab=${returnTab}`);
});

router.post("/admin/charities/:id/archive", requireAdmin, async (req, res) => {
  await pool.query("UPDATE charities SET is_archived = NOT is_archived WHERE id = $1", [Number(req.params.id)]);
  res.redirect(`/admin/charity?tab=${req.body.returnTab === "current" ? "current" : "library"}`);
});

router.post("/admin/charity-options", requireAdmin, async (req, res) => {
  const charityId = parseId(req.body.charityId);
  if (charityId !== null) {
    const { rows: activeRounds } = await pool.query("SELECT id FROM charity_rounds WHERE is_active = TRUE LIMIT 1");
    const { rows: charityRows } = await pool.query("SELECT name FROM charities WHERE id = $1", [charityId]);
    if (activeRounds.length && charityRows.length) {
      await pool.query(
        "INSERT INTO charity_options (round_id, charity_id, name) VALUES ($1, $2, $3) ON CONFLICT (round_id, charity_id) DO NOTHING",
        [activeRounds[0].id, charityId, charityRows[0].name]
      );
    }
  }
  res.redirect("/admin/charity?tab=current");
});

router.post("/admin/charity-options/:id/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM charity_options WHERE id = $1", [Number(req.params.id)]);
  await audit(req, { action: "charity_option.delete", targetType: "charity_option", targetId: Number(req.params.id) });
  res.redirect("/admin/charity?tab=current");
});

router.post("/admin/charity-ideas/:id/approve", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query("SELECT * FROM charity_ideas WHERE id = $1", [id]);
  const idea = rows[0];
  if (idea && idea.status === "pending") {
    const { rows: charityRows } = await pool.query(
      "INSERT INTO charities (name, description, category, website_url, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [idea.name, idea.description, idea.category, cleanHttpUrl(idea.website_url), req.session.user.id]
    );
    await pool.query("UPDATE charity_ideas SET status = 'approved', resulting_charity_id = $1 WHERE id = $2", [charityRows[0].id, id]);
  }
  res.redirect("/admin/charity?tab=ideas&ideasTab=pending");
});

router.post("/admin/charity-ideas/:id/reject", requireAdmin, async (req, res) => {
  await pool.query("UPDATE charity_ideas SET status = 'rejected' WHERE id = $1 AND status = 'pending'", [Number(req.params.id)]);
  res.redirect("/admin/charity?tab=ideas&ideasTab=pending");
});

router.post("/admin/charity-ideas/:id/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM charity_ideas WHERE id = $1", [Number(req.params.id)]);
  await audit(req, { action: "charity_idea.delete", targetType: "charity_idea", targetId: Number(req.params.id) });
  res.redirect(`/admin/charity?tab=ideas&ideasTab=${["pending", "approved", "rejected"].includes(req.body.ideasTab) ? req.body.ideasTab : "pending"}`);
});

module.exports = router;
