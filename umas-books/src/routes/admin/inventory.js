const express = require("express");
const { saveImage } = require("../../lib/imageStore");
const { sharpFromUpload, reencodeForVision } = require("../../lib/uploadImage");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { normalizeIsbn, lookupByIsbn, searchByTitleAuthor, translateGenresToFrench } = require("../../lib/bookLookup");
const { extractBookInfoFromPhoto } = require("../../lib/coverVision");
const { generateBookDescription, translateDescriptionToFrench } = require("../../lib/bookDescription");
const { CONDITIONS, STATUSES, normalizeCondition, normalizeStatus, normalizeGenres } = require("../../lib/inventory");
const { expireStaleReservations } = require("../../lib/reservations");

const { validateIdParams } = require("../../middleware/idParams");

const router = express.Router();
// Garbage ids get the 404 page, not a Postgres 22P02 and a 500.
validateIdParams(router, "id", "copyId");

// New copies default to a $0 cost / $5 price, but a book already in
// inventory should default to whatever its existing copies are set at.
async function getDefaultCopyPricing(isbn) {
  const defaults = { price: 5, acquisitionCost: 0 };
  if (!isbn) return defaults;
  const { rows } = await pool.query(
    `SELECT c.price, c.acquisition_cost FROM book_copies c
     JOIN books b ON b.id = c.book_id
     WHERE b.isbn = $1 ORDER BY c.created_at DESC LIMIT 1`,
    [isbn]
  );
  if (!rows.length) return defaults;
  return {
    price: rows[0].price != null ? Number(rows[0].price) : defaults.price,
    acquisitionCost: rows[0].acquisition_cost != null ? Number(rows[0].acquisition_cost) : defaults.acquisitionCost,
  };
}

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
// thumbnail, stored in the images table (lib/imageStore.js), and its short
// /img/<hash>.jpg URL goes in the same cover_url column a lookup-sourced
// image URL would go in.
async function processCoverPhoto(file) {
  const resized = await sharpFromUpload(file.buffer)
    .rotate()
    .resize(500, 700, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 78 })
    .toBuffer();
  return saveImage(resized, "image/jpeg");
}

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
    let photo;
    try {
      photo = await reencodeForVision(scanPhoto.buffer);
    } catch (err) {
      console.warn("Scan photo could not be decoded:", err.message);
      return res.render("admin/inventory/scan", {
        active: "inventory", visionEnabled,
        error: "That file couldn't be read as an image — try another photo, or enter details manually below.",
      });
    }
    const info = await extractBookInfoFromPhoto(photo.buffer, photo.mimeType);
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

  const defaultPricing = await getDefaultCopyPricing(book.isbn);
  res.render("admin/inventory/new", { active: "inventory", book, error, fromScan: true, conditions: CONDITIONS, statuses: STATUSES, defaultPricing });
});

router.get("/admin/inventory/new", requireAdmin, (req, res) => {
  res.render("admin/inventory/new", {
    active: "inventory",
    book: { isbn: null, title: null, author: null, publisher: null, publishedYear: null, description: null, coverUrl: null, genre: null, genreFr: null, descriptionFr: null },
    error: null,
    fromScan: false,
    conditions: CONDITIONS,
    statuses: STATUSES,
    defaultPricing: { price: 5, acquisitionCost: 0 },
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
      defaultPricing: {
        price: req.body.price ? Number(req.body.price) : 5,
        acquisitionCost: req.body.acquisitionCost ? Number(req.body.acquisitionCost) : 0,
      },
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

  await pool.query(
    `INSERT INTO book_copies (book_id, condition, price, acquisition_cost, acquired_at, status, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [bookId, condition, price, acquisitionCost, acquiredAt, status, notes, req.session.user.id]
  );

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

module.exports = router;
