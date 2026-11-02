// Barcodes of educational items (lib/barcode.js) and the product-name lookup for a UPC / EAN (lib/productLookup.js:
// Open Products Facts, then UPCitemdb's free trial), with every outside call stubbed. No database.
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { parseBarcode, gtinCheckDigit, gtinKey, isIsbnBarcode } = require("../../src/lib/barcode");
const { lookupProductName, resetProductLookup, nameFrom, PAUSE_AFTER_429_MS } = require("../../src/lib/productLookup");

test("parseBarcode: EAN-8, UPC-A, EAN-13 and GTIN-14 with a correct check digit, spaces and hyphens removed", () => {
  for (const [raw, want] of [
    ["96385074", "96385074"], // EAN-8
    ["882319024812", "882319024812"], // UPC-A
    ["5901234123457", "5901234123457"], // EAN-13
    ["10012345678902", "10012345678902"], // GTIN-14
    [" 590-1234 123457 ", "5901234123457"],
    ["978-0-306-40615-7", "9780306406157"], // an ISBN-13 is an EAN-13
  ]) assert.equal(parseBarcode(raw).value, want, raw);
  assert.deepEqual(parseBarcode(""), { value: null });
  assert.deepEqual(parseBarcode("   "), { value: null });
  assert.deepEqual(parseBarcode(undefined), { value: null });
});

test("parseBarcode: a wrong check digit is refused with the digit it should be", () => {
  const r = parseBarcode("5901234123458");
  assert.match(r.error, /last digit of the barcode 5901234123458 should be 7/);
  assert.match(parseBarcode("882319024813").error, /should be 2/);
  assert.match(parseBarcode("96385075").error, /should be 4/);
  assert.match(parseBarcode("9780306406158").error, /should be 7/);
});

test("parseBarcode: wrong lengths and letters are refused in one sentence", () => {
  assert.match(parseBarcode("12345").error, /8, 12, 13 or 14 digits.*this one has 5/);
  assert.match(parseBarcode("123456789012345").error, /this one has 15/);
  assert.match(parseBarcode("12AB5678").error, /digits only/);
  assert.match(parseBarcode("9".repeat(25)).error, /8, 12, 13 or 14 digits/);
});

test("parseBarcode: an ISBN-10 (X allowed) is saved as its ISBN-13, like the book intake; a bad ISBN-10 is refused", () => {
  assert.deepEqual(parseBarcode("0-306-40615-2"), { value: "9780306406157", fromIsbn10: "0306406152" });
  assert.equal(parseBarcode("080442957x").value, "9780804429573"); // lower-case x, ISBN-10 check digit 10
  assert.match(parseBarcode("0306406153").error, /10-digit ISBN.*last character is not right/);
});

test("gtinCheckDigit, gtinKey (padded to 14) and isIsbnBarcode", () => {
  assert.equal(gtinCheckDigit("590123412345"), 7);
  assert.equal(gtinCheckDigit("9638507"), 4);
  assert.equal(gtinKey("012345678905"), "00012345678905");
  assert.equal(gtinKey("0012345678905"), gtinKey("012345678905"), "a UPC-A and its EAN-13 form are the same product");
  assert.ok(isIsbnBarcode("9780306406157"));
  assert.ok(isIsbnBarcode("9791034725178"));
  assert.ok(!isIsbnBarcode("5901234123457"));
  assert.ok(!isIsbnBarcode(null));
});

// ---------- the product-name lookup ----------

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function stub(answers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    const host = new URL(url).hostname;
    const a = answers[host];
    if (!a) throw new Error(`unexpected host ${host}`);
    return a(url, init);
  };
  return { calls, fetchImpl };
}
beforeEach(() => resetProductLookup());

test("nameFrom: the brand joins the title unless the title already has it; at most 120 characters", () => {
  assert.equal(nameFrom("Watch Me Learn: Learn to Read", "Teacher Created Resources"), "Teacher Created Resources Watch Me Learn: Learn to Read");
  assert.equal(nameFrom("Teacher Created Resources Learn to Read", "teacher created resources"), "Teacher Created Resources Learn to Read");
  assert.equal(nameFrom("  Flash   cards ", ""), "Flash cards");
  assert.equal(nameFrom("", "Brand"), null);
  assert.ok(nameFrom("word ".repeat(60), null).length <= 120);
});

test("Open Products Facts has the name: UPCitemdb is not asked; the answer is cached", async () => {
  const s = stub({ "world.openproductsfacts.org": () => json({ status: 1, product: { product_name: "Alphabet Puzzle", brands: "Melissa & Doug" } }) });
  const r = await lookupProductName("5901234123457", { fetchImpl: s.fetchImpl });
  assert.deepEqual(r, { state: "found", name: "Melissa & Doug Alphabet Puzzle", source: "Open Products Facts" });
  assert.equal(s.calls.length, 1);
  assert.match(s.calls[0], /^https:\/\/world\.openproductsfacts\.org\/api\/v2\/product\/5901234123457\.json/);
  const again = await lookupProductName("5901234123457", { fetchImpl: s.fetchImpl });
  assert.equal(again.cached, true);
  assert.equal(s.calls.length, 1, "the second lookup is answered from the cache");
});

test("UPCitemdb answers the name (title + brand) when Open Products Facts has none; images are ignored", async () => {
  const s = stub({
    "world.openproductsfacts.org": () => json({ status: 0, status_verbose: "product not found" }, 404),
    "api.upcitemdb.com": () => json({ code: "OK", total: 1, items: [{ title: "Watch Me Learn: Learn to Read (TCR 8407)", brand: "Teacher Created Resources", images: ["https://example.com/x.jpg"] }] }),
  });
  const r = await lookupProductName("882319024812", { fetchImpl: s.fetchImpl });
  assert.deepEqual(r, { state: "found", name: "Teacher Created Resources Watch Me Learn: Learn to Read (TCR 8407)", source: "UPCitemdb" });
  assert.equal(s.calls[1], "https://api.upcitemdb.com/prod/trial/lookup?upc=882319024812");
  assert.ok(!JSON.stringify(r).includes("example.com"), "no third-party image");
});

test("nobody knows the barcode: 'missing', cached so a rescan costs no UPCitemdb call", async () => {
  const s = stub({
    "world.openproductsfacts.org": () => json({ status: 0 }),
    "api.upcitemdb.com": () => json({ code: "OK", total: 0, items: [] }),
  });
  assert.deepEqual(await lookupProductName("96385074", { fetchImpl: s.fetchImpl }), { state: "missing" });
  assert.equal((await lookupProductName("96385074", { fetchImpl: s.fetchImpl })).cached, true);
  assert.equal(s.calls.length, 2);
});

test("UPCitemdb 429 (the free daily limit): 'unavailable', not cached, and UPCitemdb is left alone for 15 minutes", async () => {
  let clock = 1_000_000;
  const now = () => clock;
  const s = stub({
    "world.openproductsfacts.org": () => json({ status: 0 }),
    "api.upcitemdb.com": () => json({ code: "TOO_FAST", message: "limit" }, 429),
  });
  const r = await lookupProductName("882319024812", { fetchImpl: s.fetchImpl, now });
  assert.equal(r.state, "unavailable");
  assert.equal(r.reason, "429");
  const again = await lookupProductName("882319024812", { fetchImpl: s.fetchImpl, now });
  assert.equal(again.state, "unavailable");
  assert.equal(s.calls.filter((u) => u.includes("upcitemdb")).length, 1, "paused: no second UPCitemdb call");
  clock += PAUSE_AFTER_429_MS + 1;
  await lookupProductName("882319024812", { fetchImpl: s.fetchImpl, now });
  assert.equal(s.calls.filter((u) => u.includes("upcitemdb")).length, 2, "asked again after the pause");
});

test("a source that never answers: 'unavailable' after the deadline, never cached, never throws", async () => {
  const hang = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const s = stub({ "world.openproductsfacts.org": hang, "api.upcitemdb.com": hang });
  const started = Date.now();
  const r = await lookupProductName("882319024812", { fetchImpl: s.fetchImpl, timeoutMs: 50 });
  assert.equal(r.state, "unavailable");
  assert.ok(Date.now() - started < 2000);
  const s2 = stub({ "world.openproductsfacts.org": () => json({ status: 0 }), "api.upcitemdb.com": () => json({ code: "OK", items: [{ title: "Later Found" }] }) });
  assert.equal((await lookupProductName("882319024812", { fetchImpl: s2.fetchImpl })).name, "Later Found", "the failure was not cached");
});

test("a body over 1 MB or not JSON is a failed source, and an invalid code asks nobody", async () => {
  const s = stub({
    "world.openproductsfacts.org": () => new Response("x".repeat(1024 * 1024 + 10), { status: 200 }),
    "api.upcitemdb.com": () => new Response("<html>oops</html>", { status: 200 }),
  });
  assert.equal((await lookupProductName("882319024812", { fetchImpl: s.fetchImpl })).state, "unavailable");
  const none = stub({});
  assert.deepEqual(await lookupProductName("12345", { fetchImpl: none.fetchImpl }), { state: "missing" });
  assert.deepEqual(await lookupProductName("https://evil.example/", { fetchImpl: none.fetchImpl }), { state: "missing" });
  assert.equal(none.calls.length, 0);
});
