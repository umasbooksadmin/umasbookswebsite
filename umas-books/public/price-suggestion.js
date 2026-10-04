// Live price suggestions on the add-book form and on each copy's edit form.
// Everything here is a convenience on top of working forms: without
// JavaScript the radios, the custom price and the "Suggest price" button
// (a normal form submit) still work, and the server saves what was chosen.
//
// Add-book form: the suggested price is selected for you until you choose a
// price yourself ("dirty": picked a radio or typed a number). Changing the
// binding re-prices; changing the condition does NOT (the condition never
// changes the price), except to and from New, which is priced differently.
// Edit form: the stored price is never touched; "Use this price" only fills
// the form in, and you still press Save copy.
(function () {
  if (!window.fetch) return;
  var roots = document.querySelectorAll("[data-price-suggestion]");
  if (!roots.length) return;

  Array.prototype.forEach.call(roots, function (root) {
    var mode = root.getAttribute("data-ps-mode");
    var sfx = root.getAttribute("data-ps-suffix") || "";
    var copyId = root.getAttribute("data-ps-copy-id") || "";
    var byId = function (id) { return document.getElementById(id); };

    var priceInput = byId("price" + sfx);
    var hiddenPrice = byId("suggestedPrice" + sfx);
    var hiddenLevel = byId("suggestedLevel" + sfx);
    var condition = byId("condition" + sfx);
    var publisher = byId("publisherPrice" + sfx);
    var binding = byId("binding");
    var radios = root.querySelectorAll("input[name=priceLevel]");
    var levelsBox = root.querySelector("[data-price-levels]");
    var customBox = root.querySelector("[data-price-custom]");
    var box = root.querySelector("[data-ps-box]");
    var label = root.querySelector("[data-ps-label]");
    var review = root.querySelector("[data-ps-review]");
    var reviewText = root.querySelector("[data-ps-review-text]");
    var rationale = root.querySelector("[data-ps-rationale]");
    var comps = root.querySelector("[data-ps-comps]");
    var compsTitle = root.querySelector("[data-ps-comps-title]");
    var suggestBtn = root.querySelector("[data-ps-suggest]");
    var useBtn = root.querySelector("[data-ps-use]");
    var tags = root.querySelectorAll("[data-suggested-tag]");

    var dirty = false;
    var token = 0;
    var last = null;
    var timer = null;
    var wasNew = isNew();

    function isNew() { return Boolean(condition && condition.value === "new"); }

    function checkedRadio() {
      for (var i = 0; i < radios.length; i++) if (radios[i].checked) return radios[i];
      return null;
    }

    // New books show only the price box (they are sold at the publisher's
    // price); other copies show the choices, and the box only for "Custom".
    function syncVisibility() {
      var chosen = checkedRadio();
      var showCustom = isNew() || !chosen || chosen.value === "custom";
      levelsBox.hidden = isNew();
      customBox.hidden = !showCustom;
    }

    function keyFor(s) {
      if (!s || s.price == null) return "";
      if (s.level === "clearance") return "clearance";
      for (var i = 0; i < radios.length; i++) {
        var v = radios[i].value;
        if (v !== "clearance" && v !== "custom" && Number(radios[i].getAttribute("data-price")) === Number(s.price)) return v;
      }
      return "custom";
    }

    function fill(s) {
      var key = keyFor(s);
      for (var i = 0; i < radios.length; i++) radios[i].checked = radios[i].value === key;
      priceInput.value = s.price == null ? "" : s.price;
      syncVisibility();
      if (s.price == null && !isNew() && mode === "intake") priceInput.focus();
    }

    function list(ul, items, build) {
      while (ul.firstChild) ul.removeChild(ul.firstChild);
      items.forEach(function (it) { ul.appendChild(build(it)); });
    }

    function show(s) {
      last = s;
      box.hidden = false;
      label.textContent = s.label || "";
      review.hidden = !s.needsReview;
      reviewText.textContent = s.needsReview ? (s.reviewMessage || "") : "";
      list(rationale, s.rationale || [], function (t) {
        var li = document.createElement("li");
        li.textContent = t;
        return li;
      });
      var links = (s.comparables || []).filter(function (c) { return typeof c.url === "string" && c.url.indexOf("https://") === 0; });
      compsTitle.hidden = !links.length;
      list(comps, links, function (c) {
        var li = document.createElement("li");
        var a = document.createElement("a");
        a.href = c.url;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = c.site;
        li.appendChild(a);
        li.appendChild(document.createTextNode(": EUR " + Number(c.price).toFixed(2) + (c.condition ? " (" + c.condition + ")" : "")));
        return li;
      });
      var key = keyFor(s);
      Array.prototype.forEach.call(tags, function (t) { t.hidden = t.getAttribute("data-suggested-tag") !== key; });
      if (hiddenPrice) hiddenPrice.value = s.price == null ? "" : s.price;
      if (hiddenLevel) hiddenLevel.value = s.levelText || "";
      if (useBtn) useBtn.hidden = s.price == null;
    }

    function request(applyToForm) {
      var my = ++token;
      var p = new URLSearchParams();
      var get = function (id) { var e = byId(id); return e ? e.value : ""; };
      if (copyId) p.set("copyId", copyId);
      else {
        p.set("isbn", get("isbn"));
        p.set("title", get("title"));
        p.set("author", get("author"));
      }
      p.set("binding", binding ? binding.value : "");
      p.set("condition", condition ? condition.value : "");
      p.set("publisherPrice", publisher ? publisher.value : "");
      fetch("/admin/inventory/price-suggestion?" + p.toString(), { credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (s) {
          if (my !== token) return; // a newer request is on its way
          if (!s) {
            box.hidden = false;
            label.textContent = "The price check is not available right now. You can still choose a price.";
            return;
          }
          show(s);
          if (applyToForm) fill(s);
        })
        .catch(function () {
          if (my === token) {
            box.hidden = false;
            label.textContent = "The price check is not available right now. You can still choose a price.";
          }
        });
    }

    Array.prototype.forEach.call(radios, function (r) {
      r.addEventListener("change", function () {
        dirty = true;
        var price = r.getAttribute("data-price");
        if (price !== "" && price !== null) priceInput.value = price;
        syncVisibility();
        if (r.value === "custom") priceInput.focus();
      });
    });

    priceInput.addEventListener("input", function () {
      dirty = true;
      for (var i = 0; i < radios.length; i++) radios[i].checked = radios[i].value === "custom";
      syncVisibility();
    });

    if (binding) binding.addEventListener("change", function () { request(mode === "intake" && !dirty); });

    if (condition) {
      condition.addEventListener("change", function () {
        syncVisibility();
        // Only New is priced differently; any other change leaves the price alone.
        if (isNew() !== wasNew) {
          wasNew = isNew();
          if (mode === "intake" || !box.hidden) request(mode === "intake" && !dirty);
        }
      });
    }

    if (publisher) {
      publisher.addEventListener("input", function () {
        if (!isNew()) return;
        clearTimeout(timer);
        timer = setTimeout(function () { request(mode === "intake" && !dirty); }, 500);
      });
    }

    var isbn = byId("isbn");
    if (isbn && mode === "intake") isbn.addEventListener("change", function () { request(!dirty); });

    if (suggestBtn) {
      suggestBtn.addEventListener("click", function (e) {
        e.preventDefault();
        if (mode === "intake") dirty = false; // asked for explicitly: apply it
        request(mode === "intake");
      });
    }

    if (useBtn) {
      useBtn.addEventListener("click", function (e) {
        if (!last) return; // no suggestion loaded yet: let the form do it on the server
        e.preventDefault();
        fill(last);
        dirty = true;
        priceInput.focus();
      });
    }

    syncVisibility();
  });
})();
