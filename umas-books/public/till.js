// The till page (/admin/till). The sale lives in this page (and in
// sessionStorage, so a reload does not lose it); the server checks everything
// again when the sale is confirmed. No inline script: the CSP forbids it.
(function () {
  "use strict";
  var root = document.getElementById("till");
  if (!root) return;
  var csrf = root.getAttribute("data-csrf");
  var token = root.getAttribute("data-token");
  var isAdmin = root.getAttribute("data-admin") === "1";
  var maxTotal = Number(root.getAttribute("data-max-total")) || 1000000;
  var $ = function (id) { return document.getElementById(id); };
  var scan = $("scan");
  var lines = []; // {key, kind, ...}
  var STORE = "till-sale-v1";
  var busy = false;
  var openModal = null;
  var cashReceived = ""; // text typed on the keypad
  var pendingPrice = null; // {line, isNew, min, max}
  var cardPaid = false; // "Card paid" was pressed: the customer HAS been charged, do not charge again
  var chargedTotal = null; // the total the card was charged for (frozen once cardPaid)
  var checkOk = false; // the last check before payment passed

  // ---------- helpers ----------
  function fmt(c) { return "€" + (c / 100).toFixed(2); }
  function parseCents(text) {
    var t = String(text).trim().replace(",", ".");
    if (!/^\d+(\.\d{0,2})?$/.test(t) || t === "") return null;
    var parts = t.split(".");
    return Number(parts[0]) * 100 + Number(((parts[1] || "") + "00").slice(0, 2));
  }
  function store(fn) { try { fn(window.sessionStorage); } catch (e) { /* storage unavailable */ } }
  function save() {
    store(function (s) {
      if (lines.length) s.setItem(STORE, JSON.stringify({ token: token, lines: lines, cardPaid: cardPaid, chargedTotal: chargedTotal }));
      else s.removeItem(STORE);
    });
  }
  function restore() {
    store(function (s) {
      var raw = s.getItem(STORE);
      if (!raw) return;
      var d = JSON.parse(raw);
      if (d && Array.isArray(d.lines) && d.lines.length && d.token) {
        lines = d.lines; token = d.token;
        if (d.cardPaid && d.chargedTotal) { cardPaid = true; chargedTotal = d.chargedTotal; }
      }
    });
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // ---------- focus: the scan box always gets the focus back ----------
  function focusScan() {
    if (openModal || !scan) return;
    if (document.activeElement !== scan) scan.focus({ preventScroll: true });
  }
  function isTextField(e) {
    return e && (e.tagName === "INPUT" || e.tagName === "TEXTAREA" || e.tagName === "SELECT");
  }
  document.addEventListener("click", function (e) {
    if (openModal) return;
    if (isTextField(e.target) || e.target.closest("summary, details.till-void")) return;
    setTimeout(focusScan, 0);
  });
  scan.addEventListener("blur", function () {
    setTimeout(function () { if (!openModal && !isTextField(document.activeElement) && !document.activeElement.closest("details")) focusScan(); }, 50);
  });
  setInterval(function () { if (!openModal && !isTextField(document.activeElement) && !document.activeElement.closest("details")) focusScan(); }, 1500);
  $("toggle-keyboard").addEventListener("click", function () {
    var on = scan.getAttribute("inputmode") === "none";
    scan.setAttribute("inputmode", on ? "text" : "none");
    this.setAttribute("aria-pressed", on ? "true" : "false");
    scan.blur(); scan.focus();
  });

  // ---------- messages and beep ----------
  var beepBox = $("beep");
  store(function () { try { var v = window.localStorage.getItem("till-beep"); if (v === "0") beepBox.checked = false; } catch (e) { /* */ } });
  beepBox.addEventListener("change", function () { try { window.localStorage.setItem("till-beep", beepBox.checked ? "1" : "0"); } catch (e) { /* */ } });
  var audio = null;
  function beep() {
    if (!beepBox.checked) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      var o = audio.createOscillator(), g = audio.createGain();
      o.type = "square"; o.frequency.value = 220; g.gain.value = 0.15;
      o.connect(g); g.connect(audio.destination);
      o.start(); o.stop(audio.currentTime + 0.35);
    } catch (e) { /* no audio */ }
  }
  var msg = $("till-msg");
  function showError(text) {
    msg.textContent = text; msg.hidden = false; msg.className = "till-msg till-msg-error";
    beep();
  }
  function showInfo(text) { msg.textContent = text; msg.hidden = false; msg.className = "till-msg till-msg-ok"; }
  function clearMsg() { msg.hidden = true; msg.textContent = ""; }
  // A short note above everything (modals included).
  var toastTimer = null;
  function toast(text) {
    var t = $("till-toast");
    if (!t) {
      t = el("div", "till-toast"); t.id = "till-toast";
      t.setAttribute("role", "status"); t.setAttribute("aria-live", "polite");
      t.style.position = "fixed"; t.style.left = "50%"; t.style.top = "16px"; t.style.transform = "translateX(-50%)";
      t.style.zIndex = "2000"; t.style.background = "#7a1f1f"; t.style.color = "#fff"; t.style.padding = "12px 20px";
      t.style.borderRadius = "8px"; t.style.fontWeight = "700"; t.style.boxShadow = "0 4px 16px rgba(0,0,0,.3)";
      document.body.appendChild(t);
    }
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
    beep();
  }

  // ---------- modals ----------
  function show(id) {
    var m = $(id);
    m.hidden = false; openModal = m;
    if (id === "cash-modal" || id === "card-modal") {
      // No button gets the focus: a scanner's Enter would press it. The box itself takes it.
      var box = m.querySelector(".till-modal-box");
      box.setAttribute("tabindex", "-1");
      setTimeout(function () { box.focus(); }, 0);
      return;
    }
    var first = m.querySelector("input:not([type=hidden]), button.till-big, button");
    if (first) setTimeout(function () { first.focus(); }, 0);
  }
  function hide() {
    if (!openModal) return;
    openModal.hidden = true; openModal = null;
    setTimeout(focusScan, 0);
  }
  Array.prototype.forEach.call(root.querySelectorAll("[data-close]"), function (b) { b.addEventListener("click", hide); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && openModal && openModal.id !== "done") hide(); });

  // ---------- the sale ----------
  function total() { return lines.reduce(function (a, l) { return a + l.priceCents * (l.quantity || 1); }, 0); }
  function priceKnown(l) { return l.priceCents !== null && l.priceCents !== undefined; }

  function render() {
    var ul = $("lines");
    ul.textContent = "";
    lines.forEach(function (l) {
      var li = el("li", "till-line" + (priceKnown(l) ? "" : " till-line-needs"));
      var main = el("div", "till-line-main");
      main.appendChild(el("strong", "till-line-title", l.title || l.description));
      var meta = el("span", "till-line-meta");
      if (l.kind === "book") {
        meta.appendChild(el("span", "till-grade", l.conditionLabel));
        if (l.authors) meta.appendChild(el("span", "", l.authors));
        meta.appendChild(el("span", "muted", "UB-" + l.copyId));
        if (l.reserved) meta.appendChild(el("span", "till-grade", "Reservation #" + l.orderId));
      } else if (l.kind === "seat") {
        meta.appendChild(el("span", "till-grade", "Drop-in seat, reservation #" + l.orderId));
      } else {
        meta.appendChild(el("span", "till-grade", l.kind === "quick" ? "Quick item" : "Manual item"));
      }
      main.appendChild(meta);
      li.appendChild(main);
      if (l.kind !== "book" && l.kind !== "seat") {
        var step = el("span", "till-step");
        var minus = el("button", "btn btn-outline till-step-btn", "-"); minus.type = "button"; minus.setAttribute("aria-label", "One less " + l.description);
        var plus = el("button", "btn btn-outline till-step-btn", "+"); plus.type = "button"; plus.setAttribute("aria-label", "One more " + l.description);
        minus.addEventListener("click", function () { if (l.quantity > 1) { l.quantity -= 1; render(); } });
        plus.addEventListener("click", function () {
          if (l.quantity >= 99 || (l.stock !== null && l.stock !== undefined && l.quantity + 1 > l.stock)) { showError("No more of \"" + l.description + "\" can be added."); return; }
          l.quantity += 1; render();
        });
        step.appendChild(minus); step.appendChild(el("span", "till-qty", String(l.quantity))); step.appendChild(plus);
        li.appendChild(step);
      }
      var priceBtn = el("button", "btn btn-outline till-line-price", priceKnown(l) ? fmt(l.priceCents * (l.quantity || 1)) : "Set price");
      priceBtn.type = "button";
      if (l.kind === "book" && !l.reserved) {
        priceBtn.addEventListener("click", function () { askPrice(l); });
        if (l.overridden) priceBtn.title = "Price changed from " + fmt(l.askingCents);
        if (l.overridden) priceBtn.classList.add("till-overridden");
      } else priceBtn.disabled = true;
      li.appendChild(priceBtn);
      var rm = el("button", "btn btn-outline till-line-remove", "Remove");
      rm.type = "button"; rm.setAttribute("aria-label", "Remove " + (l.title || l.description));
      rm.addEventListener("click", function () { lines = lines.filter(function (x) { return x !== l; }); render(); });
      li.appendChild(rm);
      ul.appendChild(li);
    });
    var sum = total();
    var allPriced = lines.every(priceKnown);
    $("total").textContent = fmt(sum);
    $("lines-status").textContent = lines.length ? lines.length + (lines.length === 1 ? " line" : " lines") + " on the sale, total " + fmt(sum) : "The sale is empty";
    $("empty").hidden = lines.length > 0;
    $("pay-cash").disabled = !(lines.length && allPriced && sum > 0 && sum <= maxTotal);
    if (sum > maxTotal) showError("Sale total too large: the most the till takes in one sale is " + fmt(maxTotal) + ".");
    $("pay-card").disabled = $("pay-cash").disabled;
    $("clear").disabled = !lines.length;
    save();
  }

  function addLine(line) {
    line.key = String(Date.now()) + Math.random();
    lines.push(line);
    render();
    if (line.kind === "book" && !priceKnown(line)) askPrice(line);
  }

  // ---------- price override (used books) / new books within 95-100% ----------
  function askPrice(line) {
    pendingPrice = line;
    $("price-title").textContent = line.title;
    var hint = line.isNew
      ? "New book: sold at the publisher's price (" + fmt(line.publisherPriceCents) + "), at most 5% off: between " + fmt(Math.ceil(line.publisherPriceCents * 0.95)) + " and " + fmt(line.publisherPriceCents) + "."
      : (line.askingCents != null ? "Asking price " + fmt(line.askingCents) + ". Change it only if you agreed another price." : "This copy has no price yet: enter the price.");
    $("price-hint").textContent = hint;
    $("price-input").value = priceKnown(line) ? (line.priceCents / 100).toFixed(2) : "";
    $("price-reason").value = line.reason || "";
    $("price-reason-label").textContent = "Reason (required if lower than the asking price or more than 20% above it)";
    $("price-error").hidden = true;
    show("price-modal");
    $("price-input").select();
  }
  $("price-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var l = pendingPrice;
    var c = parseCents($("price-input").value);
    var err = $("price-error");
    var bad = null;
    if (c === null) bad = "Enter the price as a number, like 4.50.";
    else if (l.isNew && (c * 100 < 95 * l.publisherPriceCents || c > l.publisherPriceCents)) bad = "A new book must be between " + fmt(Math.ceil(l.publisherPriceCents * 0.95)) + " and " + fmt(l.publisherPriceCents) + " (French fixed book price law).";
    else if (c <= 0) bad = "Enter a price above 0 (a book is never free at the till).";
    else if (l.askingCents != null && c !== l.askingCents) {
      // Same rule as the server: lower than the asking price, or more than 20% above it, needs a reason and an admin.
      if (c < l.askingCents || c * 100 > l.askingCents * 120) {
        if (!isAdmin) bad = "Only an admin can change the price like this (lower than the asking price, or more than 20% above it).";
        else if ($("price-reason").value.trim().length < 3) bad = "Give a reason for this price (it is kept in the activity log).";
      }
    }
    if (bad) { err.textContent = bad; err.hidden = false; return; }
    l.priceCents = c;
    l.overridden = l.askingCents != null && c !== l.askingCents;
    l.reason = l.overridden ? $("price-reason").value.trim() : "";
    hide(); render();
  });

  // ---------- scanning ----------
  var queue = Promise.resolve();
  function post(url, fields) {
    var body = new URLSearchParams();
    body.set("_csrf", csrf);
    Object.keys(fields).forEach(function (k) { body.set(k, fields[k]); });
    // Resolves { status, json } where json is null when the answer was not JSON (an HTML error
    // page, a redirect to the login page). REJECTS only when the request never got an answer
    // (a network failure): that is the one case where pressing the button again is safe
    // because the sale token makes a second try harmless.
    return fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" }, body: body.toString() })
      .then(function (r) {
        return r.text().then(function (t) {
          var j = null;
          try { j = JSON.parse(t); } catch (e) { j = null; }
          // The admin session ended (8 hours idle or 7 days): say so loudly and keep the sale.
          if (r.status === 401 && j && j.error === "session_expired") { showSessionEnded(j.loginUrl); j = null; }
          return { status: r.status, json: j, redirected: r.redirected };
        });
      });
  }
  function haveIds() { return lines.filter(function (l) { return l.kind === "book"; }).map(function (l) { return l.copyId; }); }

  function chooseCopy(copies) {
    var list = $("picker-list");
    list.textContent = "";
    copies.forEach(function (c) {
      var b = el("button", "btn btn-outline till-pick");
      b.type = "button";
      b.appendChild(el("strong", "", c.priceCents != null ? fmt(c.priceCents) : "No price"));
      b.appendChild(el("span", "", c.conditionLabel));
      b.appendChild(el("span", "muted", c.location ? "Location " + c.location : "No location"));
      b.appendChild(el("span", "muted", "UB-" + c.copyId));
      b.addEventListener("click", function () { hide(); addBook(c); });
      list.appendChild(b);
    });
    $("picker-title").textContent = copies[0].title + ": several copies in stock, which one?";
    show("picker");
  }
  function addBook(line) {
    if (lines.some(function (l) { return l.kind === "book" && l.copyId === line.copyId; })) { showError("\"" + line.title + "\" is already on this sale."); return; }
    line.askingCents = line.priceCents;
    addLine(line);
    showInfo("Added: " + line.title);
  }

  // A reservation to collect (ORDER-<n>, or the label of a book it holds): all its
  // lines go on the sale at the reserved prices. Remove a line to leave it reserved
  // (a partial pickup).
  function addReservation(j) {
    var fresh = j.lines.filter(function (l) {
      return !lines.some(function (x) { return x.reserved && x.orderId === l.orderId && x.itemId === l.itemId; });
    });
    if (!fresh.length) { showError("Reservation #" + j.order.id + " is already on this sale."); return; }
    fresh.forEach(function (l) {
      l.key = String(Date.now()) + Math.random();
      if (l.kind === "book") l.askingCents = l.priceCents;
      lines.push(l);
    });
    render();
    showInfo("Reservation #" + j.order.id + " for " + j.order.name + ": " + fresh.length + " item(s). Remove what the customer leaves, then take payment.");
  }

  function handleScan(code) {
    code = String(code).trim();
    if (!code) return Promise.resolve();
    clearMsg();
    return post("/admin/till/scan", { code: code, have: JSON.stringify(haveIds()) }).then(function (r) {
      var j = r.json;
      if (!j) { showError(sessionProblem(r)); return; }
      if (j.type === "line") addBook(j.line);
      else if (j.type === "choose") chooseCopy(j.copies);
      else if (j.type === "quick") addQuick(j.item);
      else if (j.type === "reservation") addReservation(j);
      else if (j.type === "expired_cart") askRelease(j);
      else showError(j.message || "That code could not be read.");
    }).catch(function () { showError("Connection problem: the scan did not go through. Scan again."); });
  }
  // A copy sitting in an online cart whose hold has run out: offer to release it and add it.
  function askRelease(j) {
    var list = $("picker-list");
    list.textContent = "";
    list.appendChild(el("p", "", j.message));
    var b = el("button", "btn till-btn", "Release this copy from the expired cart and add it");
    b.type = "button";
    b.addEventListener("click", function () {
      b.disabled = true;
      post("/admin/till/release", { copyId: String(j.line.copyId) }).then(function (r) {
        hide();
        if (r.json && r.json.type === "line") { addBook(r.json.line); return; }
        showError(sessionProblem(r) || (r.json && r.json.error) || "That copy could not be released.");
      }).catch(function () { hide(); showError("Connection problem: nothing was released. Scan again."); });
    });
    list.appendChild(b);
    $("picker-title").textContent = "This copy is in an expired cart";
    show("picker");
  }
  // A banner that stays until dismissed. The login opens in a NEW tab so this page, and the
  // sale on it, stay put; the sale is also kept in sessionStorage. The page's CSRF token belonged
  // to the old session, so "I have logged in" fetches a fresh one before the next request.
  function showSessionEnded(loginUrl) {
    if ($("till-signed-out")) return;
    var b = el("div", "till-msg till-msg-error"); b.id = "till-signed-out";
    b.setAttribute("role", "alert");
    b.style.position = "fixed"; b.style.left = "0"; b.style.right = "0"; b.style.top = "0"; b.style.zIndex = "2100";
    b.style.padding = "14px 20px"; b.style.fontWeight = "700"; b.style.textAlign = "center";
    b.appendChild(el("span", "", "Signed out: your session ended. The sale on the screen is kept; if the customer already paid by card, do not charge again. "));
    var a = el("a", "", "Log in again (opens a new tab)");
    a.href = /^\/[^/\\]/.test(loginUrl || "") ? loginUrl : "/login?returnTo=%2Fadmin%2Ftill";
    a.target = "_blank"; a.rel = "noopener"; a.style.color = "inherit"; a.style.textDecoration = "underline";
    b.appendChild(a);
    var done = el("button", "btn btn-outline", "I have logged in: continue");
    done.type = "button"; done.style.marginLeft = "12px";
    done.addEventListener("click", function () {
      fetch("/api/csrf-token", { credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(function (r) { return r.json(); })
        .then(function (j) { if (j && j.token) csrf = j.token; b.remove(); showInfo("Back online. Scan again, or continue the sale."); })
        .catch(function () { showError("Connection problem. Try again."); });
    });
    b.appendChild(done);
    document.body.appendChild(b);
    beep();
  }
  // A reply that is not the till's JSON: the till session ended, or the server failed.
  function sessionProblem(r) {
    if (r.json) return null;
    if (r.redirected || r.status === 401 || r.status === 403) return "Signed out: log in again (the link at the top of the screen). The sale on the screen is kept.";
    return "The server had a problem (error " + r.status + "). Nothing was confirmed.";
  }
  $("scan-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var code = scan.value;
    scan.value = "";
    if (openModal) { toast("Finish or cancel this payment first"); return; }
    queue = queue.then(function () { return handleScan(code); });
    focusScan();
  });

  // ---------- quick items and manual items ----------
  // One more unit of a quick item (tap, or its barcode scanned). stock: number or "" / null (not counted).
  function addQuick(it) {
    var existing = lines.filter(function (l) { return l.kind === "quick" && l.quickId === it.id; })[0];
    var have = existing ? existing.quantity : 0;
    var stock = it.stock === "" || it.stock === null || it.stock === undefined ? null : Number(it.stock);
    if (stock !== null && have + 1 > stock) { showError("No more \"" + it.name + "\" in stock."); return; }
    clearMsg();
    if (existing) { existing.quantity += 1; existing.stock = stock; render(); }
    else addLine({ kind: "quick", quickId: it.id, description: it.name, quantity: 1, priceCents: it.priceCents, stock: stock });
  }
  Array.prototype.forEach.call(root.querySelectorAll("[data-quick]"), function (b) {
    b.addEventListener("click", function () {
      addQuick({ id: Number(b.getAttribute("data-quick")), name: b.getAttribute("data-name"), priceCents: Number(b.getAttribute("data-price")), stock: b.getAttribute("data-stock") });
    });
  });
  $("manual-open").addEventListener("click", function () {
    $("manual-error").hidden = true; $("manual-form").reset(); show("manual-modal"); $("manual-desc").focus();
  });
  $("manual-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var d = $("manual-desc").value.trim().replace(/\s+/g, " ");
    var c = parseCents($("manual-price").value);
    var q = Number($("manual-qty").value);
    var err = $("manual-error"), bad = null;
    if (!d) bad = "Enter a description.";
    else if (d.length > 80) bad = "The description is limited to 80 characters.";
    else if (c === null || (c <= 0 && $("manual-cat").value !== "donation")) bad = "Enter a price above 0, like 2.50 (only a Donation line can be 0).";
    else if (!(q >= 1 && q <= 99 && Math.floor(q) === q)) bad = "Quantity must be a whole number from 1 to 99.";
    if (bad) { err.textContent = bad; err.hidden = false; return; }
    hide();
    addLine({ kind: "manual", description: d, quantity: q, priceCents: c, category: $("manual-cat").value });
  });

  // ---------- clear ----------
  $("clear").addEventListener("click", function () {
    if (!lines.length) return;
    if (window.confirm("Clear the whole sale? The books stay in stock.")) { lines = []; clearMsg(); render(); focusScan(); }
  });

  // ---------- payment ----------
  // Every confirm carries what the screen showed (expectedTotalCents and each line's price):
  // the server refuses, and records NOTHING, if a price changed in between, so the amount
  // charged on the card reader can never differ from the amount recorded.
  var current = { method: null, box: null, reopen: null };

  function payload(method, extra) {
    var items = lines.map(function (l) {
      if (l.reserved) return { kind: "reserved", orderId: l.orderId, itemId: l.itemId, expected: l.priceCents };
      if (l.kind === "book") return { kind: "book", copyId: l.copyId, price: l.overridden || !l.askingCents ? (l.priceCents / 100).toFixed(2) : "", reason: l.reason || "", expected: l.priceCents };
      if (l.kind === "quick") return { kind: "quick", id: l.quickId, quantity: l.quantity, expected: l.priceCents };
      return { kind: "manual", description: l.description, price: (l.priceCents / 100).toFixed(2), quantity: l.quantity, category: l.category, expected: l.priceCents };
    });
    // A new book is always sent with its price (the server checks 95-100%).
    lines.forEach(function (l, i) { if (l.kind === "book" && l.isNew && !l.reserved) items[i].price = (l.priceCents / 100).toFixed(2); });
    var soldAt = $("sold-at"), soldDay = $("sold-at-day"), why = $("backdate-reason");
    var f = {
      token: token, method: method, items: JSON.stringify(items),
      expectedTotalCents: String(cardPaid && chargedTotal ? chargedTotal : total()),
      soldAtTime: soldAt ? soldAt.value || "" : "", soldAtDay: soldDay ? soldDay.value : "today", backdateReason: why ? why.value.trim() : "",
    };
    var rb = current.reopen;
    if (rb) {
      var tick = rb.querySelector("[data-reopen-tick]"), rs = rb.querySelector("[data-reopen-reason]");
      if (tick && tick.checked) { f.reopen = "1"; f.reopenReason = rs ? rs.value.trim() : ""; }
    }
    Object.keys(extra || {}).forEach(function (k) { f[k] = extra[k]; });
    return f;
  }

  // Shows what the server (or the network) said, in `box`. Returns true when the sale
  // cannot go on until something is fixed.
  function explain(r, box, method) {
    var j = r.json;
    var msgText;
    if (!j) msgText = sessionProblem(r);
    else if (j.serverError) msgText = j.error;
    else msgText = j.error || "The sale was not recorded.";
    if (j && j.code === "price_changed") {
      msgText = "The price changed: new total " + fmt(j.newTotalCents) + "." + (method === "card" ? " For a card sale do not charge again: cancel the card charge on the reader and restart." : " Restart the sale to see the new prices.");
    }
    box.textContent = msgText; box.hidden = false;
    var rb = current.reopen;
    if (rb) rb.hidden = !(j && j.code === "day_closed");
    var restart = $(method === "card" ? "card-restart" : "cash-restart");
    if (restart) restart.hidden = !(j && j.code === "price_changed");
    beep();
  }

  // Before the customer pays: the same checks as the sale, writing nothing.
  function runCheck(method, box, confirmBtn) {
    box.hidden = true; checkOk = false; confirmBtn.disabled = true;
    return post("/admin/till/check", payload(method, {})).then(function (r) {
      if (r.json && r.json.ok) { checkOk = true; confirmBtn.disabled = false; if (method === "cash") updateCash(); return true; }
      explain(r, box, method);
      return false;
    }).catch(function () {
      box.textContent = "Connection problem: the sale could not be checked. Close this screen and try again."; box.hidden = false; beep();
      return false;
    });
  }

  function submitSale(method, extra, errBox, button) {
    if (busy) return;
    busy = true; button.disabled = true;
    errBox.hidden = true;
    var charged = method === "card" && cardPaid;
    post("/admin/till/sale", payload(method, extra)).then(function (r) {
      busy = false;
      if (r.json && r.json.ok) return done(r.json);
      button.disabled = false;
      if (method === "card") cardUi(); // shows the red "already charged" box once "Card paid" was pressed
      explain(r, errBox, method);
    }).catch(function () {
      // No answer at all: the sale token makes pressing the button again safe.
      busy = false; button.disabled = false;
      if (method === "card") cardUi();
      errBox.textContent = charged
        ? "Connection problem. The card was already charged: do NOT charge again. Press Record card sale again: the sale cannot be recorded twice."
        : "Connection problem. Press the button again: the sale cannot be recorded twice.";
      errBox.hidden = false; beep();
    });
  }

  function done(j) {
    cardPaid = false; chargedTotal = null;
    store(function (s) { s.removeItem(STORE); });
    lines = [];
    hide();
    $("done-total").textContent = fmt(j.totalCents);
    var cr = $("done-change-row");
    cr.hidden = j.changeCents === null || j.changeCents === undefined;
    $("done-change").textContent = j.changeCents == null ? "" : fmt(j.changeCents);
    $("receipt").setAttribute("href", j.receiptUrl);
    show("done");
    $("next").focus();
    if ($("auto-next").checked) autoTimer = setTimeout(next, 10000);
  }
  var autoTimer = null;
  function next() { clearTimeout(autoTimer); window.location.href = "/admin/till"; }
  $("next").addEventListener("click", next);
  $("auto-next").addEventListener("change", function () { if (!this.checked) clearTimeout(autoTimer); });

  // Reopen-the-day box (admins): a change re-runs the check.
  Array.prototype.forEach.call(root.querySelectorAll("[data-reopen]"), function (rb) {
    var recheck = function () { if (current.method === "cash") startCash(false); else if (current.method === "card") startCard(false); };
    var tick = rb.querySelector("[data-reopen-tick]"), rs = rb.querySelector("[data-reopen-reason]");
    if (tick) tick.addEventListener("change", recheck);
    if (rs) rs.addEventListener("change", function () { if (tick && tick.checked) recheck(); });
  });

  // Cash
  function updateCash() {
    var t = total();
    var rec = parseCents(cashReceived === "" ? "0" : cashReceived);
    $("cash-total").textContent = fmt(t);
    $("cash-received").textContent = rec === null ? "?" : fmt(rec);
    var ok = rec !== null && rec >= t;
    $("cash-change").textContent = ok ? fmt(rec - t) : fmt(0);
    $("cash-note").textContent = rec === null ? "Enter a number." : (ok ? "" : "Still to pay: " + fmt(t - rec));
    $("cash-confirm").disabled = !ok || busy || !checkOk;
  }
  function startCash(fresh) {
    current.method = "cash"; current.box = $("cash-check"); current.reopen = $("cash-modal").querySelector("[data-reopen]");
    if (fresh) { cashReceived = ""; $("cash-error").hidden = true; $("cash-restart").hidden = true; if (current.reopen) current.reopen.hidden = true; show("cash-modal"); }
    updateCash();
    runCheck("cash", $("cash-check"), $("cash-confirm"));
  }
  $("pay-cash").addEventListener("click", function () { startCash(true); });
  function key(k) {
    if (k === "C") cashReceived = "";
    else if (k === "⌫") cashReceived = cashReceived.slice(0, -1);
    else if (k === ".") { if (cashReceived.indexOf(".") < 0) cashReceived += cashReceived === "" ? "0." : "."; }
    else if (/^\d$/.test(k)) { if (!/\.\d\d$/.test(cashReceived) && cashReceived.length < 8) cashReceived += k; }
    updateCash();
  }
  Array.prototype.forEach.call(root.querySelectorAll("[data-key]"), function (b) { b.addEventListener("click", function () { key(b.getAttribute("data-key")); }); });
  Array.prototype.forEach.call(root.querySelectorAll("[data-amount]"), function (b) {
    b.addEventListener("click", function () {
      var a = b.getAttribute("data-amount");
      var c = a === "exact" ? total() : Number(a);
      cashReceived = (c / 100).toFixed(2); updateCash();
    });
  });

  // Keys while a payment screen is open. A barcode scanner types its code in a burst (keys a
  // few milliseconds apart) and presses Enter: neither may reach the keypad, and Enter can
  // never confirm a payment (confirming needs a tap or a click on the button).
  var BURST_MS = 40;
  var lastKeyAt = 0, inBurst = false, beforeLast = "";
  document.addEventListener("keydown", function (e) {
    if (!openModal) { lastKeyAt = 0; inBurst = false; return; }
    var now = e.timeStamp || Date.now();
    var gap = now - lastKeyAt;
    lastKeyAt = now;
    if (isTextField(e.target)) return;
    var isCash = openModal.id === "cash-modal";
    if (e.key === "Enter") { e.preventDefault(); if (inBurst) { inBurst = false; } return; }
    if (e.key === "Escape" || e.key === "Tab" || e.key.length > 1 && e.key !== "Backspace") return;
    if (gap < BURST_MS) {
      // Second key of a burst: it is a scanner. Take back the first one (it already went in).
      if (!inBurst) { inBurst = true; if (isCash) { cashReceived = beforeLast; updateCash(); } toast("Finish or cancel this payment first"); }
      e.preventDefault();
      return;
    }
    inBurst = false;
    if (!isCash) return;
    beforeLast = cashReceived;
    if (/^[0-9.,]$/.test(e.key)) { key(e.key === "," ? "." : e.key); e.preventDefault(); }
    else if (e.key === "Backspace") { key("⌫"); e.preventDefault(); }
  }, true);
  $("cash-confirm").addEventListener("click", function (e) {
    if (e.detail === 0) return; // a keyboard "click" (a scanner's Enter): never confirms
    // "20." is 20: the trailing dot of the keypad is dropped.
    var rec = cashReceived === "" ? "0" : cashReceived.replace(/[.,]$/, "");
    submitSale("cash", { received: rec }, $("cash-error"), this);
  });

  // Card (manual: charge the SumUp reader, then press Card paid)
  function cardUi() {
    $("card-confirm").textContent = cardPaid ? "Record card sale" : "Card paid";
    $("card-anyway").hidden = !cardPaid;
    $("card-charged").hidden = !cardPaid;
    var t = cardPaid && chargedTotal ? chargedTotal : total();
    $("card-text").textContent = cardPaid
      ? "The card was charged " + fmt(t) + ". Record the sale now."
      : "Charge " + fmt(t) + " on the SumUp reader, then press Card paid.";
  }
  function startCard(fresh) {
    current.method = "card"; current.box = $("card-check"); current.reopen = $("card-modal").querySelector("[data-reopen]");
    if (fresh) {
      $("card-ref").value = ""; $("card-error").hidden = true; $("card-restart").hidden = true;
      if (current.reopen) current.reopen.hidden = true;
      show("card-modal");
    }
    cardUi();
    runCheck("card", $("card-check"), $("card-confirm"));
  }
  $("pay-card").addEventListener("click", function () { startCard(true); });
  $("card-confirm").addEventListener("click", function (e) {
    if (e.detail === 0) return;
    var btn = this;
    var go = function () {
      if (!cardPaid) { cardPaid = true; chargedTotal = total(); save(); }
      submitSale("card", { cardConfirmed: "1", cardReference: $("card-ref").value.trim() }, $("card-error"), btn);
    };
    // After "Card paid" failed once, check again first and show the reason; a first press goes straight on.
    if (cardPaid) {
      runCheck("card", $("card-check"), btn).then(function (ok) { if (ok) { cardUi(); go(); } else { $("card-charged").hidden = false; btn.disabled = false; } });
    } else go();
  });
  // Record anyway: the same sale token and the same total, without the check in front (for when the
  // check itself fails but the server can still record it).
  $("card-anyway").addEventListener("click", function (e) {
    if (e.detail === 0) return;
    submitSale("card", { cardConfirmed: "1", cardReference: $("card-ref").value.trim() }, $("card-error"), $("card-confirm"));
  });
  $("card-back").addEventListener("click", function () {
    if (cardPaid && !window.confirm("The card was already charged. Do NOT charge again. Leave this screen without recording the sale?")) return;
    hide();
  });
  // Restart after a price change: forget the sale on the screen and scan again.
  Array.prototype.forEach.call(root.querySelectorAll("[data-restart]"), function (b) {
    b.addEventListener("click", function () {
      cardPaid = false; chargedTotal = null; lines = [];
      store(function (s) { s.removeItem(STORE); });
      window.location.href = "/admin/till";
    });
  });

  restore();
  render();
  if (cardPaid && lines.length) startCard(true); // the page was reloaded after "Card paid": carry on
  focusScan();
})();
