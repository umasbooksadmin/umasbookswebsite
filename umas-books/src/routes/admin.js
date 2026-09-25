const express = require("express");
const sharp = require("sharp");
const { pool } = require("../db");
const { requireAdmin } = require("../middleware/auth");
const { parseMonthParam, monthRange, monthGrid, groupByDate, monthNav } = require("../lib/calendar");
const { normalizeIsbn, lookupByIsbn, searchByTitleAuthor, translateGenresToFrench } = require("../lib/bookLookup");
const { extractBookInfoFromPhoto } = require("../lib/coverVision");
const { generateBookDescription, translateDescriptionToFrench } = require("../lib/bookDescription");
const { CONDITIONS, STATUSES, normalizeCondition, normalizeStatus, normalizeGenres } = require("../lib/inventory");
const { expireStaleReservations, matchWishlistOnArrival } = require("../lib/reservations");
const { seatsTakenExpr } = require("../lib/classCapacity");

const router = express.Router();

// Best-effort cover lookup for books saved without one — tries the ISBN
// first (most precise), then falls back to a title/author search.
async function findCoverUrl({ isbn, title, author }) {
  if (isbn) {
    const byIsbn = await lookupByIsbn(isbn);
    if (byIsbn && byIsbn.coverUrl) return byIsbn.coverUrl;
  }
  if (title) {
    const candidates = await searchByTitleAuthor(title, author);
    const withCover = candidates.find((c) => c.coverUrl);
    if (withCover) return withCover.coverUrl;
  }
  return null;
}

// Render has no persistent disk, so an uploaded cover photo can't be
// saved to the filesystem — it's resized/compressed down to a small
// thumbnail and stored inline as a data URI in the same cover_url column
// a lookup-sourced image URL would go in.
async function processCoverPhoto(file) {
  const resized = await sharp(file.buffer)
    .rotate()
    .resize(500, 700, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 78 })
    .toBuffer();
  return `data:image/jpeg;base64,${resized.toString("base64")}`;
}

// ---------- Overview ----------

router.get("/admin", requireAdmin, async (req, res) => {
  const [memberCount, upcomingShifts, activeRound, nextMeeting, inStockCount, upcomingEvents, upcomingClasses, openWishlist] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS n FROM users"),
    pool.query("SELECT COUNT(*)::int AS n FROM volunteer_shifts WHERE starts_at >= now()"),
    pool.query("SELECT * FROM charity_rounds WHERE is_active = TRUE ORDER BY opens_at DESC LIMIT 1"),
    pool.query("SELECT * FROM meetings WHERE scheduled_at >= now() ORDER BY scheduled_at ASC LIMIT 1"),
    pool.query("SELECT COUNT(*)::int AS n FROM book_copies WHERE status = 'in_stock'"),
    pool.query("SELECT COUNT(*)::int AS n FROM events WHERE starts_at >= now()"),
    pool.query("SELECT COUNT(*)::int AS n FROM classes WHERE starts_at >= now()"),
    pool.query("SELECT COUNT(*)::int AS n FROM wishlist_requests WHERE status = 'open'"),
  ]);

  res.render("admin/index", {
    active: "overview",
    memberCount: memberCount.rows[0].n,
    upcomingShiftCount: upcomingShifts.rows[0].n,
    activeRound: activeRound.rows[0] || null,
    nextMeeting: nextMeeting.rows[0] || null,
    inStockCount: inStockCount.rows[0].n,
    upcomingEventCount: upcomingEvents.rows[0].n,
    upcomingClassCount: upcomingClasses.rows[0].n,
    openWishlistCount: openWishlist.rows[0].n,
  });
});

// ---------- Members ----------

router.get("/admin/members", requireAdmin, async (req, res) => {
  const { rows: members } = await pool.query("SELECT id, email, display_name, is_admin, is_member FROM users ORDER BY created_at DESC LIMIT 200");
  res.render("admin/members", { active: "members", members });
});

router.post("/admin/members/:id/toggle-member", requireAdmin, async (req, res) => {
  await pool.query("UPDATE users SET is_member = NOT is_member WHERE id = $1", [Number(req.params.id)]);
  res.redirect("/admin/members");
});

// ---------- Announcements ----------

router.get("/admin/announcements", requireAdmin, async (req, res) => {
  const { rows: announcements } = await pool.query("SELECT * FROM announcements ORDER BY published_at DESC LIMIT 20");
  res.render("admin/announcements", { active: "announcements", announcements });
});

router.post("/admin/announcements", requireAdmin, async (req, res) => {
  const title = (req.body.title || "").trim();
  const body = (req.body.body || "").trim();
  if (title && body) {
    await pool.query(
      "INSERT INTO announcements (title, body, created_by) VALUES ($1, $2, $3)",
      [title, body, req.session.user.id]
    );
  }
  res.redirect("/admin/announcements");
});

// ---------- Volunteer shifts ----------

router.get("/admin/volunteer-shifts", requireAdmin, async (req, res) => {
  const { year, month } = parseMonthParam(req.query.month);
  const { start, end } = monthRange(year, month);
  const { rows: shifts } = await pool.query(
    `SELECT s.*, (SELECT COUNT(*) FROM volunteer_signups g WHERE g.shift_id = s.id) AS signup_count
     FROM volunteer_shifts s WHERE s.starts_at >= $1 AND s.starts_at < $2 ORDER BY s.starts_at ASC`,
    [start, end]
  );
  const weeks = monthGrid(year, month, groupByDate(shifts, "starts_at"));
  res.render("admin/volunteer", { active: "volunteer", weeks, ...monthNav(year, month) });
});

router.post("/admin/volunteer-shifts", requireAdmin, async (req, res) => {
  const role = (req.body.role || "").trim();
  const date = req.body.date;
  const startTime = req.body.startTime;
  const endTime = req.body.endTime;
  const notes = (req.body.notes || "").trim() || null;
  const repeatWeeks = Math.max(1, Math.min(52, Number(req.body.repeatWeeks) || 1));

  if (role && date && startTime && endTime) {
    const start = new Date(`${date}T${startTime}`);
    const end = new Date(`${date}T${endTime}`);
    const weekMs = 7 * 24 * 60 * 60 * 1000;

    for (let i = 0; i < repeatWeeks; i++) {
      const s = new Date(start.getTime() + i * weekMs);
      const e = new Date(end.getTime() + i * weekMs);
      await pool.query(
        `INSERT INTO volunteer_shifts (role, starts_at, ends_at, capacity, notes, created_by)
         VALUES ($1, $2, $3, 1, $4, $5)`,
        [role, s.toISOString(), e.toISOString(), notes, req.session.user.id]
      );
    }
  }
  res.redirect(req.body.month ? `/admin/volunteer-shifts?month=${req.body.month}` : "/admin/volunteer-shifts");
});

router.post("/admin/volunteer-shifts/:id/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM volunteer_shifts WHERE id = $1", [Number(req.params.id)]);
  res.redirect(req.query.month ? `/admin/volunteer-shifts?month=${req.query.month}` : "/admin/volunteer-shifts");
});

// ---------- Meetings ----------

router.get("/admin/meetings", requireAdmin, async (req, res) => {
  const { year, month } = parseMonthParam(req.query.month);
  const { start, end } = monthRange(year, month);
  const { rows: meetings } = await pool.query(
    `SELECT m.*, (SELECT COUNT(*) FROM meeting_rsvps r WHERE r.meeting_id = m.id) AS rsvp_count
     FROM meetings m WHERE m.scheduled_at >= $1 AND m.scheduled_at < $2 ORDER BY m.scheduled_at ASC`,
    [start, end]
  );
  const weeks = monthGrid(year, month, groupByDate(meetings, "scheduled_at"));
  res.render("admin/meetings", { active: "meetings", weeks, ...monthNav(year, month) });
});

router.post("/admin/meetings", requireAdmin, async (req, res) => {
  const title = (req.body.title || "").trim();
  const date = req.body.date;
  const time = req.body.time;
  const location = (req.body.location || "").trim() || null;
  const agenda = (req.body.agenda || "").trim() || null;

  if (title && date && time) {
    const scheduledAt = `${date}T${time}`;
    await pool.query(
      `INSERT INTO meetings (title, scheduled_at, location, agenda, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [title, scheduledAt, location, agenda, req.session.user.id]
    );
  }
  res.redirect(req.body.month ? `/admin/meetings?month=${req.body.month}` : "/admin/meetings");
});

router.post("/admin/meetings/:id/minutes", requireAdmin, async (req, res) => {
  const minutes = (req.body.minutes || "").trim() || null;
  await pool.query("UPDATE meetings SET minutes = $1 WHERE id = $2", [minutes, Number(req.params.id)]);
  res.redirect(req.query.month ? `/admin/meetings?month=${req.query.month}` : "/admin/meetings");
});

router.post("/admin/meetings/:id/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM meetings WHERE id = $1", [Number(req.params.id)]);
  res.redirect(req.query.month ? `/admin/meetings?month=${req.query.month}` : "/admin/meetings");
});

// ---------- Events (public sign-up) ----------

router.get("/admin/events", requireAdmin, async (req, res) => {
  const { year, month } = parseMonthParam(req.query.month);
  const { start, end } = monthRange(year, month);
  const { rows: events } = await pool.query(
    `SELECT e.*, (SELECT COUNT(*) FROM event_signups s WHERE s.event_id = e.id) AS signup_count
     FROM events e WHERE e.starts_at >= $1 AND e.starts_at < $2 ORDER BY e.starts_at ASC`,
    [start, end]
  );
  const eventIds = events.map((e) => e.id);
  const { rows: signupRows } = eventIds.length
    ? await pool.query("SELECT * FROM event_signups WHERE event_id = ANY($1) ORDER BY created_at ASC", [eventIds])
    : { rows: [] };
  const signupsByEvent = {};
  for (const s of signupRows) {
    if (!signupsByEvent[s.event_id]) signupsByEvent[s.event_id] = [];
    signupsByEvent[s.event_id].push(s);
  }

  const weeks = monthGrid(year, month, groupByDate(events, "starts_at"));
  res.render("admin/events", { active: "events", weeks, signupsByEvent, ...monthNav(year, month) });
});

router.post("/admin/events", requireAdmin, async (req, res) => {
  const title = (req.body.title || "").trim();
  const description = (req.body.description || "").trim() || null;
  const location = (req.body.location || "").trim() || null;
  const date = req.body.date;
  const startTime = req.body.startTime;
  const endTime = req.body.endTime || null;
  const capacity = req.body.capacity ? Number(req.body.capacity) : null;

  if (title && date && startTime) {
    const startsAt = `${date}T${startTime}`;
    const endsAt = endTime ? `${date}T${endTime}` : null;
    await pool.query(
      `INSERT INTO events (title, description, location, starts_at, ends_at, capacity, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [title, description, location, startsAt, endsAt, capacity, req.session.user.id]
    );
  }
  res.redirect(req.body.month ? `/admin/events?month=${req.body.month}` : "/admin/events");
});

router.post("/admin/events/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const title = (req.body.title || "").trim();
  const description = (req.body.description || "").trim() || null;
  const location = (req.body.location || "").trim() || null;
  const startsAt = req.body.startsAt;
  const endsAt = req.body.endsAt || null;
  const capacity = req.body.capacity ? Number(req.body.capacity) : null;

  if (title && startsAt) {
    await pool.query(
      `UPDATE events SET title=$1, description=$2, location=$3, starts_at=$4, ends_at=$5, capacity=$6
       WHERE id = $7`,
      [title, description, location, startsAt, endsAt, capacity, id]
    );
  }
  res.redirect(req.query.month ? `/admin/events?month=${req.query.month}` : "/admin/events");
});

router.post("/admin/events/:id/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM events WHERE id = $1", [Number(req.params.id)]);
  res.redirect(req.query.month ? `/admin/events?month=${req.query.month}` : "/admin/events");
});

router.post("/admin/events/:id/signups/:signupId/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM event_signups WHERE id = $1 AND event_id = $2", [Number(req.params.signupId), Number(req.params.id)]);
  res.redirect(req.query.month ? `/admin/events?month=${req.query.month}` : "/admin/events");
});

// ---------- Sessions (public sign-up) ----------

router.get("/admin/sessions", requireAdmin, async (req, res) => {
  const { year, month } = parseMonthParam(req.query.month);
  const { start, end } = monthRange(year, month);
  const { rows: classes } = await pool.query(
    `SELECT c.*, ${seatsTakenExpr("c")}::int AS seats_taken
     FROM classes c WHERE c.starts_at >= $1 AND c.starts_at < $2 ORDER BY c.starts_at ASC`,
    [start, end]
  );
  const classIds = classes.map((c) => c.id);
  const { rows: signupRows } = classIds.length
    ? await pool.query("SELECT * FROM class_signups WHERE class_id = ANY($1) ORDER BY created_at ASC", [classIds])
    : { rows: [] };
  const signupsByClass = {};
  for (const s of signupRows) {
    if (!signupsByClass[s.class_id]) signupsByClass[s.class_id] = [];
    signupsByClass[s.class_id].push(s);
  }

  const { rows: dropinRows } = classIds.length
    ? await pool.query(
        `SELECT d.id, d.class_id, o.buyer_name, o.buyer_email, d.created_at
         FROM class_dropin_seats d JOIN orders o ON o.id = d.order_id
         WHERE d.class_id = ANY($1) AND d.status = 'sold' ORDER BY d.created_at ASC`,
        [classIds]
      )
    : { rows: [] };
  const dropinByClass = {};
  for (const d of dropinRows) {
    if (!dropinByClass[d.class_id]) dropinByClass[d.class_id] = [];
    dropinByClass[d.class_id].push(d);
  }

  const weeks = monthGrid(year, month, groupByDate(classes, "starts_at"));
  res.render("admin/sessions", { active: "sessions", weeks, signupsByClass, dropinByClass, ...monthNav(year, month) });
});

router.post("/admin/sessions", requireAdmin, async (req, res) => {
  const title = (req.body.title || "").trim();
  const description = (req.body.description || "").trim() || null;
  const location = (req.body.location || "").trim() || null;
  const date = req.body.date;
  const startTime = req.body.startTime;
  const endTime = req.body.endTime || null;
  const capacity = req.body.capacity ? Number(req.body.capacity) : 5;
  const dropinPrice = req.body.dropinPrice ? Number(req.body.dropinPrice) : null;

  if (title && date && startTime) {
    const startsAt = `${date}T${startTime}`;
    const endsAt = endTime ? `${date}T${endTime}` : null;
    await pool.query(
      `INSERT INTO classes (title, description, location, starts_at, ends_at, capacity, dropin_price, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [title, description, location, startsAt, endsAt, capacity, dropinPrice, req.session.user.id]
    );
  }
  res.redirect(req.body.month ? `/admin/sessions?month=${req.body.month}` : "/admin/sessions");
});

router.post("/admin/sessions/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const title = (req.body.title || "").trim();
  const description = (req.body.description || "").trim() || null;
  const location = (req.body.location || "").trim() || null;
  const startsAt = req.body.startsAt;
  const endsAt = req.body.endsAt || null;
  const capacity = req.body.capacity ? Number(req.body.capacity) : null;
  const dropinPrice = req.body.dropinPrice ? Number(req.body.dropinPrice) : null;

  if (title && startsAt) {
    await pool.query(
      `UPDATE classes SET title=$1, description=$2, location=$3, starts_at=$4, ends_at=$5, capacity=$6, dropin_price=$7
       WHERE id = $8`,
      [title, description, location, startsAt, endsAt, capacity, dropinPrice, id]
    );
  }
  res.redirect(req.query.month ? `/admin/sessions?month=${req.query.month}` : "/admin/sessions");
});

router.post("/admin/sessions/:id/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM classes WHERE id = $1", [Number(req.params.id)]);
  res.redirect(req.query.month ? `/admin/sessions?month=${req.query.month}` : "/admin/sessions");
});

router.post("/admin/sessions/:id/signups/:signupId/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM class_signups WHERE id = $1 AND class_id = $2", [Number(req.params.signupId), Number(req.params.id)]);
  res.redirect(req.query.month ? `/admin/sessions?month=${req.query.month}` : "/admin/sessions");
});

// ---------- Charity vote ----------

router.get("/admin/charity", requireAdmin, async (req, res) => {
  const { rows: rounds } = await pool.query("SELECT * FROM charity_rounds ORDER BY opens_at DESC LIMIT 10");
  res.render("admin/charity", { active: "charity", rounds });
});

router.post("/admin/charity-rounds", requireAdmin, async (req, res) => {
  const title = (req.body.title || "").trim();
  const optionNames = (req.body.options || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (title && optionNames.length) {
    await pool.query("UPDATE charity_rounds SET is_active = FALSE WHERE is_active = TRUE");
    const { rows } = await pool.query(
      "INSERT INTO charity_rounds (title, is_active) VALUES ($1, TRUE) RETURNING id",
      [title]
    );
    const roundId = rows[0].id;
    for (const name of optionNames) {
      await pool.query(
        "INSERT INTO charity_options (round_id, name) VALUES ($1, $2)",
        [roundId, name]
      );
    }
  }
  res.redirect("/admin/charity");
});

router.post("/admin/charity-rounds/:id/close", requireAdmin, async (req, res) => {
  await pool.query(
    "UPDATE charity_rounds SET is_active = FALSE, closes_at = now() WHERE id = $1",
    [Number(req.params.id)]
  );
  res.redirect("/admin/charity");
});

// ---------- Inventory ----------

router.get("/admin/inventory", requireAdmin, async (req, res) => {
  await expireStaleReservations(pool);
  const q = (req.query.q || "").trim();
  const params = [];
  let where = "";
  if (q) {
    params.push(`%${q}%`);
    where = "WHERE b.title ILIKE $1 OR b.authors ILIKE $1 OR b.isbn ILIKE $1";
  }
  const { rows: books } = await pool.query(
    `SELECT b.*, COUNT(c.id)::int AS copy_count,
            COUNT(c.id) FILTER (WHERE c.status = 'in_stock')::int AS in_stock_count
     FROM books b LEFT JOIN book_copies c ON c.book_id = b.id
     ${where}
     GROUP BY b.id ORDER BY b.title ASC LIMIT 200`,
    params
  );
  res.render("admin/inventory/index", { active: "inventory", books, q });
});

router.get("/admin/inventory/scan", requireAdmin, (req, res) => {
  res.render("admin/inventory/scan", {
    active: "inventory",
    error: null,
    saved: req.query.saved === "1",
    visionEnabled: !!process.env.ANTHROPIC_API_KEY,
  });
});

router.post("/admin/inventory/lookup", requireAdmin, async (req, res) => {
  const visionEnabled = !!process.env.ANTHROPIC_API_KEY;
  let book = null;
  let error = null;

  const scanPhoto = req.files && req.files.photo && req.files.photo[0];
  if (scanPhoto) {
    const info = await extractBookInfoFromPhoto(scanPhoto.buffer, scanPhoto.mimetype);
    if (!info || (!info.isbn && !info.title)) {
      return res.render("admin/inventory/scan", {
        active: "inventory", visionEnabled,
        error: "Couldn't read anything useful from that photo — try a clearer shot, or enter details manually below.",
      });
    }
    if (info.isbn) {
      book = await lookupByIsbn(info.isbn);
    }
    if (!book && info.title) {
      const candidates = await searchByTitleAuthor(info.title, info.author);
      book = candidates[0] || null;
    }
    if (!book) {
      book = { isbn: info.isbn ? normalizeIsbn(info.isbn) : null, title: info.title, author: info.author, publisher: null, publishedYear: null, description: null, coverUrl: null, genre: null, genreFr: null, descriptionFr: null };
      error = "Found some details from the photo, but no catalog match — check everything below before saving.";
    }
  } else {
    const isbn = (req.body.isbn || "").trim();
    if (!isbn) {
      return res.render("admin/inventory/scan", { active: "inventory", visionEnabled, error: "Enter an ISBN or choose a photo." });
    }
    book = await lookupByIsbn(isbn);
    if (!book) {
      book = { isbn: normalizeIsbn(isbn), title: null, author: null, publisher: null, publishedYear: null, description: null, coverUrl: null, genre: null, genreFr: null, descriptionFr: null };
      error = "No catalog match for that ISBN — enter the details manually below.";
    }
  }

  res.render("admin/inventory/new", { active: "inventory", book, error, fromScan: true, conditions: CONDITIONS, statuses: STATUSES });
});

router.get("/admin/inventory/new", requireAdmin, (req, res) => {
  res.render("admin/inventory/new", {
    active: "inventory",
    book: { isbn: null, title: null, author: null, publisher: null, publishedYear: null, description: null, coverUrl: null, genre: null, genreFr: null, descriptionFr: null },
    error: null,
    fromScan: false,
    conditions: CONDITIONS,
    statuses: STATUSES,
  });
});

router.post("/admin/inventory/generate-description", requireAdmin, async (req, res) => {
  const title = (req.body.title || "").trim();
  const author = (req.body.author || "").trim() || null;
  const publisher = (req.body.publisher || "").trim() || null;
  const publishedYear = req.body.publishedYear ? Number(req.body.publishedYear) : null;

  if (!title) return res.status(400).json({ error: "Enter a title first." });

  const description = await generateBookDescription({ title, author, publisher, publishedYear });
  if (!description) return res.status(502).json({ error: "Couldn't generate a description — try again, or write one manually." });
  const descriptionFr = await translateDescriptionToFrench(description);
  res.json({ description, descriptionFr });
});

router.post("/admin/inventory", requireAdmin, async (req, res) => {
  const title = (req.body.title || "").trim();
  const author = (req.body.author || "").trim() || null;
  const isbn = req.body.isbn ? normalizeIsbn(req.body.isbn) : null;
  const publisher = (req.body.publisher || "").trim() || null;
  const publishedYear = req.body.publishedYear ? Number(req.body.publishedYear) : null;
  const genre = normalizeGenres(req.body.genre);
  let genreFr = (req.body.genreFr || "").trim() || (genre ? translateGenresToFrench(genre) : null);
  let description = (req.body.description || "").trim() || null;
  let descriptionFr = (req.body.descriptionFr || "").trim() || null;
  let coverUrl = (req.body.coverUrl || "").trim() || null;

  if (!title) {
    return res.render("admin/inventory/new", {
      active: "inventory",
      book: { isbn, title: null, author, publisher, publishedYear, description, descriptionFr, coverUrl, genre, genreFr },
      error: "Title is required.",
      fromScan: req.body.fromScan === "1",
      conditions: CONDITIONS,
      statuses: STATUSES,
    });
  }

  const coverPhoto = req.files && req.files.coverPhoto && req.files.coverPhoto[0];
  if (coverPhoto) coverUrl = await processCoverPhoto(coverPhoto);

  // A second physical copy of a book already in inventory (same ISBN)
  // should add a copy to that existing record, not create a duplicate
  // book entry — otherwise scanning a title you already stock splits
  // into a separate single-copy book instead of accumulating on one.
  let bookId = null;
  if (isbn) {
    const { rows: existingRows } = await pool.query("SELECT * FROM books WHERE isbn = $1", [isbn]);
    if (existingRows.length) {
      const existing = existingRows[0];
      bookId = existing.id;
      if (!existing.description || !existing.cover_url || !existing.description_fr) {
        const [genDescription, genCoverUrl] = await Promise.all([
          existing.description ? null : (description || generateBookDescription({ title, author, publisher, publishedYear })),
          existing.cover_url ? null : (coverUrl || findCoverUrl({ isbn, title, author })),
        ]);
        const finalDescription = existing.description || genDescription;
        const genDescriptionFr = existing.description_fr
          ? null
          : (descriptionFr || (finalDescription ? await translateDescriptionToFrench(finalDescription) : null));
        if (genDescription || genCoverUrl || genDescriptionFr) {
          await pool.query(
            `UPDATE books SET description = COALESCE($1, description), cover_url = COALESCE($2, cover_url),
                    description_fr = COALESCE($3, description_fr), updated_at = now() WHERE id = $4`,
            [genDescription, genCoverUrl, genDescriptionFr, bookId]
          );
        }
      }
    }
  }

  if (!bookId) {
    [description, coverUrl] = await Promise.all([
      description || generateBookDescription({ title, author, publisher, publishedYear }),
      coverUrl || findCoverUrl({ isbn, title, author }),
    ]);
    descriptionFr = descriptionFr || (description ? await translateDescriptionToFrench(description) : null);

    const { rows } = await pool.query(
      `INSERT INTO books (isbn, title, authors, publisher, published_year, description, description_fr, cover_url, categories, categories_fr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [isbn || null, title, author, publisher, publishedYear, description, descriptionFr, coverUrl, genre, genreFr, req.session.user.id]
    );
    bookId = rows[0].id;
  }

  const condition = normalizeCondition(req.body.condition);
  const status = normalizeStatus(req.body.status);
  const price = req.body.price ? Number(req.body.price) : null;
  const acquisitionCost = req.body.acquisitionCost ? Number(req.body.acquisitionCost) : null;
  const acquiredAt = req.body.acquiredAt || null;
  const notes = (req.body.copyNotes || "").trim() || null;

  const { rows: copyRows } = await pool.query(
    `INSERT INTO book_copies (book_id, condition, price, acquisition_cost, acquired_at, status, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [bookId, condition, price, acquisitionCost, acquiredAt, status, notes, req.session.user.id]
  );

  // A copy arriving as in_stock might be exactly what someone's on the
  // wishlist for — claim it for them instead of leaving it up for grabs.
  if (status === "in_stock") {
    await matchWishlistOnArrival(pool, { bookId, copyId: copyRows[0].id, title });
  }

  if (req.body.fromScan === "1") return res.redirect("/admin/inventory/scan?saved=1");
  res.redirect(`/admin/inventory/${bookId}`);
});

router.get("/admin/inventory/:id", requireAdmin, async (req, res) => {
  await expireStaleReservations(pool);
  const id = Number(req.params.id);
  const { rows: bookRows } = await pool.query("SELECT * FROM books WHERE id = $1", [id]);
  const book = bookRows[0];
  if (!book) return res.status(404).render("404");
  const { rows: copies } = await pool.query(
    "SELECT * FROM book_copies WHERE book_id = $1 ORDER BY created_at DESC", [id]
  );
  res.render("admin/inventory/show", { active: "inventory", book, copies, conditions: CONDITIONS, statuses: STATUSES });
});

router.post("/admin/inventory/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const title = (req.body.title || "").trim();
  const author = (req.body.author || "").trim() || null;
  const isbn = req.body.isbn ? normalizeIsbn(req.body.isbn) : null;
  const publisher = (req.body.publisher || "").trim() || null;
  const publishedYear = req.body.publishedYear ? Number(req.body.publishedYear) : null;
  const genre = normalizeGenres(req.body.genre);
  let genreFr = (req.body.genreFr || "").trim() || (genre ? translateGenresToFrench(genre) : null);
  let description = (req.body.description || "").trim() || null;
  let descriptionFr = (req.body.descriptionFr || "").trim() || null;
  let coverUrl = (req.body.coverUrl || "").trim() || null;

  if (title) {
    const coverPhoto = req.files && req.files.coverPhoto && req.files.coverPhoto[0];
    if (coverPhoto) coverUrl = await processCoverPhoto(coverPhoto);

    [description, coverUrl] = await Promise.all([
      description || generateBookDescription({ title, author, publisher, publishedYear }),
      coverUrl || findCoverUrl({ isbn, title, author }),
    ]);
    descriptionFr = descriptionFr || (description ? await translateDescriptionToFrench(description) : null);
    await pool.query(
      `UPDATE books SET isbn=$1, title=$2, authors=$3, publisher=$4, published_year=$5,
              description=$6, description_fr=$7, cover_url=$8, categories=$9, categories_fr=$10, updated_at=now()
       WHERE id = $11`,
      [isbn || null, title, author, publisher, publishedYear, description, descriptionFr, coverUrl, genre, genreFr, id]
    );
  }
  res.redirect(`/admin/inventory/${id}`);
});

router.post("/admin/inventory/:id/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM books WHERE id = $1", [Number(req.params.id)]);
  res.redirect("/admin/inventory");
});

router.post("/admin/inventory/:id/copies/:copyId", requireAdmin, async (req, res) => {
  const bookId = Number(req.params.id);
  const copyId = Number(req.params.copyId);
  const condition = normalizeCondition(req.body.condition);
  const status = normalizeStatus(req.body.status);
  const price = req.body.price ? Number(req.body.price) : null;
  const acquisitionCost = req.body.acquisitionCost ? Number(req.body.acquisitionCost) : null;
  const acquiredAt = req.body.acquiredAt || null;
  const notes = (req.body.notes || "").trim() || null;
  await pool.query(
    `UPDATE book_copies SET condition=$1, status=$2, price=$3, acquisition_cost=$4, acquired_at=$5, notes=$6, updated_at=now()
     WHERE id = $7 AND book_id = $8`,
    [condition, status, price, acquisitionCost, acquiredAt, notes, copyId, bookId]
  );
  res.redirect(`/admin/inventory/${bookId}`);
});

router.post("/admin/inventory/:id/copies/:copyId/cancel-reservation", requireAdmin, async (req, res) => {
  await pool.query(
    `UPDATE book_copies SET status='in_stock', reserved_by_name=NULL, reserved_by_email=NULL,
            reserved_by_phone=NULL, reserved_at=NULL, updated_at=now()
     WHERE id = $1 AND book_id = $2`,
    [Number(req.params.copyId), Number(req.params.id)]
  );
  res.redirect(`/admin/inventory/${req.params.id}`);
});

router.post("/admin/inventory/:id/copies/:copyId/delete", requireAdmin, async (req, res) => {
  const bookId = Number(req.params.id);
  await pool.query("DELETE FROM book_copies WHERE id = $1 AND book_id = $2", [Number(req.params.copyId), bookId]);
  const { rows } = await pool.query("SELECT 1 FROM book_copies WHERE book_id = $1", [bookId]);
  if (!rows.length) {
    await pool.query("DELETE FROM books WHERE id = $1", [bookId]);
    return res.redirect("/admin/inventory");
  }
  res.redirect(`/admin/inventory/${bookId}`);
});

// ---------- Wishlist ----------

router.get("/admin/wishlist", requireAdmin, async (req, res) => {
  const { rows: requests } = await pool.query(
    "SELECT * FROM wishlist_requests ORDER BY status ASC, created_at DESC"
  );
  res.render("admin/wishlist", { active: "wishlist", requests });
});

router.post("/admin/wishlist/:id/fulfill", requireAdmin, async (req, res) => {
  await pool.query(
    "UPDATE wishlist_requests SET status = 'fulfilled', updated_at = now() WHERE id = $1",
    [Number(req.params.id)]
  );
  res.redirect("/admin/wishlist");
});

router.post("/admin/wishlist/:id/reopen", requireAdmin, async (req, res) => {
  await pool.query(
    "UPDATE wishlist_requests SET status = 'open', updated_at = now() WHERE id = $1",
    [Number(req.params.id)]
  );
  res.redirect("/admin/wishlist");
});

router.post("/admin/wishlist/:id/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM wishlist_requests WHERE id = $1", [Number(req.params.id)]);
  res.redirect("/admin/wishlist");
});

module.exports = router;
