// The admin area's destructive forms used to confirm with an inline
// onsubmit="return confirm(...)" — which the app's CSP (script-src 'self',
// script-src-attr 'none', src/index.js) silently blocks, so the buttons
// submitted with NO confirmation. They now carry data-confirm="..." and one
// delegated capture-phase listener in public/app.js asks.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// view -> the data-confirm messages its destructive forms must carry
const DESTRUCTIVE = {
  "views/admin/members.ejs": [
    "Erase this member? Their account, sign-ups and reservations are deleted, and their name/email on past reservations is anonymised. This can't be undone.",
    "Reset two-step verification for this account? They will be logged out and must set it up again.",
  ],
  "views/admin/blog.ejs": ["Delete this post permanently?"],
  "views/admin/announcements.ejs": ["Delete this announcement permanently? This can't be undone."],
  "views/admin/charity.ejs": [
    "Close this vote? It will move to Past Votes.",
    "Remove this charity from the vote?",
    "Delete this idea?",
  ],
};

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, name.name);
    if (name.isDirectory()) walk(full, out);
    else if (full.endsWith(".ejs")) out.push(full);
  }
  return out;
}

for (const [view, messages] of Object.entries(DESTRUCTIVE)) {
  test(`${view}: destructive forms use data-confirm, with no inline handler or script`, () => {
    const src = read(view);
    assert.doesNotMatch(src, /\sonsubmit\s*=/i, "inline onsubmit is blocked by the CSP");
    assert.doesNotMatch(src, /<script(?![^>]*\ssrc=)/i, "inline <script> is blocked by the CSP");
    for (const message of messages) {
      const forms = src.match(/<form\b(?:<%[^]*?%>|[^>])*>/g) || [];
      const carrying = forms.filter((f) => f.includes(`data-confirm="${message}"`));
      assert.equal(carrying.length, 1, `exactly one <form> should carry data-confirm="${message}"`);
      assert.match(carrying[0], /method="post"/);
    }
  });
}

test("no view (app OR marketing) uses an inline event handler or inline script", () => {
  const offenders = [];
  for (const file of walk(path.join(ROOT, "views"))) {
    const src = fs.readFileSync(file, "utf8");
    if (/\son(submit|click|change|input|load|error)\s*=/i.test(src)) offenders.push(`${file}: inline handler`);
    if (/<script(?![^>]*\ssrc=)(?![^>]*ld\+json)(?![^>]*application\/json)/i.test(src)) offenders.push(`${file}: inline <script>`);
  }
  assert.deepEqual(offenders, []);
});

test("the blog Preview button's script is an external file", () => {
  assert.match(read("views/admin/blog.ejs"), /<script src="\/blog-preview\.js"><\/script>/);
  assert.match(read("public/blog-preview.js"), /blog-preview-btn/);
});

// Loads public/app.js into a bare vm context with a recording stub
// `document`, so the delegated submit listener can be driven without jsdom.
function loadAppJs(confirmAnswer) {
  const listeners = [];
  const asked = [];
  const document = {
    addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture: Boolean(capture) }),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
  };
  const window = { confirm: (m) => { asked.push(m); return confirmAnswer; } };
  vm.runInNewContext(read("public/app.js"), { document, window, history: {}, setTimeout, clearTimeout });
  return { listeners, asked };
}

function fakeSubmit(confirmAttr) {
  const ev = { prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  ev.target = { getAttribute: (n) => (n === "data-confirm" ? confirmAttr : null) };
  return ev;
}

test("app.js registers a capture-phase submit listener that asks data-confirm and cancels when declined", () => {
  const { listeners, asked } = loadAppJs(false);
  const capture = listeners.filter((l) => l.type === "submit" && l.capture);
  assert.equal(capture.length, 1, "exactly one delegated capture-phase submit listener");

  const declined = fakeSubmit("Delete this idea?");
  capture[0].fn(declined);
  assert.deepEqual(asked, ["Delete this idea?"]);
  assert.equal(declined.prevented, true, "declining must cancel the submit");
  assert.equal(declined.stopped, true, "and keep other submit listeners from running");

  const plain = fakeSubmit(null);
  capture[0].fn(plain);
  assert.equal(plain.prevented, false, "a form without data-confirm is untouched");
  assert.equal(asked.length, 1, "and is never asked about");
});

test("accepting the confirmation lets the submit through", () => {
  const { listeners, asked } = loadAppJs(true);
  const ev = fakeSubmit("Delete this idea?");
  listeners.find((l) => l.type === "submit" && l.capture).fn(ev);
  assert.equal(asked.length, 1);
  assert.equal(ev.prevented, false);
  assert.equal(ev.stopped, false);
});

function runPasswordToggle(lang) {
  const input = { type: "password" };
  const attrs = {};
  const btn = {
    textContent: lang === "fr" ? "Afficher" : "Show",
    getAttribute: (n) => (n === "data-toggle-password" ? "pw" : attrs[n]),
    setAttribute: (n, v) => { attrs[n] = v; },
  };
  const listeners = [];
  const document = {
    documentElement: { lang },
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: (id) => (id === "pw" ? input : null),
  };
  vm.runInNewContext(read("public/app.js"), { document, window: {}, history: {}, setTimeout, clearTimeout });
  const click = { target: { closest: (sel) => (sel === "[data-toggle-password]" ? btn : null) } };
  const press = () => { for (const l of listeners.filter((x) => x.type === "click")) l.fn(click); };
  return { input, attrs, btn, press };
}

test("the password toggle keeps aria-pressed and aria-label in step", () => {
  const { input, attrs, btn, press } = runPasswordToggle("en");
  press();
  assert.equal(input.type, "text");
  assert.equal(attrs["aria-pressed"], "true");
  assert.equal(attrs["aria-label"], "Hide password");
  assert.equal(btn.textContent, "Hide");
  press();
  assert.equal(input.type, "password");
  assert.equal(attrs["aria-pressed"], "false");
  assert.equal(attrs["aria-label"], "Show password");
  assert.equal(btn.textContent, "Show");
});

test("the password toggle speaks French when <html lang> is fr", () => {
  const { input, attrs, btn, press } = runPasswordToggle("fr");
  press();
  assert.equal(input.type, "text");
  assert.equal(attrs["aria-label"], "Masquer le mot de passe");
  assert.equal(btn.textContent, "Masquer");
  press();
  assert.equal(attrs["aria-label"], "Afficher le mot de passe");
  assert.equal(btn.textContent, "Afficher");
});
