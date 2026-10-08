// Remembers the location of the last book added, in the Location field of the
// add-book form. Everything here is a convenience on top of working forms: the
// server already carries the location through the save -> next book loop, this
// just also survives a page reload or a new visit to the page.
(function () {
  var STORE_NAME = "umas.inventory.location.v2";

  function normalize(v) {
    return String(v || "").replace(/\s+/g, " ").trim().toUpperCase().slice(0, 40);
  }
  function read() {
    try { return localStorage.getItem(STORE_NAME) || ""; } catch (e) { return ""; }
  }
  function write(v) {
    try { if (v) localStorage.setItem(STORE_NAME, v); } catch (e) { /* storage blocked: fine */ }
  }

  var input = document.querySelector("[data-location-input]");
  if (!input) return;
  var mirrors = document.querySelectorAll("[data-location-mirror]");

  var remember = false; // only what a person types or picks is remembered, never the starting value
  function sync() {
    var v = normalize(input.value);
    if (remember) write(v);
    for (var i = 0; i < mirrors.length; i++) mirrors[i].value = v;
  }

  // A fresh form starts at the default ("STORE"): the location used last in this
  // browser takes its place, unless the page was opened with a location of its own.
  if (!input.value || input.hasAttribute("data-location-default")) {
    var saved = read();
    if (saved) input.value = saved;
  }
  sync();

  function sync2() { remember = true; sync(); }
  input.addEventListener("input", sync2);
  input.addEventListener("change", sync2);

  // A scanner types a code then presses Enter. In this field that must not
  // submit the whole form: store the value and go to the next field.
  input.addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    input.value = normalize(input.value);
    sync2();
    var next = document.getElementById("isbn") || document.getElementById("price");
    if (next) next.focus();
  });
})();
