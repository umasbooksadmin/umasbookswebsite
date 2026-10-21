// Publisher's price note + "required" marker on the Add Book / edit copy forms.
// Same rule as lib/inventory.js resolveCopyPricing: a New copy needs the publisher's price (and is held to 95-100% of it)
// unless the book was published MORE than 2 years ago (the end of its year is more than 2 years back, Europe/Paris).
// The add page's year is filled by the lookup without an event, so a short timer also watches it.
(function () {
  "use strict";
  var helps = document.querySelectorAll("[data-pubprice-help]");
  if (!helps.length) return;

  function parisYear() {
    try {
      return Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric" }).format(new Date()));
    } catch { return new Date().getFullYear(); }
  }

  // Year-only: 31 Dec of year Y + 2 years is 31 Dec Y+2, so it is "more than 2 years" from 1 Jan Y+3.
  function isOld(raw) {
    var m = /^\s*(\d{4})\s*$/.exec(String(raw == null ? "" : raw));
    if (!m || Number(m[1]) < 1000) return false;
    return parisYear() >= Number(m[1]) + 3;
  }

  Array.prototype.forEach.call(helps, function (help) {
    var sfx = help.getAttribute("data-pp-suffix") || "";
    var yearInputId = help.getAttribute("data-pp-year-input");
    var fixedYear = help.getAttribute("data-pp-year");
    var condition = document.getElementById("condition" + sfx);
    var yearInput = yearInputId ? document.getElementById(yearInputId) : null;
    var label = document.querySelector('label[for="publisherPrice' + sfx + '"] [data-pp-required]');
    var dflt = help.querySelector("[data-pp-default]");
    var old = help.querySelector("[data-pp-old]");
    var last = null;

    function sync() {
      var isNew = Boolean(condition && condition.value === "new");
      var year = yearInput ? yearInput.value : fixedYear;
      var key = isNew + "|" + year;
      if (key === last) return;
      last = key;
      var relaxed = isNew && isOld(year);
      if (dflt) dflt.hidden = relaxed;
      if (old) old.hidden = !relaxed;
      if (label) label.hidden = !(isNew && !relaxed);
    }

    if (condition) condition.addEventListener("change", sync);
    if (yearInput) {
      yearInput.addEventListener("input", sync);
      yearInput.addEventListener("change", sync);
      setInterval(sync, 400);
    }
    sync();
  });
})();
