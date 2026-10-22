// One-time tokens for saving a book copy (table copy_intake_tokens, migration 093).
// Same idea as the till's sale_token (lib/till.js): the same token again returns the
// first save's result. claim() is atomic (primary key), so two identical requests at
// once cannot both create a copy.

const crypto = require("crypto");

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const WINDOW_MINUTES = 10; // a repeat inside this window is answered with the first result
const WAIT_MS = 6000; // how long a second request waits for the first one to finish
const POLL_MS = 120;

const newToken = () => crypto.randomUUID();
const validToken = (t) => TOKEN_RE.test(String(t || ""));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -> { state: "claimed" } | { state: "done", copyId, bookId, requests } | { state: "busy" }
async function claim(pool, token) {
  await pool.query("DELETE FROM copy_intake_tokens WHERE created_at < now() - interval '1 day'");
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    // A token older than the window no longer counts (an old page left open).
    await pool.query("DELETE FROM copy_intake_tokens WHERE token = $1 AND created_at < now() - ($2 || ' minutes')::interval", [token, String(WINDOW_MINUTES)]);
    const ins = await pool.query("INSERT INTO copy_intake_tokens (token) VALUES ($1) ON CONFLICT (token) DO NOTHING RETURNING token", [token]);
    if (ins.rows.length) return { state: "claimed" };
    const { rows } = await pool.query("SELECT copy_id, book_id, requests FROM copy_intake_tokens WHERE token = $1", [token]);
    if (rows.length && rows[0].copy_id) return { state: "done", copyId: rows[0].copy_id, bookId: rows[0].book_id, requests: rows[0].requests };
    // Either the first save is still running (row without a copy) or it failed and let go (no row): look again.
    if (Date.now() >= deadline) return rows.length ? { state: "busy" } : claim(pool, token);
    await sleep(POLL_MS);
  }
}

// Called inside the transaction that creates the copy, so the claim and the copy commit together.
async function attach(db, token, copyId, bookId) {
  await db.query("UPDATE copy_intake_tokens SET copy_id = $2, book_id = $3 WHERE token = $1", [token, copyId, bookId]);
}

async function setRequests(pool, token, requests) {
  await pool.query("UPDATE copy_intake_tokens SET requests = $2 WHERE token = $1", [token, requests]);
}

// The first save failed before a copy existed: let the token go so a retry can save.
async function release(pool, token) {
  try { await pool.query("DELETE FROM copy_intake_tokens WHERE token = $1 AND copy_id IS NULL", [token]); } catch { /* the row is purged after a day anyway */ }
}

module.exports = { newToken, validToken, claim, attach, setRequests, release, WINDOW_MINUTES };
