// The ONE place passwords are hashed and checked.
//
// Native `bcrypt` (not the pure-JS `bcryptjs`): a cost-12 bcrypt is ~200 ms of
// pure CPU, and bcryptjs spends all of it on the MAIN (event-loop) thread, so a
// burst of logins froze every other request (12 parallel failed logins pushed an
// unrelated endpoint from 14 ms to 600+ ms). The native module runs each
// hash/compare on libuv's thread pool instead, so the event loop keeps serving.
//
// Hashes are the same bcrypt format ($2a$/$2b$), so every stored hash keeps
// verifying and nothing needs rehashing; the 72-byte input limit behaves as
// before (the input is silently truncated by both libraries).
//
// A small semaphore caps how many bcrypt operations run at once. libuv's pool
// has 4 threads by default and also serves fs, dns and crypto, so bcrypt is
// held to 2: on the single vCPU of a small instance that bounds CPU use and
// leaves threads for everything else. Beyond MAX_WAITING queued operations the
// caller gets a PasswordBusyError (HTTP 503 + Retry-After via sendBusy) instead
// of an unbounded backlog.
const bcrypt = require("bcrypt");

const COST = 12;
const MAX_CONCURRENT = 2;
const MAX_WAITING = 20;
const RETRY_AFTER_SECONDS = 5;

// Hash of a throwaway string at COST: lets a login for an unknown email run a
// compare of the same cost as a real one (no timing difference reveals which
// emails are registered). Nobody has the matching password, so it never matches.
const DUMMY_HASH = "$2b$12$qA1nNAuQPEhmtrYtkJ3Cm.TtuMKaOI4RWSYChQTMi73g7UOxXL8wq";

class PasswordBusyError extends Error {
  constructor() {
    super("Too many password checks in progress");
    this.name = "PasswordBusyError";
    this.code = "PASSWORD_BUSY";
    this.status = 503;
  }
}

let running = 0;
const waiting = [];

function acquire() {
  if (running < MAX_CONCURRENT) {
    running += 1;
    return Promise.resolve();
  }
  if (waiting.length >= MAX_WAITING) return Promise.reject(new PasswordBusyError());
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next(); // hand the slot straight over: running stays the same
  else running -= 1;
}

async function limited(task) {
  await acquire();
  try {
    return await task();
  } finally {
    release();
  }
}

const asText = (v) => (typeof v === "string" ? v : String(v ?? ""));

const hash = (password, cost = COST) => limited(() => bcrypt.hash(asText(password), cost));

const compare = (password, storedHash) => limited(() => bcrypt.compare(asText(password), asText(storedHash)));

// Always false, but costs what a real compare costs.
const compareDummy = (password) => compare(password, DUMMY_HASH).then(() => false);

// True when a stored hash was made with a cost other than `cost` (for a future
// cost bump: rehash after a successful login). Malformed hashes count as stale.
function needsRehash(storedHash, cost = COST) {
  try {
    return bcrypt.getRounds(asText(storedHash)) !== cost;
  } catch {
    return true;
  }
}

// One throwaway "nobody knows this password" hash (cost 10) for accounts that
// must exist before their owner chooses a password. Made once, on first use.
let unusable = null;
function unusableHash() {
  if (!unusable) {
    unusable = hash(require("crypto").randomBytes(32).toString("hex"), 10).catch((err) => {
      unusable = null;
      throw err;
    });
  }
  return unusable;
}

const isBusy = (err) => Boolean(err && err.code === "PASSWORD_BUSY");

// The friendly 503 answer. Not a server fault: no alert, the person just retries.
function sendBusy(req, res) {
  const tr = typeof req.tr === "function" ? req.tr : typeof res.locals.tr === "function" ? res.locals.tr : (en) => en;
  const message = tr(
    "We're busy right now. Please try again in a moment.",
    "Nous sommes très sollicités en ce moment. Veuillez réessayer dans un instant."
  );
  res.set("Retry-After", String(RETRY_AFTER_SECONDS));
  res.set("Cache-Control", "no-store");
  res.status(503);
  return res.render("error", { status: 503, message }, (err, html) => {
    if (err) return res.type("text").send(message);
    res.send(html);
  });
}

// Test hook: current load.
const stats = () => ({ running, waiting: waiting.length });

module.exports = {
  COST,
  MAX_CONCURRENT,
  MAX_WAITING,
  RETRY_AFTER_SECONDS,
  DUMMY_HASH,
  PasswordBusyError,
  hash,
  compare,
  compareDummy,
  needsRehash,
  unusableHash,
  isBusy,
  sendBusy,
  stats,
};
