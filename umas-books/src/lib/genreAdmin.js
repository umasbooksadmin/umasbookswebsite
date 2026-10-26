// The data side of Admin > Genres (routes/admin/genres.js): the FOUND genres (every distinct raw genre of
// books.categories with how many books use it), the managed genres, and the mapping rules. The rewriting of books is in
// lib/genreRun.js, the matching in lib/genreRules.js, the AI help in lib/genreSuggest.js.
//
// Nothing here changes a book. Every edit of a managed genre or a rule clears the caches (rules, found genres, Browse
// buttons), so the next page and the next save see it.

const { genreKey, readRules, matchRule, containsWord, clearRulesCache } = require("./genreRules");
const { PALETTE_KEYS, ICON_KEYS, DEFAULT_ICON, slugify, nextColour, clearBrowseGenreCache } = require("./browseGenres");
const { clearBrowseCaches } = require("./latestArrivals");
const config = require("./config");
const { translateGenresToFrench } = require("./bookLookup");

const NAME_MAX = 60;
const PATTERN_MAX = 80;
const FOUND_CACHE_MS = 60 * 1000;
const foundCaches = new WeakMap(); // pool -> { at, value }

// Everything that depends on the genres: called after any change of a managed genre, a rule, or the books' genres.
function clearAll(pool) {
  clearRulesCache(pool);
  foundCaches.delete(pool);
  clearBrowseGenreCache(pool);
  clearBrowseCaches(pool);
}

// ---------- Found genres ----------

// One aggregate query: every distinct raw genre (split on commas, trimmed, case-insensitive, curly apostrophes
// straight), the number of BOOKS using it and its most common spelling. Cached for a minute (off in tests).
async function foundGenres(pool) {
  const hit = foundCaches.get(pool);
  if (hit && Date.now() - hit.at < (config.isTest() ? 0 : FOUND_CACHE_MS)) return hit.value;
  const { rows } = await pool.query(
    `WITH raw AS (
       SELECT b.id, btrim(g) AS spelling,
              lower(regexp_replace(translate(btrim(g), $1, $2), '\\s+', ' ', 'g')) AS key
       FROM books b, unnest(string_to_array(b.categories, ',')) AS g
       WHERE b.categories IS NOT NULL
     ), keyed AS (
       SELECT key, count(DISTINCT id)::int AS books FROM raw WHERE key <> '' GROUP BY key
     ), spelled AS (
       SELECT DISTINCT ON (key) key, spelling
       FROM (SELECT key, spelling, count(*) AS c FROM raw WHERE key <> '' GROUP BY key, spelling) s
       ORDER BY key, c DESC, spelling
     )
     SELECT k.key, s.spelling, k.books FROM keyed k JOIN spelled s USING (key)`,
    ["\u2018\u2019\u201B\u02BC\u2032`\u00B4", "'".repeat(7)]
  );
  const value = rows.map((r) => ({ key: r.key, name: r.spelling, books: r.books }));
  foundCaches.set(pool, { at: Date.now(), value });
  return value;
}

const SORTS = {
  books: (a, b) => b.books - a.books || a.name.localeCompare(b.name, "en"),
  "books-asc": (a, b) => a.books - b.books || a.name.localeCompare(b.name, "en"),
  name: (a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
  "name-desc": (a, b) => b.name.localeCompare(a.name, "en", { sensitivity: "base" }),
  target: (a, b) => (a.targetLabel || "￿").localeCompare(b.targetLabel || "￿", "en") || b.books - a.books,
};

// What a found genre is slotted into by the current rules. targetLabel: the managed genre's name, "Remove", "Leave as is"
// or "" (unmapped); `rule` is the stored rule that matched, or "managed" for the genre's own name.
function describeMatch(rules, name) {
  const r = matchRule(rules, name);
  if (!r) return { targetLabel: "", status: "unmapped", rule: null };
  const via = r.kind === "managed" ? "its own name" : r.kind === "exact" ? "exact rule" : `word "${r.pattern}"`;
  if (r.action === "remove") return { targetLabel: "Remove", status: "remove", rule: r, via };
  if (r.action === "keep") return { targetLabel: "Leave as is", status: "keep", rule: r, via };
  return { targetLabel: r.target, status: r.kind === "managed" ? "managed" : "mapped", rule: r, via };
}

// The Found genres table: filtered, sorted and paged in memory (a few thousand rows at most).
//   filter: "all" | "unmapped" | "mapped"   q: part of the name   sort: a key of SORTS   page: 1-based
function queryFound(found, rules, { filter = "all", q = "", sort = "books", page = 1, pageSize = 100 } = {}) {
  const needle = genreKey(q);
  let rows = found.map((f) => ({ ...f, ...describeMatch(rules, f.name) }));
  const counts = { all: rows.length, unmapped: rows.filter((r) => r.status === "unmapped").length };
  counts.mapped = counts.all - counts.unmapped;
  if (needle) rows = rows.filter((r) => r.key.includes(needle));
  if (filter === "unmapped") rows = rows.filter((r) => r.status === "unmapped");
  else if (filter === "mapped") rows = rows.filter((r) => r.status !== "unmapped");
  rows.sort(SORTS[sort] || SORTS.books);
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(1, page), pages);
  return { rows: rows.slice((p - 1) * pageSize, p * pageSize), total, page: p, pages, counts };
}

// "Show matches": the found genres a NEW rule would take (unmapped ones, and genres that only match their own managed
// name), and the ones it matches but another rule already handles (first match wins: the new rule goes last of its kind).
function previewRule(found, rules, { kind, pattern }) {
  const key = genreKey(pattern);
  const takes = [];
  const handled = [];
  if (!key) return { takes, handled, books: 0 };
  for (const f of found) {
    const hit = kind === "contains-word" ? containsWord(pattern, f.name) : f.key === key;
    if (!hit) continue;
    const m = describeMatch(rules, f.name);
    // A managed genre's own name is the last resort of the matching, so a new rule of the kind takes it too.
    if (kind === "exact" || m.status === "unmapped" || m.status === "managed") takes.push({ name: f.name, books: f.books, was: m.status === "unmapped" ? "" : m.status === "managed" ? "its own name" : m.targetLabel });
    else handled.push({ name: f.name, books: f.books, by: m.via, target: m.targetLabel });
  }
  takes.sort((a, b) => b.books - a.books);
  handled.sort((a, b) => b.books - a.books);
  return { takes, handled, books: takes.reduce((n, t) => n + t.books, 0) };
}

// ---------- Managed genres ----------

// The managed list with how many books carry each genre as one of their genres.
async function listManaged(pool) {
  const { rows } = await pool.query("SELECT * FROM managed_genres ORDER BY sort_order, id");
  const found = await foundGenres(pool);
  const byKey = new Map(found.map((f) => [f.key, f.books]));
  return rows.map((g) => ({ ...g, books: byKey.get(genreKey(g.name_en)) || 0 }));
}

function cleanName(v, max = NAME_MAX) {
  return String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f,]/g, " ").replace(/\s+/g, " ").trim().slice(0, max); // eslint-disable-line no-control-regex
}

const isUnique = (err) => err && err.code === "23505";

// -> { ok: true, id } | { ok: false, error }
async function addManaged(pool, { nameEn, nameFr }) {
  if (String(nameEn == null ? "" : nameEn).includes(",")) return { ok: false, error: "A genre name cannot contain a comma (genres are separated by commas)." };
  const en = cleanName(nameEn);
  if (!en) return { ok: false, error: "Type the genre's English name." };
  const fr = cleanName(nameFr) || translateGenresToFrench(en) || en;
  try {
    const { rows: last } = await pool.query("SELECT colour FROM managed_genres ORDER BY id DESC LIMIT 1");
    const colour = nextColour(last[0] && last[0].colour);
    const base = slugify(en);
    let slug = base;
    for (let i = 2; i < 50; i++) {
      const { rows } = await pool.query("SELECT 1 FROM managed_genres WHERE browse_slug = $1", [slug]);
      if (!rows.length) break;
      slug = `${base}-${i}`;
    }
    const { rows } = await pool.query(
      `INSERT INTO managed_genres (name_en, name_fr, sort_order, show_on_browse, browse_slug, browse_order, colour, icon)
       VALUES ($1, $2, COALESCE((SELECT max(sort_order) FROM managed_genres), 0) + 1, true, $3,
               COALESCE((SELECT max(browse_order) FROM managed_genres), 0) + 1, $4, $5) RETURNING id`,
      [en, fr, slug, colour, DEFAULT_ICON]
    );
    clearAll(pool);
    return { ok: true, id: rows[0].id };
  } catch (err) {
    if (isUnique(err)) return { ok: false, error: `"${en}" is already a managed genre.` };
    throw err;
  }
}

// Edits one managed genre. A new English name also leaves an exact rule old name -> this genre, so "Update all books" can
// carry the books over (the "Rename everywhere" flow). -> { ok, error?, renamedFrom?: string }
async function updateManaged(pool, id, input) {
  const { rows: [cur] } = await pool.query("SELECT * FROM managed_genres WHERE id = $1", [id]);
  if (!cur) return { ok: false, error: "That genre no longer exists." };
  if (String(input.nameEn == null ? "" : input.nameEn).includes(",")) return { ok: false, error: "A genre name cannot contain a comma (genres are separated by commas)." };
  const en = cleanName(input.nameEn) || cur.name_en;
  const fr = cleanName(input.nameFr) || translateGenresToFrench(en) || en;
  const colour = PALETTE_KEYS.includes(input.colour) ? input.colour : cur.colour;
  const icon = ICON_KEYS.includes(input.icon) ? input.icon : cur.icon;
  const show = input.showOnBrowse === true;
  const labelEn = cleanName(input.labelEn) || null;
  const labelFr = cleanName(input.labelFr) || null;
  const topic = cleanName(input.topic, 300) || null;
  const order = Number.isInteger(input.browseOrder) ? Math.min(Math.max(input.browseOrder, 0), 1000) : cur.browse_order;
  try {
    await pool.query(
      `UPDATE managed_genres SET name_en = $2, name_fr = $3, show_on_browse = $4, colour = $5, icon = $6,
              browse_label_en = $7, browse_label_fr = $8, browse_topic = $9, browse_order = $10, updated_at = now() WHERE id = $1`,
      [id, en, fr, show, colour, icon, labelEn, labelFr, topic, order]
    );
  } catch (err) {
    if (isUnique(err)) return { ok: false, error: `"${en}" is already a managed genre.` };
    throw err;
  }
  let renamedFrom = null;
  if (genreKey(cur.name_en) !== genreKey(en)) {
    renamedFrom = cur.name_en;
    await pool.query(
      `INSERT INTO genre_rules (kind, pattern, pattern_key, action, target_managed_genre_id, sort_order)
       VALUES ('exact', $1, $2, 'map', $3, COALESCE((SELECT max(sort_order) FROM genre_rules), 0) + 1)
       ON CONFLICT (kind, pattern_key) DO NOTHING`,
      [cur.name_en, genreKey(cur.name_en), id]
    );
  }
  clearAll(pool);
  return { ok: true, renamedFrom };
}

async function moveManaged(pool, id, direction) {
  const { rows } = await pool.query("SELECT id FROM managed_genres ORDER BY sort_order, id");
  const ids = rows.map((r) => r.id);
  const i = ids.indexOf(id);
  const j = direction === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= ids.length) return false;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await pool.query(
    "UPDATE managed_genres g SET sort_order = t.n FROM (SELECT x AS id, ordinality::int AS n FROM unnest($1::int[]) WITH ORDINALITY AS u(x, ordinality)) t WHERE g.id = t.id",
    [ids]
  );
  clearAll(pool);
  return true;
}

// What deleting a genre does: its rules (they go with it, those genres become unmapped) and the books that carry its name.
async function deleteImpact(pool, id) {
  const { rows: [g] } = await pool.query("SELECT * FROM managed_genres WHERE id = $1", [id]);
  if (!g) return null;
  const { rows: rules } = await pool.query("SELECT id, kind, pattern FROM genre_rules WHERE target_managed_genre_id = $1 ORDER BY sort_order, id", [id]);
  const found = await foundGenres(pool);
  const key = genreKey(g.name_en);
  return { genre: g, rules, books: (found.find((f) => f.key === key) || { books: 0 }).books };
}

async function deleteManaged(pool, id) {
  const { rowCount } = await pool.query("DELETE FROM managed_genres WHERE id = $1", [id]); // its rules go with it (ON DELETE CASCADE)
  clearAll(pool);
  return rowCount > 0;
}

// The Genre filter of the admin Inventory: the managed genres first, then the raw genres in use that are not managed
// (grouped under "Other": the 200 most used, A to Z). A genre typed in the address stays selectable.
const OTHER_MAX = 200;
async function genreFilterOptions(pool, selected = "") {
  const [{ rows }, found] = await Promise.all([pool.query("SELECT name_en FROM managed_genres ORDER BY sort_order, id"), foundGenres(pool)]);
  const managed = rows.map((r) => r.name_en);
  const managedKeys = new Set(managed.map(genreKey));
  const other = found.filter((f) => !managedKeys.has(f.key)).sort((a, b) => b.books - a.books).slice(0, OTHER_MAX).map((f) => f.name)
    .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  const key = genreKey(selected);
  if (key && !managedKeys.has(key) && !other.some((n) => genreKey(n) === key)) other.push(String(selected));
  return { managed, other };
}

// ---------- Rules ----------

// "m:12" -> { action: "map", targetId: 12 }; "remove"; "keep" (an exact rule only); "none" -> { action: null } (no rule); anything else (a blank placeholder too) -> null (refused).
function parseTarget(value) {
  const v = String(value == null ? "" : value);
  const m = /^m:(\d{1,9})$/.exec(v);
  if (m) return { action: "map", targetId: Number(m[1]) };
  if (v === "remove") return { action: "remove", targetId: null };
  if (v === "keep") return { action: "keep", targetId: null };
  if (v === "none") return { action: null, targetId: null };
  return null;
}

const nextSort = "COALESCE((SELECT max(sort_order) FROM genre_rules), 0) + 1";

// Saves the rule `kind pattern -> target` (an existing rule with that kind and pattern is changed). action null on an
// exact rule removes it (the genre goes back to "Unmapped").
// -> { ok, error?, id?, removed? }
async function saveRule(pool, { kind, pattern, target }) {
  if (kind !== "exact" && kind !== "contains-word") return { ok: false, error: "Choose what kind of rule it is." };
  const text = cleanName(pattern, PATTERN_MAX).replace(/[‘’]/g, "'");
  if (!genreKey(text)) return { ok: false, error: kind === "exact" ? "No genre given." : "Type the word to look for." };
  if (kind === "contains-word" && /[,]/.test(String(pattern))) return { ok: false, error: "Type one word (or one short phrase), without commas." };
  const t = parseTarget(target);
  if (!t) return { ok: false, error: "Choose where these genres go." };
  const key = genreKey(text);
  if (!t.action) {
    const r = await pool.query("DELETE FROM genre_rules WHERE kind = $1 AND pattern_key = $2", [kind, key]);
    clearAll(pool);
    return { ok: true, removed: r.rowCount > 0 };
  }
  if (kind === "contains-word" && t.action === "keep") return { ok: false, error: "A word rule can map to a genre or remove; use \"Leave as is\" on a single genre instead." };
  if (t.action === "map") {
    const { rows } = await pool.query("SELECT 1 FROM managed_genres WHERE id = $1", [t.targetId]);
    if (!rows.length) return { ok: false, error: "That managed genre no longer exists." };
  }
  const { rows } = await pool.query(
    `INSERT INTO genre_rules (kind, pattern, pattern_key, action, target_managed_genre_id, sort_order)
     VALUES ($1, $2, $3, $4, $5, ${nextSort})
     ON CONFLICT (kind, pattern_key) DO UPDATE SET action = EXCLUDED.action, target_managed_genre_id = EXCLUDED.target_managed_genre_id, pattern = EXCLUDED.pattern, updated_at = now()
     RETURNING id`,
    [kind, text, key, t.action, t.targetId]
  );
  clearAll(pool);
  return { ok: true, id: rows[0].id };
}

async function updateRule(pool, id, { pattern, target }) {
  const { rows: [cur] } = await pool.query("SELECT * FROM genre_rules WHERE id = $1", [id]);
  if (!cur) return { ok: false, error: "That rule no longer exists." };
  const t = parseTarget(target);
  if (!t || !t.action) return { ok: false, error: "Choose where these genres go (to stop a rule, delete it)." };
  if (cur.kind === "contains-word" && t.action === "keep") return { ok: false, error: "A word rule can map to a genre or remove." };
  const text = cleanName(pattern, PATTERN_MAX).replace(/[‘’]/g, "'") || cur.pattern;
  try {
    await pool.query(
      "UPDATE genre_rules SET pattern = $2, pattern_key = $3, action = $4, target_managed_genre_id = $5, updated_at = now() WHERE id = $1",
      [id, text, genreKey(text), t.action, t.targetId]
    );
  } catch (err) {
    if (isUnique(err)) return { ok: false, error: "There is already a rule for that." };
    if (err.code === "23503") return { ok: false, error: "That managed genre no longer exists." };
    throw err;
  }
  clearAll(pool);
  return { ok: true };
}

async function deleteRule(pool, id) {
  const { rows } = await pool.query("DELETE FROM genre_rules WHERE id = $1 RETURNING kind, pattern", [id]);
  clearAll(pool);
  return rows[0] || null;
}

// Moves a rule up or down among the rules of its own kind (priority: the first match wins).
async function moveRule(pool, id, direction) {
  const { rows: [r] } = await pool.query("SELECT kind FROM genre_rules WHERE id = $1", [id]);
  if (!r) return false;
  const { rows } = await pool.query("SELECT id FROM genre_rules WHERE kind = $1 ORDER BY sort_order, id", [r.kind]);
  const ids = rows.map((x) => x.id);
  const i = ids.indexOf(id);
  const j = direction === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= ids.length) return false;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await pool.query(
    "UPDATE genre_rules g SET sort_order = t.n FROM (SELECT x AS id, ordinality::int AS n FROM unnest($1::int[]) WITH ORDINALITY AS u(x, ordinality)) t WHERE g.id = t.id",
    [ids]
  );
  clearAll(pool);
  return true;
}

// The stored rules for the page: exact ones, then word ones, each in priority order, with the target's name and how many
// found genres (and books) they take right now.
async function listRules(pool, found) {
  const { stored, rules } = await readRules(pool);
  const taken = new Map(); // rule id -> { genres, books }
  for (const f of found) {
    const r = matchRule(rules, f.name);
    if (!r || r.id == null) continue;
    const t = taken.get(r.id) || { genres: 0, books: 0 };
    t.genres += 1;
    t.books += f.books;
    taken.set(r.id, t);
  }
  const order = { exact: 0, "contains-word": 1 };
  return stored
    .slice()
    .sort((a, b) => order[a.kind] - order[b.kind] || a.sort - b.sort || a.id - b.id)
    .map((r) => ({ ...r, genres: (taken.get(r.id) || {}).genres || 0, books: (taken.get(r.id) || {}).books || 0 }));
}

module.exports = {
  genreFilterOptions, OTHER_MAX, NAME_MAX, PATTERN_MAX, clearAll, foundGenres, queryFound, describeMatch, previewRule, listManaged, addManaged, updateManaged, moveManaged,
  deleteImpact, deleteManaged, parseTarget, saveRule, updateRule, deleteRule, moveRule, listRules, cleanName,
};
