// Genre rules: how the free-text genres of books.categories ("Children's Books, Fiction") are slotted into the
// MANAGED genres of Admin > Genres (table managed_genres). The matching and the rewriting are PURE functions here
// (no database): the bulk "Update all books" run (lib/genreRun.js) and the save paths (add / edit / scan intake)
// use the very same applyGenreRules(), so a new book never brings back a name the admin cleaned up.
//
// A rule is { kind, pattern, action, target, targetFr }:
//   kind 'exact'          the whole raw genre equals the pattern (case-insensitive, trimmed, spaces collapsed,
//                         the curly apostrophe is the straight one)
//   kind 'contains-word'  the raw genre contains the pattern as a WHOLE WORD (or whole words, in order). Plural and
//                         possessive endings are tolerated: the word Children matches Children, Childrens,
//                         Children's and Children’s; Comic matches Comics. NOT "Childhood" for Children, and nothing
//                         is matched by meaning: only the words you specify.
//   action 'map'          replace the raw genre by `target` (the managed English name; `targetFr` its French name)
//          'remove'       drop the raw genre from the book
//          'keep'         leave this raw genre as it is (an exact "Leave as is" stops a word rule from touching it)
//   kind 'managed'        (made by loadRules, never stored) every managed name is an exact rule to itself, the LAST
//                         resort: it normalises the capitals of a managed name ("fiction" -> "Fiction") and shows the
//                         genre as slotted. A rule you wrote wins over it: the word Fiction would also take
//                         Non-fiction, so use "Show matches" before saving a word rule, and protect a genre with an
//                         exact "Leave as is" rule.
//
// First match wins: stored exact rules (by priority), then word rules (by priority), then managed names.
// A genre no rule matches is LEFT AS IT IS. Duplicates collapse (case-insensitive), the order is kept, and a book
// with nothing left gets NULL.

const config = require("./config");
const { translateGenresToFrench, STATIC_KNOWN_GENRES, GENRE_ALIASES_FR, COMMON_GENRES, COMMON_GENRES_FR } = require("./bookLookup");
const { buildKnown, canonicalGenre, canonicalGenres, tidyFrench } = require("./genreClean");

const APOSTROPHES = /[‘’‛ʼ′`´]/g;

// The comparison form of a genre: lower case, straight apostrophes, single spaces.
function genreKey(s) {
  return String(s == null ? "" : s).replace(APOSTROPHES, "'").replace(/\s+/g, " ").trim().toLowerCase();
}

// "A, B ,, C" -> ["A", "B", "C"] (trimmed, empty ones dropped, nothing de-duplicated).
function splitGenres(csv) {
  return String(csv == null ? "" : csv).split(",").map((g) => g.trim()).filter(Boolean);
}

// The words of a genre (letters and digits; an apostrophe inside a word stays in it): "Children's Books" -> ["children's", "books"].
function words(s) {
  return genreKey(s).split(/[^\p{L}\p{N}']+/u).map((w) => w.replace(/^'+/, "")).filter(Boolean);
}

// Does the word `token` of a genre stand for the rule's word `p`? (both already in key form)
function wordEquals(token, p) {
  if (token === p) return true;
  const base = p.replace(/'s$/, "").replace(/s'$/, "s").replace(/'$/, "");
  const forms = new Set([base, `${base}s`, `${base}'s`, `${base}s'`, `${base}'`]);
  if (base.endsWith("s") && !base.endsWith("ss") && base.length > 3) forms.add(base.slice(0, -1)); // Comics -> Comic
  return forms.has(token);
}

// Whole-word(s) match of `pattern` inside `raw`.
function containsWord(pattern, raw) {
  const p = words(pattern);
  const t = words(raw);
  if (!p.length || t.length < p.length) return false;
  for (let i = 0; i + p.length <= t.length; i++) {
    let ok = true;
    for (let j = 0; j < p.length && ok; j++) ok = wordEquals(t[i + j], p[j]);
    if (ok) return true;
  }
  return false;
}

const KIND_ORDER = { exact: 0, "contains-word": 1, managed: 2 };

// Rules in matching order, with their comparison form worked out once. Accepts stored rules, managed rules and
// hand-made ones (tests): { kind, pattern, action?, target?, targetFr?, id?, sort? }. A rule with a target maps; one
// without a target and no action removes.
function compile(rules) {
  const list = (rules || []).map((r, i) => {
    const action = r.action || (r.target != null ? "map" : "remove");
    return {
      id: r.id == null ? null : r.id, kind: r.kind, pattern: String(r.pattern), key: genreKey(r.pattern), action,
      target: r.target == null ? null : String(r.target), targetFr: r.targetFr == null ? null : String(r.targetFr),
      targetId: r.targetId == null ? null : r.targetId, sort: Number.isFinite(r.sort) ? r.sort : i, _i: i,
    };
  }).filter((r) => r.key && KIND_ORDER[r.kind] !== undefined && (r.action !== "map" || r.target));
  list.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.sort - b.sort || a._i - b._i);
  return list;
}

const isCompiled = (rules) => Array.isArray(rules) && rules.compiled === true;
function ensureCompiled(rules) {
  if (isCompiled(rules)) return rules;
  const list = compile(rules);
  Object.defineProperty(list, "compiled", { value: true });
  return list;
}

// The first rule matching one raw genre, or null.
function matchRule(rules, raw) {
  const key = genreKey(raw);
  if (!key) return null;
  for (const r of ensureCompiled(rules)) {
    if (r.kind === "contains-word" ? containsWord(r.pattern, key) : r.key === key) return r;
  }
  return null;
}

// What a rule does to one raw genre: { out: string | null, rule }. `out` null = the genre is dropped.
function slot(rules, raw) {
  const rule = matchRule(rules, raw);
  if (!rule) return { out: String(raw).trim(), rule: null };
  if (rule.action === "remove") return { out: null, rule };
  if (rule.action === "keep") return { out: String(raw).trim(), rule };
  return { out: rule.target, rule };
}

// The whole rewrite of one book's genres, with everything the preview and the run need.
//   en        the new English string (NULL when nothing is left)
//   fr        the new French string, one entry per English genre: the managed French name for a mapped genre,
//             translateGenresToFrench (the fixed word list; the genre itself when it has no entry) for the rest
//   changed   the list of genres differs from the stored one (spacing alone does not count)
//   touched   at least one genre matched a rule (or a managed name): only then is the French recomputed
//   removed, renamed, collapsed   how many genres were dropped / replaced by a different text / merged as duplicates
function rewriteGenres(csv, rules) {
  const compiled = ensureCompiled(rules);
  const before = splitGenres(csv);
  const seen = new Set();
  const outEn = [];
  const outFr = [];
  let removed = 0, renamed = 0, collapsed = 0, touched = false;
  for (const raw of before) {
    // Cleaned first (lib/genreClean.js: curly apostrophe, a stray § at the end...), so a rule or a managed name also
    // takes "Children’s Fiction§"; a genre of the fixed taxonomy takes its own spelling. A genre that is nothing but
    // such characters ("§") is left as it is here (the bulk run never deletes on its own; a save drops it).
    const { out, rule } = slot(compiled, canonicalGenre(raw, STATIC_KNOWN_GENRES) || raw);
    if (rule) touched = true;
    if (out == null) { removed++; continue; }
    const k = genreKey(out);
    if (seen.has(k)) { collapsed++; continue; }
    seen.add(k);
    if (out !== raw) renamed++;
    outEn.push(out);
    outFr.push(rule && rule.action === "map" && rule.targetFr ? rule.targetFr : translateGenresToFrench(out) || out);
  }
  return {
    en: outEn.length ? outEn.join(", ") : null,
    fr: outFr.length ? outFr.join(", ") : null,
    changed: outEn.join("\u0000") !== before.join("\u0000"),
    touched, removed, renamed, collapsed, rule: null,
  };
}

// The pure function: "Children's Books, Fiction" -> "Children, Fiction". Returns the new English string (or null).
function applyGenreRules(csv, rules) {
  return rewriteGenres(csv, rules).en;
}

// A stored French string compared with a new one: spacing around the commas does not count.
const sameList = (a, b) => splitGenres(a).join("\u0000") === splitGenres(b).join("\u0000");

// For the rows of Update all books: { en, fr, changed } for one stored book (categories, categories_fr).
function planBook(categories, categoriesFr, rules) {
  const r = rewriteGenres(categories, rules);
  const frChanged = r.touched && !sameList(r.fr, categoriesFr);
  // English changed only by the clean-up (no rule took it): the stored French is cleaned too, not made again.
  const fr = r.touched ? r.fr : r.changed ? tidyFrench(categoriesFr, r.en, STATIC_KNOWN_GENRES) : categoriesFr == null ? null : categoriesFr;
  return { ...r, changed: r.changed || frChanged, enChanged: r.changed, frChanged, fr };
}

// ---------- rules as the database stores them ----------

const CACHE_MS = 60 * 1000;
const cacheMs = () => (config.isTest() ? 0 : CACHE_MS);
const caches = new WeakMap(); // pool -> { at, value }

// managed_genres + genre_rules -> { managed: [...], stored: [...], rules (compiled, with the managed-name rules), hasRules }.
async function readRules(db) {
  const { rows: managed } = await db.query("SELECT id, name_en, name_fr FROM managed_genres ORDER BY sort_order, id");
  const { rows: stored } = await db.query(
    `SELECT r.id, r.kind, r.pattern, r.action, r.sort_order, r.target_managed_genre_id, g.name_en, g.name_fr
     FROM genre_rules r LEFT JOIN managed_genres g ON g.id = r.target_managed_genre_id ORDER BY r.sort_order, r.id`
  );
  const frOf = (g) => (g.name_fr && g.name_fr.trim()) || translateGenresToFrench(g.name_en) || g.name_en;
  const fromStored = stored.map((r) => ({
    id: r.id, kind: r.kind, pattern: r.pattern, action: r.action, sort: r.sort_order,
    target: r.name_en || null, targetFr: r.name_en ? frOf(r) : null, targetId: r.target_managed_genre_id,
  }));
  const fromManaged = managed.map((g, i) => ({ kind: "managed", pattern: g.name_en, action: "map", target: g.name_en, targetFr: frOf(g), targetId: g.id, sort: i }));
  return { managed, stored: fromStored, rules: ensureCompiled([...fromStored, ...fromManaged]), hasRules: fromStored.length > 0 };
}

// The same, cached in this process for 60 s (off in tests); clearRulesCache() after any rule or genre change.
async function loadRules(pool) {
  const hit = caches.get(pool);
  if (hit && Date.now() - hit.at < cacheMs()) return hit.value;
  const value = await readRules(pool);
  caches.set(pool, { at: Date.now(), value });
  return value;
}

function clearRulesCache(pool) {
  if (pool) caches.delete(pool);
}

// The known genres for the save paths (lib/genreClean.js): the fixed lists plus the managed genres of Admin > Genres
// (from the cached rules). A database problem falls back to the fixed lists.
async function knownGenres(pool) {
  try {
    const { managed } = await loadRules(pool);
    return buildKnown({ aliases: GENRE_ALIASES_FR, common: COMMON_GENRES, commonFr: COMMON_GENRES_FR, managed });
  } catch (err) {
    console.error("Managed genres not read:", err.message);
    return STATIC_KNOWN_GENRES;
  }
}

// Every save of a book's genres (add, scan intake, edit, the French backfill) goes through this first: each genre is
// cleaned, a known genre (taxonomy or managed) takes its own spelling, and the French is cleaned too; a French entry
// that is only the English name of a known genre becomes its French; no French at all: made from the English.
// -> { genre, genreFr }
async function tidyBookGenres(pool, genre, genreFr) {
  const known = await knownGenres(pool);
  const en = canonicalGenres(genre, known);
  return { genre: en, genreFr: en ? tidyFrench(genreFr, en, known) : genreFr ? tidyFrench(genreFr, null, known) : null };
}

// The save paths: a book saved with `genre` / `genreFr` as typed. First the clean-up above (tidyBookGenres). Then, with
// NO stored rule nothing more changes (the managed list alone never rewrites a book on its own). Otherwise the genres
// go through the rules and the French follows what the rules decided; a rules problem never stops a save.
async function applyRulesToBook(pool, genre, genreFr) {
  ({ genre, genreFr } = await tidyBookGenres(pool, genre, genreFr));
  try {
    const { rules, hasRules } = await loadRules(pool);
    if (!hasRules || !genre) return { genre, genreFr };
    const r = rewriteGenres(genre, rules);
    if (!r.changed && !r.touched) return { genre, genreFr };
    if (!r.changed) return { genre, genreFr }; // same genres: keep the French exactly as the person typed it
    return { genre: r.en, genreFr: r.fr };
  } catch (err) {
    console.error("Genre rules not applied:", err.message);
    return { genre, genreFr };
  }
}

module.exports = {
  genreKey, splitGenres, words, containsWord, compile, ensureCompiled, matchRule, slot, rewriteGenres, applyGenreRules, planBook, sameList,
  readRules, loadRules, clearRulesCache, knownGenres, tidyBookGenres, applyRulesToBook, CACHE_MS,
};
