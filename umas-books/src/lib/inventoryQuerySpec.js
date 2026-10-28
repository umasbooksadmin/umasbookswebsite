"use strict";
// The query language behind "Describe what you are looking for" on the admin Inventory page (/admin/inventory).
//
// The AI (lib/inventoryNlSearch.js) turns Sharon's sentence into a SPEC, a small JSON object; it never writes SQL.
// This module is the only thing that reads a spec: validateSpec() checks it strictly against the whitelist below
// (unknown field, unknown operator, wrong value type, too deep or too big: a friendly error, never a 500),
// buildSpecSql() turns a VALIDATED spec into parameterised SQL (every value is a bound $n parameter, every column
// name comes from FIELDS, never from the spec), and explainSpec() writes the plain-English "Understood as: ..." from
// the validated spec (the server's words, not the model's). Read-only: it only ever builds WHERE / ORDER BY parts.
//
// SPEC (version 1):
//   { "copies": "in_stock" | "sold" | "all",        which copies count (default in_stock: copies in the store)
//     "where":  NODE,                               optional: no condition = every book with such a copy
//     "sort":   { "field": F, "dir": "asc"|"desc" } optional: default the list's own order (title)
//   }
//   NODE = { "and": [NODE, ...] } | { "or": [NODE, ...] } | LEAF          (at most MAX_DEPTH levels of groups)
//   LEAF = { "field": F, "op": OP, "value": V }                            compare with a value
//        | { "field": F, "op": "in" | "not_in", "values": [V, ...] }
//        | { "field": F, "op": "between", "values": [LOW, HIGH] }         both ends included
//        | { "field": F, "op": "is_empty" | "is_not_empty" }
//        | { "field": F, "op": OP, "field2": F2 }                         compare two fields of the same type
//        optional "or_missing": true on a comparison: a blank field (or either blank field) also matches.
//
// MISSING VALUES: a comparison never matches a blank value unless "or_missing" is true. So
// price != publisher_price means "both set and different": a copy with no publisher price is NOT listed.
// The explanation says so every time it matters.
//
// ONE COPY: the whole condition is checked against a (book, copy) pair, so every copy-level part must be true of
// the SAME copy (like the filters above it: "in Store and under 5 euros" is one copy, never a Store copy plus a
// cheap copy elsewhere). A book matches when at least one copy in scope satisfies it. Only a book-level condition
// with copies "all" is checked on the book alone (so books with no copy at all can match).

const { CONDITIONS, BINDINGS, STATUSES, SOURCES } = require("./inventory");
const { parseDay } = require("./validation");
const { likeContains } = require("./parseParams");
const { SITE_TIME_ZONE } = require("./tz");

const VERSION = 1;
const MAX_DEPTH = 3; // a group, a group inside it, a group inside that: deeper is refused
const MAX_LEAVES = 20;
const MAX_CHILDREN = 12;
const MAX_VALUES = 30;
const MAX_TEXT = 100;
const MAX_SPEC_CHARS = 4000; // the spec travels in the URL (?nl=...)

const enumOf = (list, extra = []) => [...list.map((x) => ({ value: x.value, label: x.label })), ...extra];

// The whitelist. level: "book" (column of books b) or "copy" (column of book_copies c). type decides the operators,
// the value check, the SQL and the wording. sql(alias) is built here only: the spec names a key of FIELDS, nothing else.
const FIELDS = {
  title: { level: "book", type: "text", col: "title", notNull: true, label: "title", doc: "the book's title" },
  author: { level: "book", type: "text", col: "authors", label: "author", doc: "the author(s), one text" },
  isbn: { level: "book", type: "text", col: "isbn", label: "ISBN", doc: "the ISBN, digits as stored" },
  publisher: { level: "book", type: "text", col: "publisher", label: "publisher", doc: "the publishing house's name" },
  description: { level: "book", type: "text", col: "description", label: "description", doc: "the English description text" },
  published_year: { level: "book", type: "integer", col: "published_year", label: "year published", doc: "year of publication" },
  genre: { level: "book", type: "genre", col: "categories", label: "genre", doc: "the book's genres (a book can have several)" },
  binding: { level: "book", type: "enum", col: "binding", label: "binding", nullable: true, values: enumOf(BINDINGS), doc: "the format" },
  price: { level: "copy", type: "money", col: "price", label: "customer price", doc: "the price the shop sells THIS copy for (euros)" },
  publisher_price: { level: "copy", type: "money", col: "publisher_price", label: "publisher's price", doc: "the publisher's list price recorded for this copy (euros); often blank" },
  acquisition_cost: { level: "copy", type: "money", col: "acquisition_cost", label: "cost (what we paid)", doc: "what the shop paid for this copy (euros); 0 for donations" },
  suggested_price: { level: "copy", type: "money", col: "suggested_price", label: "suggested price", doc: "the price the pricing helper suggested (euros)" },
  condition: { level: "copy", type: "enum", col: "condition", label: "condition", notNull: true, values: enumOf(CONDITIONS), doc: "the copy's condition" },
  location: { level: "copy", type: "text", col: "location", label: "location", doc: "where the copy is kept (a shelf or room name)" },
  status: { level: "copy", type: "enum", col: "status", label: "status", notNull: true, values: enumOf(STATUSES, [{ value: "in_cart", label: "In a customer's cart" }]), doc: "the copy's status" },
  source: { level: "copy", type: "enum", col: "source", label: "source", nullable: true, values: enumOf(SOURCES), doc: "where the copy came from" },
  acquired_at: { level: "copy", type: "date", col: "acquired_at", label: "date received", doc: "the day the copy was received (Acquisition Date)" },
  added_at: { level: "copy", type: "date", col: "created_at", timestamp: true, notNull: true, label: "date added to the system", doc: "the day the copy was entered in the system" },
  sold_at: { level: "copy", type: "date", col: "sold_at", timestamp: true, label: "date sold", doc: "the day the copy was sold (blank if not sold)" },
  clearance: { level: "copy", type: "boolean", col: "is_clearance", label: "on clearance", doc: "true when the copy is on clearance" },
  notes: { level: "copy", type: "text", col: "notes", label: "notes", doc: "the staff notes on the copy" },
};

const COMPARE = ["=", "!=", "<", "<=", ">", ">="];
const OPS_BY_TYPE = {
  text: ["=", "!=", "contains", "not_contains", "in", "not_in", "is_empty", "is_not_empty"],
  integer: [...COMPARE, "between", "in", "not_in", "is_empty", "is_not_empty"],
  money: [...COMPARE, "between", "in", "not_in", "is_empty", "is_not_empty"],
  date: [...COMPARE, "between", "is_empty", "is_not_empty"],
  enum: ["=", "!=", "in", "not_in", "is_empty", "is_not_empty"],
  boolean: ["="],
  genre: ["=", "!=", "contains", "not_contains", "in", "not_in", "is_empty", "is_not_empty"],
};
// Field-vs-field: only these types, only these operators (text: equal / different only).
const FIELD_COMPARE_OPS = { integer: COMPARE, money: COMPARE, date: COMPARE, text: ["=", "!="] };
const ALL_OPS = [...new Set(Object.values(OPS_BY_TYPE).flat())];
const COPIES = ["in_stock", "sold", "all"];
const SORTABLE = ["title", "author", "published_year", "price", "publisher_price", "acquisition_cost", "acquired_at", "added_at", "sold_at"];
const NEGATIVE = new Set(["!=", "not_in", "not_contains"]);

class SpecError extends Error {}
const fail = (msg) => { throw new SpecError(msg); };
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const fieldName = (f) => (typeof f === "string" && f.length <= 40 ? f : "(not a name)");

function onlyKeys(obj, allowed, what) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) fail(`${what} has an unknown part "${fieldName(k)}".`);
}

// One value of `field` -> its canonical form, or a SpecError.
function checkValue(field, def, v) {
  const name = def.label;
  switch (def.type) {
    case "text":
    case "genre": {
      if (typeof v !== "string" && typeof v !== "number") fail(`The ${name} must be compared with a text.`);
      const s = String(v).replace(/\s+/g, " ").trim();
      if (!s) fail(`The ${name} cannot be compared with an empty text (use "is empty" instead).`);
      if (s.length > MAX_TEXT) fail(`A text to look for is too long (at most ${MAX_TEXT} characters).`);
      return s;
    }
    case "integer": {
      const n = typeof v === "string" && /^-?\d{1,4}$/.test(v.trim()) ? Number(v) : v;
      if (!Number.isInteger(n) || n < -3000 || n > 3000) fail(`The ${name} must be a whole year, like 1950.`);
      return n;
    }
    case "money": {
      const n = typeof v === "string" && /^\d{1,5}([.,]\d{1,2})?$/.test(v.trim()) ? Number(v.replace(",", ".")) : v;
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n >= 100000) fail(`The ${name} must be an amount in euros, like 5 or 4.50.`);
      return Math.round(n * 100) / 100;
    }
    case "date": {
      const r = parseDay(typeof v === "string" ? v : "x", { allowBlank: false, label: `The ${name}` });
      if (r.error) fail(r.error);
      return r.value;
    }
    case "enum": {
      const s = typeof v === "string" ? v.trim().toLowerCase() : "";
      const hit = def.values.find((x) => x.value === s || x.label.toLowerCase() === s);
      if (!hit) fail(`"${String(v).slice(0, 40)}" is not a ${name} (choices: ${def.values.map((x) => x.label).join(", ")}).`);
      return hit.value;
    }
    case "boolean":
      if (typeof v !== "boolean") fail(`"${name}" must be true or false.`);
      return v;
    default:
      return fail("Unknown type.");
  }
}

function checkLeaf(node, counter) {
  onlyKeys(node, ["field", "op", "value", "values", "field2", "or_missing"], "A condition");
  const def = Object.hasOwn(FIELDS, node.field) ? FIELDS[node.field] : null;
  if (!def) fail(`The search does not know the field "${fieldName(node.field)}".`);
  if (typeof node.op !== "string" || !ALL_OPS.includes(node.op)) fail(`The search does not know the operator "${fieldName(node.op)}".`);
  if (!OPS_BY_TYPE[def.type].includes(node.op)) fail(`"${node.op}" cannot be used with the ${def.label}.`);
  if (node.or_missing !== undefined && typeof node.or_missing !== "boolean") fail('"or_missing" must be true or false.');
  counter.leaves += 1;
  if (counter.leaves > MAX_LEAVES) fail(`That search has too many conditions (at most ${MAX_LEAVES}).`);

  const out = { field: node.field, op: node.op };
  const has = (k) => node[k] !== undefined && node[k] !== null;
  if (node.op === "is_empty" || node.op === "is_not_empty") {
    if (has("value") || has("values") || has("field2") || node.or_missing) fail(`"${node.op}" takes no value.`);
    if (def.type === "enum" && !def.nullable) fail(`Every copy has a ${def.label}, so "${node.op}" cannot be used with it.`);
    if (def.type === "boolean") fail(`"${node.op}" cannot be used with ${def.label}.`);
    return out;
  }
  if (has("field2")) {
    if (has("value") || has("values")) fail("A condition compares with either a value or another field, not both.");
    const def2 = Object.hasOwn(FIELDS, node.field2) ? FIELDS[node.field2] : null;
    if (!def2) fail(`The search does not know the field "${fieldName(node.field2)}".`);
    if (node.field2 === node.field) fail("A field cannot be compared with itself.");
    const ops = FIELD_COMPARE_OPS[def.type];
    if (!ops || def2.type !== def.type) fail(`The ${def.label} and the ${def2.label} are not the same kind of value, so they cannot be compared.`);
    if (!ops.includes(node.op)) fail(`"${node.op}" cannot compare the ${def.label} with another field.`);
    out.field2 = node.field2;
  } else if (node.op === "in" || node.op === "not_in" || node.op === "between") {
    if (has("value")) fail(`"${node.op}" takes a list of values.`);
    if (!Array.isArray(node.values) || !node.values.length) fail(`"${node.op}" needs a list of values.`);
    if (node.values.length > MAX_VALUES) fail(`A list has too many values (at most ${MAX_VALUES}).`);
    if (node.op === "between" && node.values.length !== 2) fail('"between" needs exactly two values, the low one and the high one.');
    const values = node.values.map((v) => checkValue(node.field, def, v));
    if (node.op === "between" && values[0] > values[1]) fail(`In "between", the first ${def.label} is higher than the second, so nothing can match.`);
    out.values = node.op === "between" ? values : [...new Set(values)];
  } else {
    if (has("values")) fail(`"${node.op}" takes one value, not a list.`);
    if (!has("value")) fail(`The condition on the ${def.label} has no value.`);
    out.value = checkValue(node.field, def, node.value);
  }
  if (node.or_missing === true) out.or_missing = true;
  return out;
}

function checkNode(node, depth, counter) {
  if (!isObj(node)) fail("A condition is not in the expected form.");
  const group = Object.hasOwn(node, "and") ? "and" : Object.hasOwn(node, "or") ? "or" : null;
  if (!group) return checkLeaf(node, counter);
  onlyKeys(node, [group], "A group of conditions");
  if (depth >= MAX_DEPTH) fail(`That search nests groups too deeply (at most ${MAX_DEPTH} levels).`);
  const kids = node[group];
  if (!Array.isArray(kids) || !kids.length) fail("A group of conditions is empty.");
  if (kids.length > MAX_CHILDREN) fail(`A group has too many conditions (at most ${MAX_CHILDREN}).`);
  const checked = kids.map((k) => checkNode(k, depth + 1, counter));
  return checked.length === 1 ? checked[0] : { [group]: checked };
}

// raw (object, or the JSON text from the URL) -> { ok: true, spec } (canonical: only known keys) | { ok: false, error }.
function validateSpec(raw) {
  try {
    let spec = raw;
    if (typeof raw === "string") {
      if (raw.length > MAX_SPEC_CHARS) fail("That search is too long.");
      try { spec = JSON.parse(raw); } catch { fail("That search link is damaged."); }
    } else if (JSON.stringify(raw === undefined ? null : raw).length > MAX_SPEC_CHARS) fail("That search is too long.");
    if (!isObj(spec)) fail("That search is not in the expected form.");
    onlyKeys(spec, ["v", "copies", "where", "sort"], "The search");
    if (spec.v !== undefined && spec.v !== VERSION) fail("That search link is from another version of the site.");
    const out = { v: VERSION, copies: "in_stock" };
    if (spec.copies !== undefined && spec.copies !== null) {
      if (!COPIES.includes(spec.copies)) fail(`"${fieldName(spec.copies)}" is not a choice of copies (in_stock, sold or all).`);
      out.copies = spec.copies;
    }
    if (spec.where !== undefined && spec.where !== null) out.where = checkNode(spec.where, 0, { leaves: 0 });
    if (spec.sort !== undefined && spec.sort !== null) {
      if (!isObj(spec.sort)) fail("The sort order is not in the expected form.");
      onlyKeys(spec.sort, ["field", "dir"], "The sort order");
      if (!SORTABLE.includes(spec.sort.field)) fail(`The list cannot be sorted by "${fieldName(spec.sort.field)}".`);
      const dir = spec.sort.dir === undefined ? "asc" : spec.sort.dir;
      if (dir !== "asc" && dir !== "desc") fail('The sort direction must be "asc" or "desc".');
      out.sort = { field: spec.sort.field, dir };
    }
    return { ok: true, spec: out };
  } catch (err) {
    if (err instanceof SpecError) return { ok: false, error: err.message };
    throw err;
  }
}

// ---------- SQL ----------

// The leaves of a validated tree.
function leaves(node) {
  if (!node) return [];
  if (node.and) return node.and.flatMap(leaves);
  if (node.or) return node.or.flatMap(leaves);
  return [node];
}
const usedFields = (spec) => new Set(leaves(spec.where).flatMap((l) => (l.field2 ? [l.field, l.field2] : [l.field])));
const hasCopyField = (spec) => [...usedFields(spec)].some((f) => FIELDS[f].level === "copy");
// Must a book have a copy in scope? Yes, except for a book-level search over "all" copies.
const needsCopy = (spec) => spec.copies !== "all" || hasCopyField(spec);

function colSql(name, a) {
  const def = FIELDS[name];
  const col = `${def.level === "book" ? a.b : a.c}.${def.col}`;
  return def.timestamp ? `(${col} AT TIME ZONE '${SITE_TIME_ZONE}')::date` : col;
}
function blankSql(name, a) {
  const def = FIELDS[name];
  const col = colSql(name, a);
  if (def.type === "text") return `(${col} IS NULL OR btrim(${col}) = '')`;
  if (def.type === "genre") return `NOT EXISTS (SELECT 1 FROM unnest(string_to_array(${col}, ',')) AS g WHERE btrim(g) <> '')`;
  return `${col} IS NULL`;
}
const SQL_OP = { "=": "=", "!=": "<>", "<": "<", "<=": "<=", ">": ">", ">=": ">=" };
const cast = (def) => (def.type === "date" ? "::date" : def.type === "money" ? "::numeric" : def.type === "integer" ? "::int" : "");

function leafSql(l, params, a) {
  const def = FIELDS[l.field];
  const col = colSql(l.field, a);
  const p = (v) => { params.push(v); return `$${params.length}${cast(def)}`; };
  const textish = def.type === "text";
  let sql;
  if (l.op === "is_empty") return blankSql(l.field, a);
  if (l.op === "is_not_empty") return `NOT ${blankSql(l.field, a)}`;
  if (l.field2) {
    const col2 = colSql(l.field2, a);
    sql = textish ? `lower(${col}) ${SQL_OP[l.op]} lower(${col2})` : `${col} ${SQL_OP[l.op]} ${col2}`;
    // Both must be set: plain SQL comparisons are never true for NULL, and a blank text counts as not set too.
    sql = textish ? `(${sql} AND NOT ${blankSql(l.field, a)} AND NOT ${blankSql(l.field2, a)})` : `(${sql})`;
    return l.or_missing ? `(${sql} OR ${blankSql(l.field, a)} OR ${blankSql(l.field2, a)})` : sql;
  }
  if (def.type === "genre") {
    const entry = (cond) => `EXISTS (SELECT 1 FROM unnest(string_to_array(${col}, ',')) AS g WHERE ${cond})`;
    const one = (v) => `lower(btrim(g)) = lower(${p(v)})`;
    const like = (v) => `btrim(g) ILIKE ${p(likeContains(v))}`;
    if (l.op === "=") sql = entry(one(l.value));
    else if (l.op === "in") sql = entry(`(${l.values.map(one).join(" OR ")})`);
    else if (l.op === "contains") sql = entry(like(l.value));
    else {
      const pos = l.op === "!=" ? entry(one(l.value)) : l.op === "not_in" ? entry(`(${l.values.map(one).join(" OR ")})`) : entry(like(l.value));
      sql = `(NOT ${blankSql(l.field, a)} AND NOT ${pos})`; // "not Fantasy" means: has genres, none of them Fantasy
    }
  } else if (textish) {
    const lc = `lower(${col})`;
    if (l.op === "=") sql = `${lc} = lower(${p(l.value)})`;
    else if (l.op === "!=") sql = `${lc} <> lower(${p(l.value)})`;
    else if (l.op === "contains") sql = `${col} ILIKE ${p(likeContains(l.value))}`;
    else if (l.op === "not_contains") sql = `${col} NOT ILIKE ${p(likeContains(l.value))}`;
    else {
      params.push(l.values.map((v) => v.toLowerCase()));
      sql = l.op === "in" ? `${lc} = ANY($${params.length}::text[])` : `${lc} <> ALL($${params.length}::text[])`;
    }
  } else if (l.op === "between") {
    sql = `${col} BETWEEN ${p(l.values[0])} AND ${p(l.values[1])}`;
  } else if (l.op === "in" || l.op === "not_in") {
    params.push(l.values);
    const arr = `$${params.length}::${def.type === "money" ? "numeric" : def.type === "integer" ? "int" : "text"}[]`;
    sql = l.op === "in" ? `${col} = ANY(${arr})` : `${col} <> ALL(${arr})`;
  } else {
    sql = `${col} ${SQL_OP[l.op]} ${p(l.value)}`;
  }
  // NULL never satisfies a comparison (so "not Hardback" leaves out books with no binding); a blank text neither.
  if (textish && NEGATIVE.has(l.op)) sql = `(${sql} AND NOT ${blankSql(l.field, a)})`;
  return l.or_missing ? `(${sql} OR ${blankSql(l.field, a)})` : `(${sql})`;
}

function nodeSql(node, params, a) {
  if (node.and) return `(${node.and.map((n) => nodeSql(n, params, a)).join(" AND ")})`;
  if (node.or) return `(${node.or.map((n) => nodeSql(n, params, a)).join(" OR ")})`;
  return leafSql(node, params, a);
}

function scopeSql(spec, c) {
  if (spec.copies === "in_stock") return `${c}.status = 'in_stock'`;
  if (spec.copies === "sold") return `${c}.status = 'sold'`;
  return "TRUE";
}

// SQL true for a copy (alias c) of book (alias b) that counts for this spec: in scope AND the whole condition.
function copyMatchSql(spec, params, b, c) {
  const parts = spec.copies === "all" && spec.where ? [] : [scopeSql(spec, c)];
  if (spec.where) parts.push(nodeSql(spec.where, params, { b, c }));
  return parts.join(" AND ");
}

// { conditions, params } over book alias b: the list and the CSV downloads take their WHERE from here.
// copyAlias must not be used by the outer query (the list and the per-book CSV LEFT JOIN copies as c).
function buildSpecWhere(spec, copyAlias = "nq") {
  const params = [];
  if (!needsCopy(spec)) return { conditions: spec.where ? [nodeSql(spec.where, params, { b: "b", c: null })] : [], params };
  return { conditions: [`EXISTS (SELECT 1 FROM book_copies ${copyAlias} WHERE ${copyAlias}.book_id = b.id AND ${copyMatchSql(spec, params, "b", copyAlias)})`], params };
}

// For the per-copy CSV and the "matching copies" rows: which copies (alias `alias`, book alias b) matched.
// "" when every copy of a matching book counts (a book-level search over all copies).
function specCopyCondition(spec, params, alias, bookAlias = "b") {
  return needsCopy(spec) ? copyMatchSql(spec, params, bookAlias, alias) : "";
}

// ORDER BY for the list (books b): a book field directly; a copy field by the lowest (asc) or highest (desc) value
// among the copies that matched. Blanks last. Pushes its values into `params`.
function specOrderBy(spec, params) {
  const tail = "b.title_sort, b.title, b.id";
  if (!spec.sort) return tail;
  const { field, dir } = spec.sort;
  const def = FIELDS[field];
  const d = dir === "desc" ? "DESC" : "ASC";
  if (field === "title") return `b.title_sort ${d}, b.title ${d}, b.id`;
  if (def.level === "book") return `${colSql(field, { b: "b" })} ${d} NULLS LAST, ${tail}`;
  const cond = specCopyCondition(spec, params, "so");
  const agg = dir === "desc" ? "MAX" : "MIN";
  return `(SELECT ${agg}(${colSql(field, { b: "b", c: "so" })}) FROM book_copies so WHERE so.book_id = b.id${cond ? ` AND ${cond}` : ""}) ${d} NULLS LAST, ${tail}`;
}

// The copies that made each book match, with what the view shows of them (lib/inventorySearch matchingCopies, wider).
async function specMatchingCopies(pool, spec, bookIds) {
  if (!bookIds.length || (!hasCopyField(spec) && spec.copies === "in_stock")) return new Map();
  const params = [bookIds];
  const cond = specCopyCondition(spec, params, "c");
  const { rows } = await pool.query(
    `SELECT c.id, c.book_id, c.location, c.condition, c.status, c.price, c.publisher_price, c.acquisition_cost, c.suggested_price,
            c.source, c.is_clearance, to_char(c.acquired_at, 'YYYY-MM-DD') AS acquired_at,
            to_char(c.created_at AT TIME ZONE '${SITE_TIME_ZONE}', 'YYYY-MM-DD') AS added_at,
            to_char(c.sold_at AT TIME ZONE '${SITE_TIME_ZONE}', 'YYYY-MM-DD') AS sold_at
     FROM book_copies c JOIN books b ON b.id = c.book_id
     WHERE c.book_id = ANY($1::int[])${cond ? ` AND ${cond}` : ""} ORDER BY c.book_id, c.id LIMIT 2000`,
    params
  );
  const shown = usedFields(spec);
  if (spec.sort) shown.add(spec.sort.field);
  const byBook = new Map();
  for (const r of rows) {
    if (!byBook.has(r.book_id)) byBook.set(r.book_id, []);
    byBook.get(r.book_id).push({
      id: r.id, location: r.location, condition: r.condition, price: r.price == null ? null : Number(r.price),
      extra: copyExtras(r, shown, spec),
    });
  }
  return byBook;
}

const euro = (v) => (v == null ? null : `€${Number(v).toFixed(2)}`);
const labelOf = (field, v) => (FIELDS[field].values.find((x) => x.value === v) || { label: v }).label;
// The details beyond location / condition / price that the condition (or the sort) is about, so Sharon can check them.
function copyExtras(r, shown, spec) {
  const out = [];
  const money = { publisher_price: "publisher's price", acquisition_cost: "cost", suggested_price: "suggested" };
  for (const [f, label] of Object.entries(money)) if (shown.has(f)) out.push(r[f] == null ? `no ${label}` : `${label} ${euro(r[f])}`);
  if (shown.has("acquired_at")) out.push(r.acquired_at ? `received ${r.acquired_at}` : "no date received");
  if (shown.has("added_at")) out.push(`added ${r.added_at}`);
  if (shown.has("sold_at") || spec.copies === "sold") out.push(r.sold_at ? `sold ${r.sold_at}` : "no sale date");
  if (shown.has("status") || spec.copies === "all") out.push(labelOf("status", r.status));
  if (shown.has("source")) out.push(r.source ? `source: ${labelOf("source", r.source)}` : "source unknown");
  if (shown.has("clearance")) out.push(r.is_clearance ? "on clearance" : "not on clearance");
  return out;
}

// ---------- "Understood as: ..." ----------

const q = (s) => `"${s}"`;
function fmt(def, v) {
  if (def.type === "money") return euro(v);
  if (def.type === "enum") return (def.values.find((x) => x.value === v) || { label: v }).label;
  if (def.type === "text" || def.type === "genre") return q(v);
  return String(v);
}
const list = (def, vs) => vs.map((v) => fmt(def, v)).join(", ");
const WORDS = {
  money: { "<": "is under", "<=": "is at most", ">": "is over", ">=": "is at least", "=": "is exactly", "!=": "is not" },
  integer: { "<": "is before", "<=": "is in or before", ">": "is after", ">=": "is in or after", "=": "is", "!=": "is not" },
  date: { "<": "is before", "<=": "is on or before", ">": "is after", ">=": "is on or after", "=": "is", "!=": "is not" },
};
const VS_WORDS = { "=": "is the same as", "!=": "is different from", "<": "is lower than", "<=": "is at most", ">": "is higher than", ">=": "is at least" };
const VS_DATE = { "=": "is the same day as", "!=": "is a different day from", "<": "is before", "<=": "is on or before", ">": "is after", ">=": "is on or after" };
const thing = (def) => (def.level === "book" ? "books" : "copies");

function explainLeaf(l) {
  const def = FIELDS[l.field];
  const L = def.label;
  if (l.field2) {
    const def2 = FIELDS[l.field2];
    const words = (def.type === "date" ? VS_DATE : VS_WORDS)[l.op];
    return `${L} ${words} ${def2.label} ${l.or_missing ? "(or either one is not set)" : "(both must be set)"}`;
  }
  const missing = l.or_missing ? `, or no ${L} set` : "";
  const leftOut = !l.or_missing && NEGATIVE.has(l.op) && !def.notNull ? ` (${thing(def)} with no ${L} set are left out)` : "";
  if (l.op === "is_empty") return def.type === "genre" ? "no genre set" : `no ${L} set`;
  if (l.op === "is_not_empty") return def.type === "genre" ? "has a genre set" : `${L} is set`;
  if (def.type === "boolean") return l.value ? `is ${L}` : `is not ${L}`;
  if (def.type === "genre") {
    const w = { "=": `has the genre ${fmt(def, l.value)}`, "!=": `does not have the genre ${fmt(def, l.value)}`,
      contains: `has a genre containing ${fmt(def, l.value)}`, not_contains: `has no genre containing ${fmt(def, l.value)}`,
      in: `has one of the genres ${list(def, l.values || [])}`, not_in: `has none of the genres ${list(def, l.values || [])}` }[l.op];
    return w + missing + leftOut;
  }
  let w;
  if (l.op === "between") w = `${L} is between ${fmt(def, l.values[0])} and ${fmt(def, l.values[1])} (both included)`;
  else if (l.op === "in") w = `${L} is one of ${list(def, l.values)}`;
  else if (l.op === "not_in") w = `${L} is none of ${list(def, l.values)}`;
  else if (l.op === "contains") w = `${L} contains ${fmt(def, l.value)}`;
  else if (l.op === "not_contains") w = `${L} does not contain ${fmt(def, l.value)}`;
  else if (WORDS[def.type]) w = `${L} ${WORDS[def.type][l.op]} ${fmt(def, l.value)}`;
  else w = `${L} ${l.op === "=" ? "is" : "is not"} ${fmt(def, l.value)}`;
  const ci = def.type === "text" && (l.op === "=" || l.op === "!=" || l.op === "in" || l.op === "not_in") ? " (any capitals)" : "";
  return w + ci + missing + leftOut;
}

function explainNode(node, top) {
  if (node.and || node.or) {
    const word = node.and ? " AND " : " OR ";
    const s = (node.and || node.or).map((n) => explainNode(n, false)).join(word);
    return top ? s : `(${s})`;
  }
  return explainLeaf(node);
}

const SORT_WORDS = {
  title: ["title, A to Z", "title, Z to A"], author: ["author, A to Z", "author, Z to A"],
  published_year: ["year published, oldest first", "year published, newest first"],
};
function explainSort(spec) {
  if (!spec.sort) return "Sorted by title.";
  const { field, dir } = spec.sort;
  if (SORT_WORDS[field]) return `Sorted by ${SORT_WORDS[field][dir === "desc" ? 1 : 0]}.`;
  const def = FIELDS[field];
  const ends = def.type === "date" ? ["earliest first", "latest first"] : ["lowest first", "highest first"];
  return `Sorted by ${def.label} of the matching copies, ${ends[dir === "desc" ? 1 : 0]}.`;
}

// The validated spec in plain English, e.g. "Books with one copy in the store where: customer price is different
// from publisher's price (both must be set). Sorted by title."
function explainSpec(spec) {
  const scope = { in_stock: "in the store", sold: "that was sold", all: "of any status (in the store, reserved, sold, donated or withdrawn)" }[spec.copies];
  let head;
  if (!spec.where) head = spec.copies === "all" ? "All books." : `Books with at least one copy ${scope}.`;
  else if (!hasCopyField(spec)) {
    head = spec.copies === "all" ? `Books (with or without copies) where: ${explainNode(spec.where, true)}.`
      : `Books with at least one copy ${scope}, where: ${explainNode(spec.where, true)}.`;
  } else head = `Books with one copy ${scope} where: ${explainNode(spec.where, true)}.`;
  const one = hasCopyField(spec) && leaves(spec.where).length > 1 ? " All the copy details must be true of the same copy." : "";
  return `${head}${one} ${explainSort(spec)}`;
}

// The URL query value for a validated spec (?nl=...): canonical JSON, only what validateSpec kept.
const specParam = (spec) => JSON.stringify(spec);

module.exports = {
  VERSION, FIELDS, OPS_BY_TYPE, FIELD_COMPARE_OPS, COPIES, SORTABLE, MAX_DEPTH, MAX_LEAVES, MAX_CHILDREN, MAX_VALUES, MAX_TEXT, MAX_SPEC_CHARS,
  validateSpec, buildSpecWhere, specCopyCondition, specOrderBy, specMatchingCopies, explainSpec, specParam, hasCopyField, leaves,
};
