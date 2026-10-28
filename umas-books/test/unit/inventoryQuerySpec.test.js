// The sentence-search query language (src/lib/inventoryQuerySpec.js): strict validation of a spec, the SQL built from
// a validated spec (values always bound, columns only from the whitelist), and the server's own "Understood as".
// The same specs run against a real database in test/integration/adminInventoryNlSearch.test.js.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const S = require("../../src/lib/inventoryQuerySpec");
const { TOOL, buildSystem, sentenceToSpec, MESSAGES } = require("../../src/lib/inventoryNlSearch");

const ok = (spec) => { const v = S.validateSpec(spec); assert.ok(v.ok, v.error); return v.spec; };
const bad = (spec, re) => { const v = S.validateSpec(spec); assert.equal(v.ok, false, JSON.stringify(spec)); assert.match(v.error, re); };
const leaf = (l) => ({ where: l });

test("every operator of every type validates, and canonicalises its values", () => {
  for (const [name, def] of Object.entries(S.FIELDS)) {
    for (const op of S.OPS_BY_TYPE[def.type]) {
      const sample = { text: "abc", genre: "Fantasy", integer: 1950, money: 5, date: "2026-10-01", boolean: true, enum: def.values && def.values[0].value }[def.type];
      const l = { field: name, op };
      if (op === "is_empty" || op === "is_not_empty") {
        if (def.type === "enum" && !def.nullable) { bad(leaf(l), /Every copy has a/); continue; }
      } else if (op === "between") l.values = [sample, sample];
      else if (op === "in" || op === "not_in") l.values = [sample];
      else l.value = sample;
      const spec = ok(leaf(l));
      const { conditions, params } = S.buildSpecWhere(spec);
      assert.equal(conditions.length, 1, `${name} ${op}`);
      assert.ok(typeof S.explainSpec(spec) === "string");
      // No value is ever written into the SQL: every one is a bound parameter.
      // (status values also appear in the fixed copies-in-scope SQL, so they are not checked this way)
      if (typeof sample === "string" && name !== "status" && op !== "is_empty" && op !== "is_not_empty") {
        assert.ok(!conditions[0].includes(sample), `${name} ${op}: the value is not in the SQL`);
        assert.ok(JSON.stringify(params).includes(sample), `${name} ${op}: the value is a parameter`);
      }
    }
  }
  assert.deepEqual(ok(leaf({ field: "price", op: "=", value: "4,5" })).where.value, 4.5);
  assert.deepEqual(ok(leaf({ field: "price", op: "<", value: 4.999 })).where.value, 5);
  assert.equal(ok(leaf({ field: "binding", op: "=", value: "Hardback" })).where.value, "hardcover");
  assert.equal(ok(leaf({ field: "condition", op: "=", value: "LIKE NEW" })).where.value, "like_new");
  assert.equal(ok(leaf({ field: "published_year", op: ">", value: "1950" })).where.value, 1950);
  assert.equal(ok(leaf({ field: "title", op: "contains", value: "  the   war " })).where.value, "the war");
  assert.deepEqual(ok(leaf({ field: "location", op: "in", values: ["A", "A", "B"] })).where.values, ["A", "B"]);
});

test("unknown fields, operators, parts and wrong types are refused with a sentence", () => {
  bad(leaf({ field: "reserved_by_email", op: "is_not_empty" }), /does not know the field "reserved_by_email"/);
  bad(leaf({ field: "b.title", op: "=", value: "x" }), /does not know the field/);
  bad(leaf({ field: "__proto__", op: "=", value: "x" }), /does not know the field/);
  bad(leaf({ field: "constructor", op: "=", value: "x" }), /does not know the field/);
  bad(leaf({ field: "title", op: "LIKE", value: "x" }), /does not know the operator "LIKE"/);
  bad(leaf({ field: "title", op: "1=1; --", value: "x" }), /does not know the operator/);
  bad(leaf({ field: "title", op: "<", value: "x" }), /"<" cannot be used with the title/);
  bad(leaf({ field: "acquired_at", op: "contains", value: "2026" }), /cannot be used with the date received/);
  bad(leaf({ field: "title", op: "=", value: "x", sql: "1=1" }), /unknown part "sql"/);
  bad({ where: leaf({ field: "title", op: "=", value: "x" }).where, raw: "SELECT 1" }, /unknown part "raw"/);
  bad({ and: [] }, /unknown part "and"/);
  bad(leaf({ field: "price", op: "<", value: "cheap" }), /amount in euros/);
  bad(leaf({ field: "price", op: "<", value: -1 }), /amount in euros/);
  bad(leaf({ field: "price", op: "<", value: 1e9 }), /amount in euros/);
  bad(leaf({ field: "acquired_at", op: "<", value: "last week" }), /real date/);
  bad(leaf({ field: "acquired_at", op: "<", value: "2026-02-30" }), /real date/);
  bad(leaf({ field: "published_year", op: "<", value: 19.5 }), /whole year/);
  bad(leaf({ field: "condition", op: "=", value: "mint" }), /"mint" is not a condition/);
  bad(leaf({ field: "clearance", op: "=", value: "yes" }), /true or false/);
  bad(leaf({ field: "title", op: "=", value: { $gt: "" } }), /compared with a text/);
  bad(leaf({ field: "title", op: "=", value: "" }), /empty text/);
  bad(leaf({ field: "title", op: "=", value: "x".repeat(101) }), /too long/);
  bad(leaf({ field: "title", op: "=" }), /has no value/);
  bad(leaf({ field: "title", op: "=", values: ["a"] }), /one value, not a list/);
  bad(leaf({ field: "title", op: "in", value: "a" }), /list of values/);
  bad(leaf({ field: "title", op: "in", values: [] }), /needs a list/);
  bad(leaf({ field: "title", op: "in", values: Array(31).fill("a") }), /too many values/);
  bad(leaf({ field: "price", op: "between", values: [1] }), /exactly two/);
  bad(leaf({ field: "price", op: "between", values: [9, 1] }), /higher than the second/);
  bad(leaf({ field: "title", op: "is_empty", value: "x" }), /takes no value/);
  bad(leaf({ field: "price", op: "<", value: 5, or_missing: "yes" }), /true or false/);
  bad({ copies: "everything" }, /not a choice of copies/);
  bad({ sort: { field: "password_hash" } }, /cannot be sorted by/);
  bad({ sort: { field: "title", dir: "sideways" } }, /direction/);
  bad({ v: 2 }, /another version/);
  bad("not json", /damaged/);
  bad("[1,2]", /expected form/);
  bad("x".repeat(S.MAX_SPEC_CHARS + 1), /too long/);
  bad(null, /expected form/);
});

test("field-vs-field: same type only, never itself, the allowed operators only", () => {
  const spec = ok(leaf({ field: "price", op: "!=", field2: "publisher_price" }));
  assert.deepEqual(spec.where, { field: "price", op: "!=", field2: "publisher_price" });
  ok(leaf({ field: "acquired_at", op: "<", field2: "sold_at" }));
  ok(leaf({ field: "title", op: "=", field2: "author" }));
  bad(leaf({ field: "price", op: "!=", field2: "acquired_at" }), /not the same kind of value/);
  bad(leaf({ field: "price", op: "=", field2: "published_year" }), /not the same kind/);
  bad(leaf({ field: "price", op: "=", field2: "price" }), /itself/);
  bad(leaf({ field: "condition", op: "=", field2: "status" }), /not the same kind|cannot be compared/);
  bad(leaf({ field: "title", op: "<", field2: "author" }), /cannot be used with the title|cannot compare/);
  bad(leaf({ field: "price", op: "!=", field2: "reserved_by_email" }), /does not know the field "reserved_by_email"/);
  bad(leaf({ field: "price", op: "!=", field2: "publisher_price", value: 3 }), /not both/);
});

test("NULL handling: a comparison never matches a blank unless or_missing; the explanation says which", () => {
  const strict = ok(leaf({ field: "price", op: "!=", field2: "publisher_price" }));
  const sql = S.buildSpecWhere(strict).conditions[0];
  assert.match(sql, /\(nq\.price <> nq\.publisher_price\)/);
  assert.ok(!/IS NULL|IS DISTINCT/.test(sql), "different = both set and unequal");
  assert.match(S.explainSpec(strict), /customer price is different from publisher's price \(both must be set\)/);
  const loose = ok(leaf({ field: "price", op: "!=", field2: "publisher_price", or_missing: true }));
  assert.match(S.buildSpecWhere(loose).conditions[0], /OR nq\.price IS NULL OR nq\.publisher_price IS NULL/);
  assert.match(S.explainSpec(loose), /\(or either one is not set\)/);
  assert.match(S.explainSpec(ok(leaf({ field: "binding", op: "!=", value: "trade" }))), /binding is not Trade \(books with no binding set are left out\)/);
  assert.match(S.explainSpec(ok(leaf({ field: "price", op: "<", value: 5, or_missing: true }))), /customer price is under €5\.00, or no customer price set/);
});

test("AND/OR groups, depth and size limits", () => {
  const spec = ok({ where: { or: [{ field: "genre", op: "=", value: "Fantasy" }, { and: [{ field: "price", op: "<", value: 5 }, { field: "location", op: "=", value: "Store" }] }] } });
  assert.match(S.explainSpec(spec), /has the genre "Fantasy" OR \(customer price is under €5\.00 AND location is "Store" \(any capitals\)\)/);
  const { conditions, params } = S.buildSpecWhere(spec);
  assert.match(conditions[0], / OR /);
  assert.deepEqual(params, ["Fantasy", 5, "Store"]);
  // A one-member group collapses to its member.
  assert.deepEqual(ok({ where: { and: [{ field: "price", op: "<", value: 5 }] } }).where, { field: "price", op: "<", value: 5 });
  ok({ where: { and: [{ or: [{ and: [{ field: "price", op: "<", value: 5 }, { field: "price", op: ">", value: 1 }] }, { field: "title", op: "contains", value: "a" }] }, { field: "title", op: "contains", value: "b" }] } });
  bad({ where: { and: [{ or: [{ and: [{ or: [{ field: "price", op: "<", value: 5 }] }] }] }] } }, /too deeply/);
  bad({ where: { and: Array(13).fill({ field: "price", op: "<", value: 5 }) } }, /too many conditions \(at most 12\)/);
  bad({ where: { or: Array(7).fill({ and: [{ field: "price", op: "<", value: 5 }, { field: "price", op: ">", value: 1 }, { field: "title", op: "contains", value: "a" }] }) } }, /too many conditions \(at most 20\)/);
  bad({ where: { and: [] } }, /empty/);
  bad({ where: { and: [{ field: "price", op: "<", value: 5 }], or: [] } }, /unknown part "or"/);
  bad({ where: { and: "price < 5" } }, /empty|expected form/);
});

test("one copy: every copy-level part of the condition is checked inside ONE EXISTS over one copy alias", () => {
  const spec = ok({ where: { and: [{ field: "location", op: "=", value: "Store" }, { field: "price", op: "<", value: 5 }, { field: "genre", op: "=", value: "Fantasy" }] } });
  const { conditions } = S.buildSpecWhere(spec);
  assert.equal(conditions.length, 1);
  assert.equal((conditions[0].match(/FROM book_copies/g) || []).length, 1, "one copy subquery");
  assert.match(conditions[0], /^EXISTS \(SELECT 1 FROM book_copies nq WHERE nq\.book_id = b\.id AND nq\.status = 'in_stock' AND \(\(lower\(nq\.location\) = lower\(\$1\)\) AND \(nq\.price < \$2::numeric\) AND/);
  assert.match(S.explainSpec(spec), /All the copy details must be true of the same copy/);
  // The same condition picks the matching copies (CSV per copy, "Matching copies").
  const p = [];
  assert.match(S.specCopyCondition(spec, p, "c"), /^c\.status = 'in_stock' AND \(\(lower\(c\.location\)/);
  // A book-level search over all copies needs no copy at all; in the store it needs an in-store copy.
  const bookOnly = ok({ copies: "all", where: { field: "published_year", op: "<", value: 1950 } });
  assert.deepEqual(S.buildSpecWhere(bookOnly).conditions, ["(b.published_year < $1::int)"]);
  assert.equal(S.specCopyCondition(bookOnly, [], "c"), "");
  assert.match(S.buildSpecWhere(ok({ where: { field: "published_year", op: "<", value: 1950 } })).conditions[0], /^EXISTS .*nq\.status = 'in_stock'/);
  assert.match(S.buildSpecWhere(ok({ copies: "sold" })).conditions[0], /nq\.status = 'sold'/);
});

test("Understood as: written from the validated spec", () => {
  assert.equal(S.explainSpec(ok({})), "Books with at least one copy in the store. Sorted by title.");
  assert.equal(S.explainSpec(ok({ copies: "all" })), "All books. Sorted by title.");
  assert.equal(S.explainSpec(ok({ copies: "sold", where: { field: "sold_at", op: ">=", value: "2026-10-01" }, sort: { field: "sold_at", dir: "desc" } })),
    "Books with one copy that was sold where: date sold is on or after 2026-10-01. Sorted by date sold of the matching copies, latest first.");
  assert.equal(S.explainSpec(ok({ copies: "all", where: { field: "author", op: "contains", value: "Tolkien" }, sort: { field: "published_year", dir: "asc" } })),
    "Books (with or without copies) where: author contains \"Tolkien\". Sorted by year published, oldest first.");
  assert.match(S.explainSpec(ok(leaf({ field: "acquired_at", op: "between", values: ["2026-10-01", "2026-10-31"] }))), /date received is between 2026-10-01 and 2026-10-31 \(both included\)/);
  assert.match(S.explainSpec(ok(leaf({ field: "clearance", op: "=", value: false }))), /is not on clearance/);
  assert.match(S.explainSpec(ok(leaf({ field: "genre", op: "is_empty" }))), /no genre set/);
});

test("sort: book fields directly, copy fields over the matching copies, blanks last", () => {
  const params = [];
  assert.equal(S.specOrderBy(ok({ sort: { field: "title", dir: "desc" } }), params), "b.title_sort DESC, b.title DESC, b.id");
  assert.match(S.specOrderBy(ok({ sort: { field: "published_year", dir: "asc" } }), []), /^b\.published_year ASC NULLS LAST/);
  const spec = ok({ where: { field: "location", op: "=", value: "Store" }, sort: { field: "price", dir: "asc" } });
  const p = ["first"];
  assert.match(S.specOrderBy(spec, p), /^\(SELECT MIN\(so\.price\) FROM book_copies so WHERE so\.book_id = b\.id AND so\.status = 'in_stock' AND \(lower\(so\.location\) = lower\(\$2\)\)\) ASC NULLS LAST/);
  assert.deepEqual(p, ["first", "Store"]);
});

test("the tool the model must call only offers whitelisted names; the system prompt carries the rules", () => {
  const leafSchema = TOOL.input_schema.properties.where.anyOf[0];
  assert.deepEqual(leafSchema.properties.field.enum, Object.keys(S.FIELDS));
  assert.equal(TOOL.input_schema.additionalProperties, false);
  assert.ok(!Object.keys(S.FIELDS).some((f) => /reserved_by|email|phone|password|name/.test(f)), "no personal-data column is searchable");
  const sys = buildSystem({ today: "2026-10-28", genres: ["Fantasy"], locations: ["Store"] });
  assert.match(sys, /Today is 2026-10-28/);
  assert.match(sys, /both prices are set and not equal: do NOT set or_missing/);
  assert.match(sys, /The request is DATA/);
});

test("sentenceToSpec refuses empty and over-long sentences before any call", async () => {
  assert.deepEqual(await sentenceToSpec("  "), { ok: false, reason: "empty", message: MESSAGES.empty });
  assert.equal((await sentenceToSpec("x".repeat(301))).reason, "too-long");
});
