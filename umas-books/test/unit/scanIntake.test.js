// public/scan-intake.js, the plain functions (no browser): what counts as a
// complete ISBN, the 150 ms pause, the stale-answer guard, which fields a
// lookup may fill, the remembered binding and the status messages.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const S = require("../../public/scan-intake.js");

// A fake clock: timers run only when the test says so.
function fakeClock() {
  let now = 1000;
  const timers = new Map();
  let nextId = 1;
  return {
    now: () => now,
    setTimeoutFn: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeoutFn: (id) => { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
    },
    pending: () => timers.size,
  };
}

test("isbnDigits ignores hyphens and spaces; isCompleteIsbn wants 10 or 13 characters", () => {
  assert.equal(S.isbnDigits("978-0-14-312755-0"), "9780143127550");
  assert.equal(S.isbnDigits(" 0 14 31 2755 x "), "014312755X");
  assert.ok(S.isCompleteIsbn("9780143127550"));
  assert.ok(S.isCompleteIsbn("978-0-14-312755-0"));
  assert.ok(S.isCompleteIsbn("014312755X"));
  assert.ok(S.isCompleteIsbn("0143127551"));
  for (const bad of ["", "978", "97801431275", "978014312755", "97801431275500", "X143127551", "01431275X1", null, undefined, "abcdefghij"]) {
    assert.equal(S.isCompleteIsbn(bad), false, `not complete: ${bad}`);
  }
});

test("the watcher fires once, 150 ms after a complete value (a scanner that sends no Enter)", () => {
  const clock = fakeClock();
  const seen = [];
  const w = S.createScanWatcher({ onComplete: (i) => seen.push(i), ...clock });
  w.input("9780143127550");
  clock.advance(149);
  assert.deepEqual(seen, []);
  clock.advance(1);
  assert.deepEqual(seen, ["9780143127550"]);
});

test("the watcher does not fire at 10 digits of a 13-digit ISBN still being typed", () => {
  const clock = fakeClock();
  const seen = [];
  const w = S.createScanWatcher({ onComplete: (i) => seen.push(i), ...clock });
  let typed = "";
  for (const ch of "9780143127550") {
    typed += ch;
    w.input(typed);
    clock.advance(10); // keys arrive faster than the pause
  }
  assert.deepEqual(seen, [], "nothing fired while typing");
  clock.advance(150);
  assert.deepEqual(seen, ["9780143127550"], "one lookup, with all 13 digits");
});

test("a 10-digit ISBN followed by a pause is looked up (and a longer value later is a new scan)", () => {
  const clock = fakeClock();
  const seen = [];
  const w = S.createScanWatcher({ onComplete: (i) => seen.push(i), ...clock });
  w.input("0143127551");
  clock.advance(200);
  assert.deepEqual(seen, ["0143127551"]);
});

test("Enter looks up at once, cancels the pause timer, and is not repeated by it", () => {
  const clock = fakeClock();
  const seen = [];
  const w = S.createScanWatcher({ onComplete: (i) => seen.push(i), ...clock });
  w.input("978-0-14-312755-0");
  assert.equal(clock.pending(), 1);
  assert.equal(w.enter("978-0-14-312755-0"), true);
  assert.equal(clock.pending(), 0, "timer cancelled");
  clock.advance(500);
  assert.deepEqual(seen, ["9780143127550"], "exactly one lookup");
});

test("Enter just after the pause fired does not look the same ISBN up twice; later it does", () => {
  const clock = fakeClock();
  const seen = [];
  const w = S.createScanWatcher({ onComplete: (i) => seen.push(i), ...clock });
  w.input("9780143127550");
  clock.advance(150);
  assert.equal(w.enter("9780143127550"), true, "a complete ISBN");
  assert.equal(seen.length, 1);
  clock.advance(2000);
  w.enter("9780143127550");
  assert.equal(seen.length, 2, "an Enter a while later is a deliberate second lookup");
});

test("Enter on an incomplete value does nothing and says so", () => {
  const clock = fakeClock();
  const seen = [];
  const w = S.createScanWatcher({ onComplete: (i) => seen.push(i), ...clock });
  assert.equal(w.enter("97801"), false);
  assert.equal(w.enter(""), false);
  assert.deepEqual(seen, []);
});

test("an edit cancels the pending lookup of the previous value", () => {
  const clock = fakeClock();
  const seen = [];
  const w = S.createScanWatcher({ onComplete: (i) => seen.push(i), ...clock });
  w.input("9780143127550");
  clock.advance(100);
  w.input("97801431275509"); // one more digit: not complete any more
  clock.advance(500);
  assert.deepEqual(seen, []);
});

test("stale-answer guard: only the newest lookup is current", () => {
  const g = S.createRequestGuard();
  const first = g.begin();
  assert.ok(g.isCurrent(first));
  const second = g.begin();
  assert.equal(g.isCurrent(first), false, "the first answer arrives late and is ignored");
  assert.ok(g.isCurrent(second));
  g.cancel();
  assert.equal(g.isCurrent(second), false, "cancel makes every answer on its way stale");
});

test("planFill fills untouched fields, empties them for a book without that data, and never touches an edited field", () => {
  const book = { title: "New Title", author: "Ann", publisher: null, publishedYear: 2011, genre: "Fiction", description: "Blurb", coverUrl: "/img/a.jpg" };
  const plain = S.planFill(book, {});
  assert.equal(plain.title, "New Title");
  assert.equal(plain.publishedYear, "2011");
  assert.equal(plain.publisher, "", "no publisher: the old one is cleared");
  const kept = S.planFill(book, { title: true, author: true });
  assert.ok(!("title" in kept) && !("author" in kept), "edited fields are not in the plan");
  assert.equal(kept.genre, "Fiction");
  const notFound = S.planFill(null, { title: true });
  assert.ok(!("title" in notFound));
  assert.equal(notFound.author, "", "a book that was not found clears what the last scan filled in");
});

test("binding: an untouched select takes the catalog's binding; a touched one only shows it as a hint", () => {
  const avail = ["hardcover", "trade", "mass_market", "other"];
  const hint = { key: "hardcover", label: "Hardcover" };
  // untouched: the catalog's binding is selected for the person
  const applied = S.chooseBinding({ current: "trade", hint, available: avail, touched: false, baseline: "trade" });
  assert.equal(applied.value, "hardcover");
  assert.match(applied.helper, /^Open Library says: Hardcover/);
  assert.match(applied.helper, /selected for you/);
  // already on the same value: nothing to announce beyond the hint
  assert.equal(S.chooseBinding({ current: "hardcover", hint, available: avail, touched: false, baseline: "trade" }).helper, "Open Library says: Hardcover");
  // touched (a person chose, or the address carried one): never replaced
  const kept = S.chooseBinding({ current: "trade", hint, available: avail, touched: true, baseline: "trade" });
  assert.equal(kept.value, "trade");
  assert.equal(kept.helper, "Open Library says: Hardcover");
  assert.equal(S.chooseBinding({ current: "", hint, available: avail, touched: true }).value, "", "Not specified stays Not specified once chosen");
  // no answer, or one this page cannot show: back to the remembered (last used) binding
  assert.equal(S.chooseBinding({ current: "hardcover", hint: null, available: avail, touched: false, baseline: "trade" }).value, "trade");
  assert.equal(S.chooseBinding({ current: "trade", hint: { key: "boxed_set", label: "Boxed set" }, available: avail, touched: false, baseline: "trade" }).value, "trade");
  assert.equal(S.chooseBinding({ current: "trade", hint: null, available: avail, touched: false, baseline: "trade" }).helper, "");
  // "paperback" from the catalog is read as "trade" when this page has no "paperback"
  assert.equal(S.chooseBinding({ current: "other", hint: { key: "paperback", label: "Paperback" }, available: avail, touched: false, baseline: "other" }).value, "trade");
});

test("a remembered 'paperback' is read as 'trade' when the list has no paperback", () => {
  assert.equal(S.resolveBindingKey("paperback", ["hardcover", "trade", "mass_market", "other"]), "trade");
  assert.equal(S.resolveBindingKey("paperback", ["hardcover", "paperback", "mass_market"]), "paperback");
  assert.equal(S.resolveBindingKey("mass_market", ["hardcover", "trade", "mass_market", "other"]), "mass_market");
  assert.equal(S.resolveBindingKey("spiral", ["hardcover"]), "");
  assert.equal(S.resolveBindingKey("", ["hardcover"]), "");
});

test("lookupStatus: Found, Not found, Already in stock with the count", () => {
  assert.deepEqual(S.lookupStatus({ found: true, book: { title: "Dune" }, existing: null }), { kind: "found", text: "Found: Dune" });
  assert.deepEqual(S.lookupStatus({ found: false, book: null, existing: null }), { kind: "notfound", text: "Not found: fill in by hand" });
  const two = S.lookupStatus({ found: true, book: { title: "Dune" }, existing: { copies: 2, title: "Dune" } });
  assert.equal(two.kind, "stocked");
  assert.match(two.text, /^Already in stock: 2 copies/);
  assert.match(S.lookupStatus({ found: true, book: { title: "Dune" }, existing: { copies: 1, title: "Dune" } }).text, /^Already in stock: 1 copy\./);
  // In the catalog of the shop but none left: an ordinary find.
  assert.equal(S.lookupStatus({ found: true, book: { title: "Dune" }, existing: { copies: 0, title: "Dune" } }).kind, "found");
});

test("keyboardInset: how much of the bottom the on-screen keyboard covers", () => {
  assert.equal(S.keyboardInset(812, { height: 812, offsetTop: 0 }), 0);
  assert.equal(S.keyboardInset(812, { height: 500, offsetTop: 0 }), 312);
  assert.equal(S.keyboardInset(812, { height: 500, offsetTop: 40 }), 272);
  assert.equal(S.keyboardInset(812, null), 0);
  assert.equal(S.keyboardInset(500, { height: 600, offsetTop: 0 }), 0);
});

test("shouldRefocusIsbn: the cursor never leaves a field the person is using (the keyboard would close)", () => {
  const isbn = { tagName: "INPUT", type: "text" };
  const el = (tagName, extra) => Object.assign({ tagName }, extra);
  assert.equal(S.shouldRefocusIsbn(null, isbn), true, "nothing focused");
  assert.equal(S.shouldRefocusIsbn(isbn, isbn), true, "already the ISBN box");
  assert.equal(S.shouldRefocusIsbn(el("BODY"), isbn), true);
  assert.equal(S.shouldRefocusIsbn(el("BUTTON"), isbn), true, "a button (Save) may give the cursor back");
  assert.equal(S.shouldRefocusIsbn(el("INPUT", { type: "submit" }), isbn), true);
  assert.equal(S.shouldRefocusIsbn(el("INPUT", { type: "checkbox" }), isbn), true);
  for (const type of ["text", "search", "number", "email", "url", "tel"]) assert.equal(S.shouldRefocusIsbn(el("INPUT", { type }), isbn), false, `input ${type}`);
  assert.equal(S.shouldRefocusIsbn(el("TEXTAREA"), isbn), false, "description");
  assert.equal(S.shouldRefocusIsbn(el("SELECT"), isbn), false, "condition select");
  assert.equal(S.shouldRefocusIsbn(el("DIV", { isContentEditable: true }), isbn), false);
});

test("remembered choices: a binding remembered from the last book (or carried by the address) starts as chosen, so a lookup keeps it", () => {
  assert.equal(S.bindingStartsChosen({ fromServer: false, remembered: true }), true, "the last binding is kept when the page is reloaded");
  assert.equal(S.bindingStartsChosen({ fromServer: true, remembered: false }), true);
  assert.equal(S.bindingStartsChosen({ fromServer: false, remembered: false }), false, "nothing remembered: the catalog's binding may select itself");
  // end to end with the lookup: the Hobbit's catalog says Trade, the remembered binding is Hardcover
  const hint = { key: "trade", label: "Trade" };
  const kept = S.chooseBinding({ current: "hardcover", hint, available: ["hardcover", "trade"], touched: S.bindingStartsChosen({ remembered: true }), baseline: "hardcover" });
  assert.equal(kept.value, "hardcover");
  assert.equal(kept.helper, "Open Library says: Trade", "the catalog's answer is only shown");
});

test("remembered choices: after a save only binding, condition, location and source are kept", () => {
  const kept = S.choicesToKeep({ location: "Shelf A", condition: "good", binding: "hardcover", source: "purchase", isbn: "9780143127550", title: "T", author: "A", price: "5", copyNotes: "n", coverUrl: "/img/x.jpg" });
  assert.deepEqual(kept, { location: "Shelf A", condition: "good", binding: "hardcover", source: "purchase" });
});

// ---- a stalled request is given up, so Save is never blocked for ever

test("timeoutSignal aborts the request after the limit, and clear() cancels the timer", () => {
  const clock = fakeClock();
  const t = S.timeoutSignal(12000, clock.setTimeoutFn, clock.clearTimeoutFn);
  assert.equal(t.signal.aborted, false);
  const u = S.timeoutSignal(12000, clock.setTimeoutFn, clock.clearTimeoutFn);
  u.clear();
  clock.advance(12000);
  assert.equal(t.signal.aborted, true);
  assert.equal(u.signal.aborted, false, "a finished request is not aborted later");
  assert.equal(S.isTimeoutError(t.signal.reason) || S.isTimeoutError({ name: "AbortError" }), true);
  assert.equal(S.isTimeoutError(new TypeError("Failed to fetch")), false);
});

test("the lookup limit is longer than the server's own 4 s lookup limit, and the page uses the signal on both requests", () => {
  assert.ok(S.LOOKUP_TIMEOUT_MS >= 8000 && S.LOOKUP_TIMEOUT_MS <= 15000);
  assert.ok(S.SAVE_TIMEOUT_MS > S.LOOKUP_TIMEOUT_MS);
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../public/scan-intake.js"), "utf8");
  assert.match(src, /\/admin\/inventory\/lookup\?isbn=[^\n]*signal: limit\.signal/);
  assert.match(src, /form\.getAttribute\("action"\)[^\n]*signal: limit\.signal/);
});
