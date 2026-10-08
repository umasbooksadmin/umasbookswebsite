// The one-screen "Add a book" page (views/admin/inventory/new.ejs): scan or
// type an ISBN, the book is looked up in place and the form filled in, Save
// puts a fresh form back with the cursor in the ISBN box, ready for the next
// book. Everything here is a convenience on top of a form that still works
// without JavaScript (the "Look up" button posts to the old lookup page).
//
// Two parts. The first holds the plain functions (what counts as a complete
// ISBN, the debounce, the stale-answer guard, which fields to fill, the
// messages): no browser needed, so test/unit/scanIntake.test.js loads them
// with require(). The second wires them to the page.

(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ScanIntake = api;
  if (typeof document !== "undefined") api.init(document, root);
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";

  // ------------------------------------------------------------------ pure part

  // The digits (and a final X) of what was typed: hyphens and spaces are ignored.
  function isbnDigits(raw) {
    return String(raw == null ? "" : raw).replace(/[\s-]/g, "").toUpperCase();
  }

  // A complete ISBN: 13 digits, or 10 (the last may be X).
  function isCompleteIsbn(raw) {
    var d = isbnDigits(raw);
    return /^\d{13}$/.test(d) || /^\d{9}[\dX]$/.test(d);
  }

  // Decides when a scan is finished. A scanner types the digits then presses
  // Enter, but some skip the Enter, so a complete value also counts once the
  // typing has paused (150 ms). A 13-digit ISBN passes through 10 digits on
  // its way, which is why a complete value is only acted on after the pause.
  // The timer functions can be replaced (tests use a fake clock).
  function createScanWatcher(opts) {
    var delay = opts.delay == null ? 150 : opts.delay;
    var onComplete = opts.onComplete;
    var setT = opts.setTimeoutFn || setTimeout;
    var clearT = opts.clearTimeoutFn || clearTimeout;
    var now = opts.now || Date.now;
    var timer = null;
    var last = { isbn: "", at: 0 };
    var DUPLICATE_MS = 1000;

    function fire(raw) {
      var isbn = isbnDigits(raw);
      if (last.isbn === isbn && now() - last.at < DUPLICATE_MS) return false; // the pause and the Enter of one scan
      last = { isbn: isbn, at: now() };
      onComplete(isbn);
      return true;
    }
    return {
      // Called on every change of the box.
      input: function (raw) {
        if (timer !== null) { clearT(timer); timer = null; }
        if (!isCompleteIsbn(raw)) return;
        timer = setT(function () { timer = null; fire(raw); }, delay);
      },
      // Called when Enter is pressed in the box. Returns true when the value is
      // a complete ISBN (whether or not a lookup was started just now).
      enter: function (raw) {
        if (timer !== null) { clearT(timer); timer = null; }
        if (!isCompleteIsbn(raw)) return false;
        fire(raw);
        return true;
      },
      cancel: function () { if (timer !== null) { clearT(timer); timer = null; } },
    };
  }

  // Only the newest lookup may change the form: begin() gives each lookup a
  // number, isCurrent() says whether it is still the latest one.
  function createRequestGuard() {
    var n = 0;
    return {
      begin: function () { n += 1; return n; },
      isCurrent: function (id) { return id === n; },
      cancel: function () { n += 1; },
    };
  }

  // The fields a lookup fills, as form field name -> key in the lookup answer.
  var FILL_FIELDS = {
    title: "title", author: "author", publisher: "publisher", publishedYear: "publishedYear",
    genre: "genre", genreFr: "genreFr", description: "description", coverUrl: "coverUrl",
  };

  // What to put in the form for a lookup answer: every field the volunteer has
  // not edited by hand gets the answer's value (or is emptied, so nothing of the
  // previous book stays behind); a field they typed in is left alone.
  function planFill(book, touched) {
    var values = {};
    Object.keys(FILL_FIELDS).forEach(function (name) {
      if (touched && touched[name]) return;
      var v = book ? book[FILL_FIELDS[name]] : null;
      values[name] = v == null ? "" : String(v);
    });
    return values;
  }

  // A binding key that exists in the list of this page ("paperback" is read as
  // "trade" when the list has no "paperback"), else "".
  function resolveBindingKey(key, available) {
    if (!key) return "";
    if (available.indexOf(key) !== -1) return key;
    if (key === "paperback" && available.indexOf("trade") !== -1) return "trade";
    return "";
  }

  // The binding after a lookup. The catalog's answer never replaces what is
  // selected (the binding of the last book is kept for a run of paperbacks);
  // it is only shown as small helper text.
  function chooseBinding(state) {
    var helper = state.hint ? "Open Library says: " + (state.hint.label || state.hint.key) : "";
    return { value: state.current, helper: helper };
  }

  // The status line for a lookup answer: { kind: found | notfound | stocked, text }.
  function lookupStatus(result) {
    var ex = result && result.existing;
    if (ex && ex.copies > 0) {
      return { kind: "stocked", text: "Already in stock: " + ex.copies + (ex.copies === 1 ? " copy" : " copies") + ". " + (ex.title || "") };
    }
    if (result && result.found && result.book && result.book.title) return { kind: "found", text: "Found: " + result.book.title };
    return { kind: "notfound", text: "Not found: fill in by hand" };
  }

  // Scan mode: one tap saves a book that is new to the shop when a price
  // was suggested and nobody needs to review it.
  function canOneTapSave(result, scanMode) {
    if (!scanMode || !result || !result.found || !result.book || !result.book.title) return false;
    if (result.existing) return false;
    var s = result.suggestion;
    return Boolean(s && s.price != null && !s.needsReview);
  }

  // How far the on-screen keyboard covers the bottom of the page, from the
  // layout height (window.innerHeight) and the visual viewport.
  function keyboardInset(innerHeight, vv) {
    if (!vv) return 0;
    return Math.max(0, Math.round(innerHeight - vv.height - (vv.offsetTop || 0)));
  }

  // ------------------------------------------------------------------ page part

  function init(document, window) {
    var form = document.querySelector("[data-scan-intake] form");
    if (!form) return;
    var rootEl = form.closest("[data-scan-intake]");
    var $ = function (sel) { return form.querySelector(sel); };
    var isbn = $("[data-scan-isbn]");
    var statusEl = document.getElementById("scan-status");
    var savedEl = document.getElementById("scan-saved");
    var lookupButton = $("[data-scan-lookup-button]");
    var saveNext = $("[data-scan-save-next]");
    var saveSuggested = $("[data-scan-save-suggested]");
    var scanModeBox = $("[data-scan-mode]");
    var coverImg = document.getElementById("cover-preview");
    var bindingSel = document.getElementById("binding");
    var bindingHint = document.getElementById("binding-hint");
    var locationInput = document.getElementById("location");
    var conditionSel = document.getElementById("condition");
    var sourceSel = document.getElementById("source");
    var more = $("[data-scan-more]");
    var priceRoot = $("[data-price-suggestion]");
    if (!isbn) return;

    // Marks the page as enhanced: the price script then leaves the ISBN's
    // "change" alone (the lookup brings the price suggestion with it).
    isbn.setAttribute("data-scan-active", "1");

    var BINDING_STORE_NAME = "umas.inventory.binding.v2";
    var SOURCE_STORE_NAME = "umas.inventory.source.v2";
    var CONDITION_STORE_NAME = "umas.inventory.condition.v2";
    var LOCATION_STORE_NAME = "umas.inventory.location.v2"; // same name as inventory-location.js
    var MODE_STORE_NAME = "umas.scan.mode";
    function store(key, value) { try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch (e) { /* storage blocked: fine */ } }
    function recall(key) { try { return localStorage.getItem(key) || ""; } catch (e) { return ""; } }

    function normalizeLoc(v) { return String(v || "").replace(/\s+/g, " ").trim().toUpperCase().slice(0, 40); }
    // A location typed for the first time joins the dropdown at once (the server lists it from the next page load on).
    function addLocationOption(v) {
      var list = document.getElementById("location-options");
      if (!list || !v) return;
      for (var k = 0; k < list.options.length; k++) if (list.options[k].value === v) return;
      var o = document.createElement("option"); o.value = v; list.appendChild(o);
    }

    var guard = createRequestGuard();
    var touched = {};
    var inFlight = false;
    var saving = false;
    var pendingIsbn = "";
    var lastResult = null;

    function setStatus(kind, text) {
      statusEl.className = "scan-status" + (kind ? " is-" + kind : "");
      statusEl.textContent = text || "";
    }

    function focusIsbn() {
      try { isbn.focus({ preventScroll: false }); isbn.select(); } catch (e) { /* fine */ }
    }

    // ---- remembered binding (the last one entered) and location
    var availableBindings = [];
    for (var i = 0; i < bindingSel.options.length; i++) if (bindingSel.options[i].value) availableBindings.push(bindingSel.options[i].value);
    // Every one of Binding, Source and Condition (and the Location, see inventory-location.js)
    // starts as the last value used in this browser, unless the address carried one
    // (after a save without JavaScript). The very first time the server's starting values stay.
    function optionValues(sel) { var out = []; for (var k = 0; k < sel.options.length; k++) out.push(sel.options[k].value); return out; }
    var started = false; // true once the page has finished its own set-up: later changes are a person's choices
    function remember(key, sel, fromServer, resolve) {
      var saved = resolve(recall(key));
      if (!fromServer && saved !== null && optionValues(sel).indexOf(saved) !== -1) sel.value = saved;
      // Only a choice made by a person is stored (below, and when a book is saved): the starting value is not.
      sel.addEventListener("change", function (e) { if (e.isTrusted || started) store(key, sel.value || "-"); });
    }
    var isSet = function (n) { return rootEl.getAttribute("data-" + n + "-set") === "1"; };
    var keepAsIs = function (v) { return v === "-" ? "" : (v || null); };
    remember(BINDING_STORE_NAME, bindingSel, isSet("binding"), function (v) { return v === "-" ? "" : (v ? (resolveBindingKey(v, availableBindings) || null) : null); });
    remember(SOURCE_STORE_NAME, sourceSel, isSet("source"), keepAsIs);
    remember(CONDITION_STORE_NAME, conditionSel, isSet("condition"), keepAsIs);
    conditionSel.dispatchEvent(new Event("change", { bubbles: true })); // the price control follows a remembered condition
    started = true;

    // ---- fields edited by hand are never overwritten by a lookup
    Object.keys(FILL_FIELDS).forEach(function (name) {
      var el = form.elements[name];
      if (el) el.addEventListener("input", function () { touched[name] = true; });
    });

    // ---- filling the form
    function fillForm(result) {
      var values = planFill(result.found ? result.book : null, touched);
      Object.keys(values).forEach(function (name) {
        var el = form.elements[name];
        if (el) el.value = values[name];
      });
      var cover = values.coverUrl;
      if (cover && !touched.coverUrl) { coverImg.src = cover; coverImg.hidden = false; } else if (!cover) { coverImg.hidden = true; coverImg.removeAttribute("src"); }
      var chosen = chooseBinding({ current: bindingSel.value, hint: result.bindingHint, available: availableBindings });
      bindingHint.textContent = chosen.helper;
      if (priceRoot && result.suggestion) priceRoot.dispatchEvent(new CustomEvent("ps:apply", { detail: result.suggestion }));
    }

    function updateSuggestedButton() {
      if (!saveSuggested) return;
      var on = canOneTapSave(lastResult, scanModeBox && scanModeBox.checked);
      saveSuggested.hidden = !on;
      if (on) saveSuggested.textContent = "Save (suggested price EUR " + Number(lastResult.suggestion.price).toFixed(2) + ")";
    }

    // ---- lookup
    function runLookup(raw) {
      var digits = isbnDigits(raw);
      if (saving) { pendingIsbn = digits; return; }
      var id = guard.begin();
      inFlight = true;
      lastResult = null;
      updateSuggestedButton();
      setStatus("loading", "Looking up…");
      fetch("/admin/inventory/lookup?isbn=" + encodeURIComponent(digits) + "&binding=" + encodeURIComponent(bindingSel.value), { credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(function (r) {
          return r.json().then(function (j) { return { status: r.status, body: j }; }, function () { return { status: r.status, body: null }; });
        })
        .then(function (res) {
          if (!guard.isCurrent(id)) return; // a newer scan is on its way
          inFlight = false;
          if (!res.body || !res.body.ok) {
            var msg = res.body && res.body.error ? res.body.error : (res.status === 429 ? "Too many lookups: wait a minute." : "The lookup did not work. Fill in by hand, or scan again.");
            setStatus("error", msg);
            return;
          }
          lastResult = res.body;
          fillForm(res.body);
          var st = lookupStatus(res.body);
          setStatus(st.kind, st.text);
          updateSuggestedButton();
          focusIsbn();
        })
        .catch(function () {
          if (!guard.isCurrent(id)) return;
          inFlight = false;
          setStatus("error", "No connection: the lookup did not run. Fill in by hand, or scan again. The form still works.");
        });
    }

    var watcher = createScanWatcher({ onComplete: runLookup });
    isbn.addEventListener("input", function () { watcher.input(isbn.value); });
    isbn.addEventListener("focus", function () { try { isbn.select(); } catch (e) { /* fine */ } });
    isbn.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" || e.ctrlKey || e.metaKey) return;
      e.preventDefault(); // Enter here only looks up: it never submits the form
      if (!watcher.enter(isbn.value)) setStatus("error", isbn.value.trim() ? "An ISBN has 10 or 13 digits." : "Scan or type the ISBN first.");
    });

    // ---- saving without leaving the page
    var errorEl = document.createElement("div");
    errorEl.className = "error-box scan-error";
    errorEl.setAttribute("role", "alert");
    errorEl.hidden = true;
    statusEl.parentNode.insertBefore(errorEl, statusEl.nextSibling);

    function showSaved(data) {
      while (savedEl.firstChild) savedEl.removeChild(savedEl.firstChild);
      var span = document.createElement("span");
      span.className = "scan-saved-text";
      span.appendChild(document.createTextNode("Saved: "));
      var b = document.createElement("strong");
      b.textContent = data.title || "";
      span.appendChild(b);
      span.appendChild(document.createTextNode("."));
      savedEl.appendChild(span);
      if (data.requests > 0) {
        var r = document.createElement("span");
        r.className = "scan-saved-requests";
        r.textContent = " " + data.requests + (data.requests === 1 ? " customer asked" : " customers asked") + " for this book. ";
        var l = document.createElement("a");
        l.href = "/admin/requests?status=matched";
        l.textContent = "See the requests";
        r.appendChild(l);
        savedEl.appendChild(r);
      }
      savedEl.hidden = false;
    }

    var CLEAR_FIELDS = ["isbn", "title", "author", "publisher", "publishedYear", "genre", "genreFr", "coverUrl", "description", "descriptionFr", "publisherPrice", "copyNotes"];
    function resetForm(keep) {
      form.reset();
      CLEAR_FIELDS.forEach(function (name) { var el = form.elements[name]; if (el) el.value = ""; });
      var cost = form.elements.acquisitionCost; if (cost) cost.value = "0";
      locationInput.value = keep.location;
      conditionSel.value = keep.condition;
      bindingSel.value = keep.binding;
      sourceSel.value = keep.source;
      var photo = form.elements.coverPhoto; if (photo) photo.value = "";
      var photoName = document.getElementById("coverPhoto-name"); if (photoName) photoName.textContent = "No photo selected";
      touched = {};
      lastResult = null;
      coverImg.hidden = true; coverImg.removeAttribute("src");
      bindingHint.textContent = "";
      errorEl.hidden = true;
      if (priceRoot) priceRoot.dispatchEvent(new CustomEvent("ps:reset"));
      conditionSel.dispatchEvent(new Event("change", { bubbles: true }));
      updateSuggestedButton();
    }

    function saveInPlace(submitter) {
      if (saving) return;
      if (inFlight) { setStatus("loading", "Wait for the lookup to finish, then save."); return; }
      if (!form.reportValidity()) return;
      saving = true;
      var keep = { location: locationInput.value, condition: conditionSel.value, binding: bindingSel.value, source: sourceSel.value };
      var savedIsbnValue = isbn.value;
      var fd = new FormData(form);
      fd.set("fast", "1");
      Array.prototype.forEach.call(form.querySelectorAll("button[name=fast]"), function (b) { b.disabled = true; });
      form.setAttribute("aria-busy", "true");
      errorEl.hidden = true;
      setStatus("loading", "Saving…");
      // On a phone the keyboard only stays up when focus moves inside this same tap:
      // put the cursor in the ISBN box now, before the save is answered.
      focusIsbn();
      var done = function () {
        saving = false;
        form.removeAttribute("aria-busy");
        Array.prototype.forEach.call(form.querySelectorAll("button[name=fast]"), function (b) { b.disabled = false; });
      };
      fetch(form.getAttribute("action"), { method: "POST", body: fd, credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(function (r) {
          return r.json().then(function (j) { return { status: r.status, body: j, redirected: r.redirected }; }, function () { return { status: r.status, body: null, redirected: r.redirected }; });
        })
        .then(function (res) {
          done();
          if (res.body && res.body.ok) {
            store(BINDING_STORE_NAME, keep.binding || "-"); store(SOURCE_STORE_NAME, keep.source || "-"); store(CONDITION_STORE_NAME, keep.condition);
            store(LOCATION_STORE_NAME, normalizeLoc(keep.location)); addLocationOption(normalizeLoc(keep.location));
            var scanned = isbn.value !== savedIsbnValue ? isbn.value : ""; // scanned while saving
            resetForm(keep);
            showSaved(res.body);
            setStatus("", "Ready for the next book: scan the barcode.");
            isbn.value = scanned || pendingIsbn || "";
            focusIsbn();
            if (isCompleteIsbn(isbn.value)) runLookup(isbn.value);
            pendingIsbn = "";
            return;
          }
          errorEl.textContent = res.body && res.body.error ? res.body.error : "The book was not saved. Your session may have ended: reload the page, sign in, and check the book list before saving again.";
          errorEl.hidden = false;
          setStatus("error", "Not saved.");
        })
        .catch(function () {
          done();
          errorEl.textContent = "No connection: the book may not have been saved. Check the book list before saving it again.";
          errorEl.hidden = false;
          setStatus("error", "Not saved.");
        });
      void submitter;
    }

    form.addEventListener("submit", function (e) {
      var sub = e.submitter;
      if (sub && sub.hasAttribute("data-scan-lookup-button")) {
        e.preventDefault();
        if (isCompleteIsbn(isbn.value)) runLookup(isbn.value);
        else setStatus("error", isbn.value.trim() ? "An ISBN has 10 or 13 digits." : "Scan or type the ISBN first.");
        return;
      }
      if (!sub) { e.preventDefault(); return; } // Enter in another field: never saves by accident
      if (inFlight || saving) { e.preventDefault(); setStatus("loading", "Wait for the lookup to finish, then save."); return; }
      if (sub.name === "fast" && sub.value === "1") { e.preventDefault(); saveInPlace(sub); }
      // "Save and open the book" is a normal form post.
    });

    // Ctrl/Cmd+Enter saves and starts the next book.
    document.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (saveNext && !saveNext.disabled) saveNext.click();
      }
    });

    // ---- scan mode
    if (scanModeBox) {
      scanModeBox.checked = recall(MODE_STORE_NAME) === "1";
      scanModeBox.addEventListener("change", function () { store(MODE_STORE_NAME, scanModeBox.checked ? "1" : ""); updateSuggestedButton(); });
    }
    // A price chosen by hand means the "suggested price" button no longer says what it does.
    if (priceRoot) {
      priceRoot.addEventListener("change", function (e) { if (e.isTrusted && saveSuggested) saveSuggested.hidden = true; });
      priceRoot.addEventListener("input", function (e) { if (e.isTrusted && saveSuggested) saveSuggested.hidden = true; });
    }

    // ---- the details are folded on a phone; a New book needs the publisher's price
    if (more && window.matchMedia && window.matchMedia("(max-width: 640px)").matches && !rootEl.hasAttribute("data-had-error")) more.open = false;
    conditionSel.addEventListener("change", function () { if (conditionSel.value === "new" && more) more.open = true; });

    // ---- the Save bar stays above the on-screen keyboard
    var vv = window.visualViewport;
    if (vv) {
      var onViewport = function () {
        document.documentElement.style.setProperty("--kb-inset", keyboardInset(window.innerHeight, vv) + "px");
      };
      vv.addEventListener("resize", onViewport);
      vv.addEventListener("scroll", onViewport);
      onViewport();
    }

    // ---- cursor in the ISBN box, on load and when the page is shown again
    focusIsbn();
    window.addEventListener("load", focusIsbn);
    window.addEventListener("pageshow", focusIsbn);
    if (savedEl && !savedEl.hidden && window.matchMedia && window.matchMedia("(pointer: coarse)").matches) {
      // Without a tap, iOS Safari shows the cursor but not the keyboard.
      setStatus("", "Ready for the next book: scan it, or tap the ISBN box to type.");
    }
  }

  return {
    isbnDigits: isbnDigits, isCompleteIsbn: isCompleteIsbn, createScanWatcher: createScanWatcher, createRequestGuard: createRequestGuard,
    planFill: planFill, resolveBindingKey: resolveBindingKey, chooseBinding: chooseBinding, lookupStatus: lookupStatus,
    canOneTapSave: canOneTapSave, keyboardInset: keyboardInset, FILL_FIELDS: FILL_FIELDS, init: init,
  };
});
