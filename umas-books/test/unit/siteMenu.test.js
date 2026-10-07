// public/site-menu.js, run in a vm with a tiny fake DOM: the phone "Menu"
// (<details>) gets aria-expanded, closes on Esc (focus back on the button) and
// on an outside click or Tab, and is forced open (links visible) from 641px up.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "..", "public", "site-menu.js"), "utf8");

function setup({ phone }) {
  const docListeners = {};
  const menuListeners = {};
  const attrs = {};
  let focused = null;
  const button = { setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; }, focus() { focused = "button"; } };
  const inside = { inside: true };
  const menu = {
    open: false,
    querySelector: (sel) => (sel === "summary" ? button : null),
    contains: (n) => n === inside || n === button || n === menu,
    addEventListener: (type, fn) => { menuListeners[type] = fn; },
  };
  const mq = { matches: phone, addEventListener: (type, fn) => { mq.change = fn; } };
  const document = {
    querySelector: (sel) => (sel === "details.h-menu" ? menu : null),
    addEventListener: (type, fn) => { docListeners[type] = fn; },
    get activeElement() { return focused === "button" ? button : inside; },
  };
  vm.runInNewContext(SRC, { document, window: { matchMedia: () => mq } });
  return { menu, mq, attrs, docListeners, menuListeners, inside, get focused() { return focused; }, button };
}

test("phone: starts closed with aria-expanded=false; toggling updates aria-expanded", () => {
  const t = setup({ phone: true });
  assert.equal(t.menu.open, false);
  assert.equal(t.attrs["aria-expanded"], "false");
  t.menu.open = true; t.menuListeners.toggle();
  assert.equal(t.attrs["aria-expanded"], "true");
});

test("phone: Esc closes the open menu and puts focus back on the Menu button", () => {
  const t = setup({ phone: true });
  t.menu.open = true; t.menuListeners.toggle();
  t.docListeners.keydown({ key: "Escape" });
  assert.equal(t.menu.open, false);
  assert.equal(t.attrs["aria-expanded"], "false");
  assert.equal(t.focused, "button");
});

test("phone: a click outside closes it, a click inside does not; Tab out of the menu closes it", () => {
  const t = setup({ phone: true });
  t.menu.open = true;
  t.docListeners.click({ target: t.inside });
  assert.equal(t.menu.open, true, "click inside");
  t.docListeners.click({ target: { elsewhere: true } });
  assert.equal(t.menu.open, false, "click outside");
  t.menu.open = true;
  t.menuListeners.focusout({ relatedTarget: { elsewhere: true } });
  assert.equal(t.menu.open, false, "focus left the menu");
});

test("desktop (641px and up): the links are forced open and no aria-expanded is set; Esc and outside clicks do nothing", () => {
  const t = setup({ phone: false });
  assert.equal(t.menu.open, true);
  assert.equal("aria-expanded" in t.attrs, false);
  t.docListeners.keydown({ key: "Escape" });
  t.docListeners.click({ target: { elsewhere: true } });
  assert.equal(t.menu.open, true);
});

test("resizing across the phone breakpoint re-syncs the menu", () => {
  const t = setup({ phone: false });
  t.mq.matches = true; t.mq.change();
  assert.equal(t.menu.open, false);
  assert.equal(t.attrs["aria-expanded"], "false");
  t.mq.matches = false; t.mq.change();
  assert.equal(t.menu.open, true);
});

test("a page without the menu is left alone (no error)", () => {
  vm.runInNewContext(SRC, { document: { querySelector: () => null }, window: { matchMedia: () => ({ matches: true }) } });
});
