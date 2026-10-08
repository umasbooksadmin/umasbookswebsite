// Every admin form that POSTs a destructive action must ask first (data-confirm,
// handled by the delegated listener in public/app.js) unless it is on a page that
// is itself the confirmation step. A new delete/remove/void/close button added
// without a confirmation fails here.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const DESTRUCTIVE = /delete|remove|deactivate|close|void|cancel|erase|archive|toggle-admin|toggle-disabled|clearance/i;

// Forms that are allowed to POST a destructive-looking action without data-confirm.
// "file: action fragment": why.
const ALLOWED = {
  "views/admin/privacy_requests.ejs: /admin/privacy/erase-confirm": "only opens the confirmation step (it deletes nothing)",
  "views/admin/privacy_requests.ejs: /admin/privacy/erase": "the confirmation step itself: the admin must retype the address",
  "views/admin/order_refund.ejs: /refund": "this whole page is the refund confirmation step (amount, note, then a deliberate button)",
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (full.endsWith(".ejs")) out.push(full);
  }
  return out;
}

// <form ...> start tags, EJS tags inside them (which may contain ">") skipped.
function formTags(src) {
  const tags = [];
  for (let i = src.indexOf("<form"); i >= 0; i = src.indexOf("<form", i + 1)) {
    let j = i;
    while (j < src.length && src[j] !== ">") j += src.startsWith("<%", j) ? src.indexOf("%>", j) + 2 - j : 1;
    tags.push({ tag: src.slice(i, j + 1), line: src.slice(0, i).split("\n").length });
  }
  return tags;
}

function adminViews() {
  return [...walk(path.join(ROOT, "views", "admin")), path.join(ROOT, "views", "partials", "admin_resend_confirmation.ejs")];
}

test("every admin POST form with a destructive action carries data-confirm (or is allow-listed)", () => {
  const offenders = [];
  let checked = 0;
  for (const file of adminViews()) {
    const rel = path.relative(ROOT, file);
    for (const { tag, line } of formTags(fs.readFileSync(file, "utf8"))) {
      if (!/method="post"/i.test(tag)) continue;
      const action = ((tag.match(/action="([^"]*)"/) || [])[1] || "");
      if (!DESTRUCTIVE.test(action)) continue;
      checked++;
      const allowed = Object.keys(ALLOWED).some((k) => { const [f, frag] = k.split(": "); return f === rel && action.includes(frag); });
      if (!/\sdata-confirm="[^"]+"/.test(tag) && !allowed) offenders.push(`${rel}:${line} ${action}`);
    }
  }
  assert.ok(checked >= 18, `the check should see the known destructive forms (saw ${checked})`);
  assert.deepEqual(offenders, [], "these destructive forms have no data-confirm message");
});

test("the specific buttons from the review carry a clear message", () => {
  const need = [
    ["views/admin/inventory/show.ejs", /data-confirm="Delete this book and all of its copies\?/],
    ["views/admin/inventory/show.ejs", /data-confirm="Delete this copy\?/],
    ["views/admin/till/day.ejs", /data-confirm="Closing locks voids for this day\. Continue\?"/],
    ["views/admin/members.ejs", /data-confirm="<%= detail\.user\.is_disabled \? 'Reactivate/],
    ["views/admin/members.ejs", /data-confirm="<%= detail\.user\.is_admin \? 'Remove admin/],
  ];
  for (const [file, re] of need) assert.match(fs.readFileSync(path.join(ROOT, file), "utf8"), re, `${file} ${re}`);
});

test("the allow-list only names forms that exist", () => {
  for (const k of Object.keys(ALLOWED)) {
    const [f, frag] = k.split(": ");
    assert.ok(fs.readFileSync(path.join(ROOT, f), "utf8").includes(frag), `${k} no longer exists: remove it from ALLOWED`);
  }
});

test("bulk actions confirm only for the destructive choice (app.js data-confirm-field)", () => {
  const vm = require("node:vm");
  const listeners = [];
  const asked = [];
  const document = { addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture: Boolean(capture) }), querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8"), { document, window: { addEventListener() {}, confirm: (m) => { asked.push(m); return false; } }, history: {}, setTimeout, clearTimeout });
  const submit = listeners.find((l) => l.type === "submit" && l.capture).fn;
  const attrs = { "data-confirm": "Delete the selected items?", "data-confirm-field": "bulkAction", "data-confirm-values": "delete" };
  const make = (value) => ({ preventDefault() { this.prevented = true; }, stopPropagation() {}, target: { getAttribute: (n) => attrs[n] || null, elements: { bulkAction: { value } } } });
  const publish = make("publish"); submit(publish);
  assert.equal(asked.length, 0, "publishing is not asked about");
  assert.ok(!publish.prevented);
  const del = make("delete"); submit(del);
  assert.deepEqual(asked, ["Delete the selected items?"]);
  assert.equal(del.prevented, true);
});
