// public/till.js, the till page's own logic, run against a tiny fake DOM (no browser):
// the keypad ignores scanner bursts and Enter never confirms a payment, "20." is sent as 20,
// every confirm carries the total the screen showed, a refusal is shown BEFORE the customer pays,
// and a server error is never reported as "Connection problem".
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "..", "public", "till.js"), "utf8");

class El {
  constructor(id, tag = "DIV") {
    Object.assign(this, { id, tagName: tag, attrs: {}, children: [], listeners: {}, hidden: false, textContent: "", value: "", checked: false, disabled: false, className: "", style: {}, cache: {} });
    this.classList = { add() {}, remove() {} };
  }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  appendChild(c) { this.children.push(c); return c; }
  querySelector(sel) { return (this.cache[sel] = this.cache[sel] || new El(sel)); }
  querySelectorAll() { return []; }
  closest() { return null; }
  focus() {} blur() {} select() {} reset() {}
  fire(type, ev = {}) {
    const e = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...ev };
    for (const fn of this.listeners[type] || []) fn.call(this, e);
    return e;
  }
}

// responder(url, fields) -> { status, body (object | string), redirected } or throws (a network failure)
function boot({ lines, responder, stored = null }) {
  const els = {};
  const document = {
    activeElement: null, body: new El("body", "BODY"), listeners: {},
    getElementById(id) { return (els[id] = els[id] || new El(id, id === "scan" || id.endsWith("-input") ? "INPUT" : "DIV")); },
    createElement(tag) { return new El("", tag.toUpperCase()); },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
  };
  const root = document.getElementById("till");
  Object.assign(root.attrs, { "data-csrf": "csrf", "data-token": "sale-one", "data-admin": "1", "data-max-total": "1000000" });
  const calls = [];
  const storage = { data: {}, getItem(k) { return k in this.data ? this.data[k] : null; }, setItem(k, v) { this.data[k] = String(v); }, removeItem(k) { delete this.data[k]; } };
  storage.setItem("till-sale-v1", JSON.stringify(stored || { token: "sale-one", lines }));
  const keyListeners = () => document.listeners.keydown || [];
  const fetch = async (url, opts) => {
    const fields = Object.fromEntries(new URLSearchParams(opts.body));
    calls.push({ url, fields });
    const r = await responder(url, fields);
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return { status: r.status, redirected: !!r.redirected, text: async () => text };
  };
  const window = { sessionStorage: storage, localStorage: { getItem: () => null, setItem() {} }, confirm: () => true, location: { href: "" } };
  const context = vm.createContext({ window, document, fetch, URLSearchParams, Promise, JSON, Math, Number, String, Date, Array, Object, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0 });
  vm.runInContext(SRC, context);
  const $ = (id) => document.getElementById(id);
  const key = (k, t) => {
    const target = new El("page");
    const e = { key: k, timeStamp: t, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const fn of keyListeners()) fn(e);
    return e;
  };
  const settle = () => new Promise((r) => setImmediate(r));
  return { $, calls, key, settle, document, window, storage };
}

const TOTE = { key: "1", kind: "manual", description: "Tote", quantity: 1, priceCents: 500, category: "merchandise" };
const ok = (body = {}) => ({ status: 200, body: { ok: true, totalCents: 500, ...body } });

test("cash keypad: a scanner burst never reaches the amount, Enter never confirms, '20.' is sent as 20", async () => {
  const t = boot({ lines: [TOTE], responder: (url) => (url.endsWith("/check") ? ok() : ok({ saleId: 7, changeCents: 1500, receiptUrl: "/r" })) });
  t.$("pay-cash").fire("click");
  await t.settle();
  assert.equal(t.$("cash-confirm").disabled, true, "nothing typed yet");
  t.key("2", 1000); t.key("0", 1500); t.key(".", 2000);
  assert.equal(t.$("cash-received").textContent, "€20.00");
  assert.equal(t.$("cash-confirm").disabled, false);

  // a scanner types "97" and Enter within a few milliseconds
  t.key("9", 5000);
  t.key("7", 5004);
  t.key("1", 5008);
  const enter = t.key("Enter", 5012);
  assert.equal(t.$("cash-received").textContent, "€20.00", "the burst was taken back, the typed amount is unchanged");
  assert.equal(enter.defaultPrevented, true, "Enter is swallowed (it must not press a focused button)");
  assert.match(t.$("till-toast").textContent, /Finish or cancel this payment first/);
  assert.equal(t.calls.filter((c) => c.url.endsWith("/sale")).length, 0, "no sale was sent");

  // a keyboard "click" (detail 0, what Enter makes on a focused button) does not confirm
  t.$("cash-confirm").fire("click", { detail: 0 });
  await t.settle();
  assert.equal(t.calls.filter((c) => c.url.endsWith("/sale")).length, 0, "Enter cannot confirm cash");
  // a real tap does, and the trailing dot is dropped
  t.$("cash-confirm").fire("click", { detail: 1 });
  await t.settle();
  const sale = t.calls.find((c) => c.url.endsWith("/sale"));
  assert.ok(sale, "tapping Confirm sends the sale");
  assert.equal(sale.fields.received, "20");
  assert.equal(sale.fields.expectedTotalCents, "500", "the total shown is sent with the confirm");
  assert.equal(JSON.parse(sale.fields.items)[0].expected, 500, "and each line's price");
  assert.equal(sale.fields.token, "sale-one");
});

test("a scan (form submit) while a payment screen is open is not processed", async () => {
  const t = boot({ lines: [TOTE], responder: () => ok() });
  t.$("pay-cash").fire("click");
  await t.settle();
  t.$("scan").value = "UB-12";
  t.$("scan-form").fire("submit");
  await t.settle();
  assert.equal(t.calls.filter((c) => c.url.endsWith("/scan")).length, 0);
  assert.match(t.$("till-toast").textContent, /Finish or cancel this payment first/);
  assert.equal(t.$("scan").value, "", "the box is emptied");
});

test("the Card screen checks the sale first: a refusal shows before the customer pays", async () => {
  const t = boot({ lines: [TOTE], responder: () => ({ status: 409, body: { ok: false, error: 'Cannot sell "Tote": it is already sold.' } }) });
  t.$("pay-card").fire("click");
  await t.settle();
  assert.equal(t.calls[0].url, "/admin/till/check");
  assert.equal(t.$("card-check").hidden, false);
  assert.match(t.$("card-check").textContent, /already sold/);
  assert.equal(t.$("card-confirm").disabled, true, "Card paid cannot be pressed");
});

test("after 'Card paid': a server error (HTML 500) is not 'Connection problem'; a network failure is, and says do not charge again", async () => {
  let mode = "html500";
  const t = boot({
    lines: [TOTE],
    responder: (url) => {
      if (url.endsWith("/check")) return ok();
      if (mode === "network") throw new TypeError("Failed to fetch");
      if (mode === "html500") return { status: 500, body: "<html><body>Internal Server Error</body></html>" };
      if (mode === "changed") return { status: 409, body: { ok: false, code: "price_changed", newTotalCents: 800, error: "x" } };
      if (mode === "rejected") return { status: 409, body: { ok: false, error: 'Cannot sell "Tote": it is already sold.' } };
      return ok({ saleId: 9, receiptUrl: "/r" });
    },
  });
  t.$("pay-card").fire("click");
  await t.settle();
  const press = async () => { t.$("card-confirm").disabled = false; t.$("card-confirm").fire("click", { detail: 1 }); await t.settle(); await t.settle(); };

  await press();
  assert.doesNotMatch(t.$("card-error").textContent, /Connection problem/);
  assert.match(t.$("card-error").textContent, /server had a problem|error 500/i);
  assert.equal(t.$("card-charged").hidden, false, "the red 'already charged' box is up");
  assert.equal(t.$("card-confirm").textContent, "Record card sale");
  assert.equal(t.$("card-anyway").hidden, false, "Record anyway is offered");
  assert.equal(JSON.parse(t.storage.getItem("till-sale-v1")).cardPaid, true, "survives a reload");

  mode = "network";
  await press();
  assert.match(t.$("card-error").textContent, /Connection problem/);
  assert.match(t.$("card-error").textContent, /do NOT charge again/);

  mode = "rejected";
  await press();
  assert.match(t.$("card-error").textContent, /already sold/);
  assert.equal(t.$("card-charged").hidden, false);

  mode = "changed";
  t.$("card-anyway").fire("click", { detail: 1 });
  await t.settle(); await t.settle();
  assert.equal(t.$("card-error").textContent, "The price changed: new total €8.00. For a card sale do not charge again: cancel the card charge on the reader and restart.");
  assert.equal(t.$("card-restart").hidden, false);

  // Record anyway: the SAME token and the SAME total (the charged amount), no check in front
  const sales = t.calls.filter((c) => c.url.endsWith("/sale"));
  assert.ok(sales.length >= 4);
  assert.ok(sales.every((c) => c.fields.token === "sale-one" && c.fields.expectedTotalCents === "500" && c.fields.cardConfirmed === "1"));
  const checksBefore = t.calls.filter((c) => c.url.endsWith("/check")).length;
  mode = "ok";
  t.$("card-anyway").fire("click", { detail: 1 });
  await t.settle(); await t.settle();
  assert.equal(t.calls.filter((c) => c.url.endsWith("/check")).length, checksBefore, "Record anyway skips the check");
  assert.equal(t.$("done").hidden, false, "the sale is recorded");
});

test("a cash price change tells the cashier to restart; a closed day shows the reopen box", async () => {
  const t = boot({ lines: [TOTE], responder: (url) => (url.endsWith("/check")
    ? { status: 409, body: { ok: false, code: "day_closed", error: "Today's till is closed" } }
    : { status: 409, body: { ok: false, code: "price_changed", newTotalCents: 800, error: "x" } }) });
  t.$("pay-cash").fire("click");
  await t.settle();
  assert.match(t.$("cash-check").textContent, /closed/);
  const reopenBox = t.$("cash-modal").querySelector("[data-reopen]");
  assert.equal(reopenBox.hidden, false, "the 'Reopen this day' box appears");
});
