// "Update all books" (Admin > Genres): rewrites books.categories of every book through the genre rules. Books have
// English genres only (Sharon, 2026-10-28): books have no French genre column (older runs' French
// before/after values stay in genre_run_changes as history, and Undo puts back the English only). This touches the real catalogue, so it follows the Reprice tool's safety model (lib/pricing/reprice.js):
//
//   PREVIEW   planRun() computes the whole rewrite WITHOUT writing: how many books would change, 10 before/after
//             examples, totals, and a fingerprint (count + sha256 of "id:new value" of every change).
//   CONFIRM   applyRun() recomputes the plan and applies it only when it is exactly the one previewed (a rule or a
//             book edited in between: nothing is changed and the admin looks again).
//   BATCHES   500 books per transaction; each UPDATE re-checks that the book still holds the value the plan read
//             (a book saved meanwhile is skipped, never overwritten). One run at a time (advisory lock).
//   RECORD    genre_runs (who, when, the rules as they were) and genre_run_changes (old and new value of every changed
//             book).
//   UNDO      undoRun() puts the old values back for the books that still hold what the run wrote (the same
//             exactness as the preview). Only the newest run that is not undone can be undone.
//   IDEMPOTENT  a second run finds nothing left to change.
//
// Genres no rule matches are left as they are. Never touches books without genres.

const crypto = require("node:crypto");
const { readRules, planBook } = require("./genreRules");
const { clearAll } = require("./genreAdmin");

const BATCH = 500;
const EXAMPLES = 10;
const LOCK_KEY = 7243911; // arbitrary constant, apart from migrate.js's
const STALE_RUN_MINUTES = 15; // a 'running' row this old whose lock nobody holds is a run the server never finished
const INTERRUPTED_NOTE = "interrupted: the server stopped before this run finished";

// The rewrite of every book that has genres. -> { changes: [{ id, title, old, en }], stats, hash, rulesSnapshot }
async function planRun(db) {
  const { rules, stored } = await readRules(db);
  const { rows } = await db.query(
    "SELECT id, title, categories FROM books WHERE categories IS NOT NULL AND btrim(categories) <> '' ORDER BY id"
  );
  const changes = [];
  const stats = { booksWithGenres: rows.length, booksChanged: 0, genresRemoved: 0, genresRenamed: 0, duplicatesCollapsed: 0 };
  const hash = crypto.createHash("sha256");
  for (const b of rows) {
    const p = planBook(b.categories, rules);
    if (!p.changed) continue; // spacing alone never rewrites a string
    const en = p.en;
    changes.push({ id: b.id, title: b.title, old: b.categories, en });
    stats.booksChanged += 1;
    stats.genresRemoved += p.removed;
    stats.genresRenamed += p.renamed;
    stats.duplicatesCollapsed += p.collapsed;
    hash.update(`${b.id}:${en == null ? "\u0000" : en}\n`);
  }
  // Different before -> after pairs first, so ten examples show ten kinds of change rather than one repeated.
  const ordered = changes;
  const seenPairs = new Set();
  const varied = ordered.filter((c) => { const k = `${c.old}\u0000${c.en}`; if (seenPairs.has(k)) return false; seenPairs.add(k); return true; });
  const examples = [...varied, ...ordered.filter((c) => !varied.includes(c))].slice(0, EXAMPLES);
  return {
    changes, stats, examples, count: changes.length, hash: hash.digest("hex"),
    rulesSnapshot: stored.map((r) => ({ kind: r.kind, pattern: r.pattern, action: r.action, target: r.target })),
  };
}

// The part of a plan that fits in a session / a page (no list of every change).
function planSummary(plan) {
  return { count: plan.count, hash: plan.hash, stats: plan.stats, examples: plan.examples.map((e) => ({ id: e.id, title: e.title, old: e.old, en: e.en })) };
}

// Runs fn(client) holding the one-run-at-a-time lock. -> { busy: true } when another run holds it.
async function withRunLock(pool, fn) {
  const client = await pool.connect();
  let locked = false;
  try {
    const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK_KEY]);
    locked = rows[0].ok;
    if (!locked) return { busy: true };
    return await fn(client);
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

// Marks every 'running' run started more than STALE_RUN_MINUTES ago as failed (note INTERRUPTED_NOTE). Only call it
// while holding the run lock (a live run holds it for its whole length, so a 'running' row seen under the lock is
// dead). books_changed is recomputed from the changes the run did record, so Undo still shows (and restores) them.
// -> the number of rows reaped
async function reapStale(db) {
  const { rowCount } = await db.query(
    `UPDATE genre_runs r
        SET status = 'failed', finished_at = now(), note = $2,
            books_changed = (SELECT count(*) FROM genre_run_changes c WHERE c.run_id = r.id)
      WHERE r.status = 'running' AND r.started_at < now() - make_interval(mins => $1::int)`,
    [STALE_RUN_MINUTES, INTERRUPTED_NOTE]
  );
  return rowCount;
}

// The same, for a caller that does not hold the lock (the runs pages): does nothing while a run holds it.
async function reapStaleRuns(pool) {
  const r = await withRunLock(pool, (client) => reapStale(client));
  return r && r.busy ? 0 : r;
}

const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, (i + 1) * n));

// Applies the plan. `expected` ({ count, hash }) is what the admin previewed.
// -> { runId, changed, skipped, stats } | { busy } | { mismatch, expectedCount, liveCount } | { runId: null, changed: 0 } (nothing to do)
async function applyRun(pool, actor = {}, expected = null, { onBatch } = {}) {
  return withRunLock(pool, async (client) => {
    await reapStale(client); // a run an earlier crash left 'running' must not stay so forever
    const plan = await planRun(client);
    if (expected && (plan.count !== Number(expected.count) || plan.hash !== String(expected.hash))) {
      return { mismatch: true, expectedCount: Number(expected.count), liveCount: plan.count };
    }
    if (!plan.count) return { runId: null, changed: 0, skipped: 0, stats: plan.stats };
    const { rows: [run] } = await client.query(
      "INSERT INTO genre_runs (actor_user_id, rules_snapshot) VALUES ($1, $2::jsonb) RETURNING id",
      [actor.id ?? null, JSON.stringify(plan.rulesSnapshot)]
    );
    let changed = 0;
    try {
      for (const batch of chunks(plan.changes, BATCH)) {
        await client.query("BEGIN");
        try {
          const payload = JSON.stringify(batch.map((c) => ({ id: c.id, old: c.old, en: c.en })));
          // The book must still hold what the plan read: one saved since is left alone.
          const { rows: done } = await client.query(
            `UPDATE books b SET categories = t.en, updated_at = now()
             FROM jsonb_to_recordset($1::jsonb) AS t(id int, old text, en text)
             WHERE b.id = t.id AND b.categories IS NOT DISTINCT FROM t.old
             RETURNING b.id`, [payload]
          );
          const ids = done.map((r) => r.id);
          if (ids.length) {
            await client.query(
              `INSERT INTO genre_run_changes (run_id, book_id, old_categories, new_categories)
               SELECT $1, t.id, t.old, t.en
               FROM jsonb_to_recordset($2::jsonb) AS t(id int, old text, en text)
               WHERE t.id = ANY($3::int[])`, [run.id, payload, ids]
            );
          }
          await client.query("COMMIT");
          changed += ids.length;
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        }
        if (onBatch) await onBatch(changed);
      }
      await client.query(
        "UPDATE genre_runs SET status = 'done', finished_at = now(), books_changed = $2, genres_removed = $3 WHERE id = $1",
        [run.id, changed, plan.stats.genresRemoved]
      );
    } catch (err) {
      await client.query("UPDATE genre_runs SET status = 'failed', finished_at = now(), books_changed = $2 WHERE id = $1", [run.id, changed]).catch(() => {});
      clearAll(pool);
      throw err;
    }
    clearAll(pool);
    return { runId: run.id, changed, skipped: plan.count - changed, stats: plan.stats };
  });
}

// ---------- history and undo ----------

async function getRun(db, id) {
  const { rows } = await db.query("SELECT r.*, u.display_name AS actor_name FROM genre_runs r LEFT JOIN users u ON u.id = r.actor_user_id WHERE r.id = $1", [id]);
  return rows[0] || null;
}

async function recentRuns(db, limit = 10) {
  const { rows } = await db.query("SELECT * FROM genre_runs ORDER BY id DESC LIMIT $1", [limit]);
  return rows;
}

// The only run that can be undone: the newest one that is not undone yet.
async function undoableRunId(db) {
  const { rows } = await db.query("SELECT max(id)::int AS id FROM genre_runs WHERE undone_at IS NULL");
  return rows[0].id;
}

async function runExamples(db, runId, limit = EXAMPLES) {
  // One book per different before -> after pair, so the examples show different kinds of change.
  const { rows } = await db.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (c.old_categories, c.new_categories) c.book_id, b.title, c.old_categories, c.new_categories
       FROM genre_run_changes c LEFT JOIN books b ON b.id = c.book_id
       WHERE c.run_id = $1 AND c.old_categories IS DISTINCT FROM c.new_categories
       ORDER BY c.old_categories, c.new_categories, c.book_id) t
     ORDER BY t.book_id LIMIT $2`, [runId, limit]
  );
  return rows;
}

// What Undo of `runId` would do: a book goes back only while it still holds exactly what the run wrote.
async function previewUndo(db, runId) {
  const { rows } = await db.query(
    `SELECT c.book_id, (b.id IS NOT NULL AND b.categories IS NOT DISTINCT FROM c.new_categories) AS restorable
     FROM genre_run_changes c LEFT JOIN books b ON b.id = c.book_id WHERE c.run_id = $1 ORDER BY c.book_id`, [runId]
  );
  const ok = rows.filter((r) => r.restorable).map((r) => r.book_id);
  return { total: rows.length, count: ok.length, skipped: rows.length - ok.length, hash: idsHash(ok) };
}

function idsHash(ids) {
  return crypto.createHash("sha256").update([...ids].map(Number).sort((a, b) => a - b).join(",")).digest("hex");
}

// -> { restored, skipped } | { notFound } | { notLast } | { busy } | { mismatch, expectedCount, liveCount }
async function undoRun(pool, runId, expected = null) {
  return withRunLock(pool, async (client) => {
    const run = await getRun(client, runId);
    if (!run) return { notFound: true };
    if ((await undoableRunId(client)) !== runId) return { notLast: true };
    const live = await previewUndo(client, runId);
    if (expected && (live.count !== Number(expected.count) || live.hash !== String(expected.hash))) {
      return { mismatch: true, expectedCount: Number(expected.count), liveCount: live.count };
    }
    const { rows: all } = await client.query(
      "SELECT book_id, old_categories, new_categories FROM genre_run_changes WHERE run_id = $1 ORDER BY book_id", [runId]
    );
    let restored = 0;
    for (const batch of chunks(all, BATCH)) {
      await client.query("BEGIN");
      try {
        const { rowCount } = await client.query(
          `UPDATE books b SET categories = t.old, updated_at = now()
           FROM jsonb_to_recordset($1::jsonb) AS t(id int, old text, en text)
           WHERE b.id = t.id AND b.categories IS NOT DISTINCT FROM t.en`,
          [JSON.stringify(batch.map((c) => ({ id: c.book_id, old: c.old_categories, en: c.new_categories })))]
        );
        await client.query("COMMIT");
        restored += rowCount;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
    await client.query("UPDATE genre_runs SET undone_at = now(), undo_restored = $2 WHERE id = $1", [runId, restored]);
    clearAll(pool);
    return { restored, skipped: all.length - restored, run };
  });
}

module.exports = { BATCH, LOCK_KEY, STALE_RUN_MINUTES, INTERRUPTED_NOTE, reapStale, reapStaleRuns, planRun, planSummary, applyRun, getRun, recentRuns, undoableRunId, runExamples, previewUndo, undoRun, withRunLock, idsHash };
