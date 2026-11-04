// Remembers the location of the last book added, in the Location field of the
// add-book form. Everything here is a convenience on top of working forms: the
// server already carries the location through the save -> next book loop, this
// just also survives a page reload or a new visit to the page.
//
// Also the one client-side place that knows a barcode is not a location: a
// scanner whose cursor landed in the Location box types an ISBN there
// ("9780141024479Storage"). clean() drops it, the same rule as normalizeLocation
// in src/lib/inventory.js; scan-intake.js uses window.InventoryLocation too.
// The plain functions need no browser: test/unit/inventoryLocation.test.js.
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.InventoryLocation = api;
  if (typeof document !== "undefined") api.init(document);
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";

  var MAX = 40;
  var BARCODE_START = /^\d{8,14}(?!\d)/;
  var BARCODE_END = /(^|\D)\d{8,14}$/;

  // { location, barcode }: the location with a barcode-looking run of 8 to 14 digits
  // cut off its start or end (when other text remains), and the run that was cut off.
  // A value that is only such a run has location "" (blank means the default).
  // "Shelf 12", "Box 2024" and "A-7" are untouched; a longer run of digits is no barcode.
  function split(v) {
    var s = String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim(); // eslint-disable-line no-control-regex
    var barcode = "";
    var m = s.match(BARCODE_START);
    if (m) { barcode = m[0]; s = s.slice(m[0].length).trim(); }
    m = s.match(BARCODE_END);
    if (m) { if (!barcode) barcode = m[0].replace(/^\D/, ""); s = s.slice(0, s.length - m[0].length + m[1].length).trim(); }
    return { location: s.slice(0, MAX).trim(), barcode: barcode };
  }
  function clean(v) { return split(v).location; }

  // Tells a scanner (8 or more characters, each a few milliseconds after the
  // last) from a person typing: key() on every input event, isBurst() after.
  function createBurstGuard(opts) {
    var now = (opts && opts.now) || Date.now;
    var gapMs = (opts && opts.gapMs) || 60;
    var last = 0, run = 0;
    return {
      key: function () { var t = now(); run = last && t - last <= gapMs ? run + 1 : 1; last = t; },
      isBurst: function () { return run >= 8; },
      reset: function () { run = 0; last = 0; },
    };
  }

  var STORE_NAME = "umas.inventory.location.v3";
  var PAUSE_MS = 150;

  function init(document) {
    var input = document.querySelector("[data-location-input]");
    if (!input) return;
    var mirrors = document.querySelectorAll("[data-location-mirror]");

    function read() {
      try {
        var saved = localStorage.getItem(STORE_NAME) || "";
        var c = clean(saved);
        if (c !== saved) { if (c) localStorage.setItem(STORE_NAME, c); else localStorage.removeItem(STORE_NAME); } // a barcode got in once: heal it
        return c;
      } catch { return clean(""); }
    }
    function write(v) {
      try { if (v) localStorage.setItem(STORE_NAME, v); } catch { /* storage blocked: fine */ }
    }

    var remember = false; // only what a person types or picks is remembered, never the starting value
    function sync() {
      var v = clean(input.value);
      if (remember) write(v);
      for (var i = 0; i < mirrors.length; i++) mirrors[i].value = v;
    }

    // A fresh form starts at the default ("Store"): the location used last in this
    // browser takes its place, unless the page was opened with a location of its own.
    if (!input.value || input.hasAttribute("data-location-default")) {
      var saved = read();
      if (saved) input.value = saved;
    }
    input.value = clean(input.value) || input.value;
    var committed = clean(input.value); // the last value without a barcode in it
    sync();

    var guard = createBurstGuard();
    var timer = null;
    var isbnBox = function () { return document.getElementById("isbn"); };

    // A scanner's digits landed here: they belong in the ISBN box, the location stays as it was.
    function divert() {
      clearTimeout(timer);
      var parts = split(input.value);
      var box = isbnBox();
      if (!parts.barcode || !guard.isBurst() || !box) return false;
      input.value = parts.location || committed;
      guard.reset();
      remember = true; sync();
      box.value = parts.barcode;
      box.dispatchEvent(new Event("input", { bubbles: true })); // scan-intake.js looks the book up
      box.focus();
      return true;
    }
    // Typed slowly or pasted: just clean it when the person leaves the field.
    function tidy() {
      var c = clean(input.value);
      if (c !== input.value) input.value = c || committed;
      committed = clean(input.value);
      remember = true; sync();
    }

    input.addEventListener("input", function () {
      guard.key();
      var parts = split(input.value);
      if (!parts.barcode) committed = parts.location;
      remember = true; sync();
      clearTimeout(timer);
      if (parts.barcode) timer = setTimeout(divert, PAUSE_MS);
    });
    input.addEventListener("change", tidy);
    input.addEventListener("blur", function () { if (!divert()) tidy(); });

    // A scanner types a code then presses Enter. In this field that must not
    // submit the whole form: store the value and go to the next field.
    input.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (divert()) return;
      tidy();
      var next = isbnBox() || document.getElementById("price");
      if (next) next.focus();
    });
  }

  return { split: split, clean: clean, createBurstGuard: createBurstGuard, init: init, STORE_NAME: STORE_NAME };
});
