// Remembers the "current location" between books on the add-book flow.
// Everything here is a convenience on top of working forms: the server
// already carries the location through the scan -> add -> save loop, this
// just also survives a page reload or a new visit to the scan page.
(function () {
  var KEY = "umas.inventory.location";

  function normalize(v) {
    return String(v || "").replace(/\s+/g, " ").trim().toUpperCase().slice(0, 40);
  }
  function read() {
    try { return localStorage.getItem(KEY) || ""; } catch (e) { return ""; }
  }
  function write(v) {
    try { if (v) localStorage.setItem(KEY, v); } catch (e) { /* storage blocked: fine */ }
  }

  // The source of the batch (donation / purchase / ...) is remembered the same
  // way: a select on the scan page, mirrored into the photo form.
  (function () {
    var SOURCE_KEY = "umas.inventory.source";
    var select = document.querySelector("[data-source-input]");
    if (!select) return;
    var sourceMirrors = document.querySelectorAll("[data-source-mirror]");
    function syncSource() {
      try { if (select.value) localStorage.setItem(SOURCE_KEY, select.value); else localStorage.removeItem(SOURCE_KEY); } catch (e) { /* storage blocked: fine */ }
      for (var i = 0; i < sourceMirrors.length; i++) sourceMirrors[i].value = select.value;
    }
    if (!select.value) {
      var savedSource = "";
      try { savedSource = localStorage.getItem(SOURCE_KEY) || ""; } catch (e) { /* storage blocked: fine */ }
      for (var j = 0; j < select.options.length; j++) {
        if (select.options[j].value === savedSource) select.value = savedSource;
      }
    }
    syncSource();
    select.addEventListener("change", syncSource);
  })();

  var input = document.querySelector("[data-location-input]");
  if (!input) return;
  var mirrors = document.querySelectorAll("[data-location-mirror]");

  function sync() {
    var v = normalize(input.value);
    write(v);
    for (var i = 0; i < mirrors.length; i++) mirrors[i].value = v;
  }

  if (!input.value) {
    var saved = read();
    if (saved) input.value = saved;
  }
  sync();

  input.addEventListener("input", sync);
  input.addEventListener("change", sync);

  // A scanner types a code then presses Enter. In this field that must not
  // submit the whole form: store the value and go to the next field.
  input.addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    input.value = normalize(input.value);
    sync();
    var next = document.getElementById("isbn") || document.getElementById("price");
    if (next) next.focus();
  });
})();
