// The till page (/admin/till). The sale lives in this page (and in
// sessionStorage, so a reload does not lose it); the server checks everything
// again when the sale is confirmed. No inline script: the CSP forbids it.
(function () {
  "use strict";
  var root = document.getElementById("till");
  if (!root) return;
  var csrf = root.getAttribute("data-csrf");
  var token = root.getAttribute("data-token");
  var $ = function (id) { return document.getElementById(id); };
  var scan = $("scan");
  var lines = []; // {key, kind, ...}
  var STORE = "till-sale-v1";
  var busy = false;
  var openModal = null;
  var cashReceived = ""; // text typed on the keypad
  var pendingPrice = null; // {line, isNew, min, max}

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
      if (lines.length) s.setItem(STORE, JSON.stringify({ token: token, lines: lines }));
      else s.removeItem(STORE);
    });
  }
  function restore() {
    store(function (s) {
      var raw = s.getItem(STORE);
      if (!raw) return;
      var d = JSON.parse(raw);
      if (d && Array.isArray(d.lines) && d.lines.length && d.token) { lines = d.lines; token = d.token; }
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

  // ---------- modals ----------
  function show(id) {
    var m = $(id);
    m.hidden = false; openModal = m;
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
        var chip = el("span", "sticker-chip", l.color.label);
        chip.style.background = l.color.hex; chip.style.color = l.color.text;
        if (l.color.border) chip.style.borderColor = l.color.border;
        meta.appendChild(chip);
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
    $("empty").hidden = lines.length > 0;
    $("pay-cash").disabled = !(lines.length && allPriced && sum > 0);
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
    else if (!l.isNew && c <= 0) bad = "Enter a price above 0.";
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
    return fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" }, body: body.toString() })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, json: j }; }); });
  }
  function haveIds() { return lines.filter(function (l) { return l.kind === "book"; }).map(function (l) { return l.copyId; }); }

  function chooseCopy(copies) {
    var list = $("picker-list");
    list.textContent = "";
    copies.forEach(function (c) {
      var b = el("button", "btn btn-outline till-pick");
      b.type = "button";
      var chip = el("span", "sticker-chip", c.color.label);
      chip.style.background = c.color.hex; chip.style.color = c.color.text;
      if (c.color.border) chip.style.borderColor = c.color.border;
      b.appendChild(el("strong", "", c.priceCents != null ? fmt(c.priceCents) : "No price"));
      b.appendChild(chip);
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
      if (j.type === "line") addBook(j.line);
      else if (j.type === "choose") chooseCopy(j.copies);
      else if (j.type === "quick") addQuick(j.item);
      else if (j.type === "reservation") addReservation(j);
      else showError(j.message || "That code could not be read.");
    }).catch(function () { showError("Connection problem: the scan did not go through. Scan again."); });
  }
  $("scan-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var code = scan.value;
    scan.value = "";
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
    else if (c === null || c <= 0) bad = "Enter a price above 0, like 2.50.";
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
  function payload(method, extra) {
    var items = lines.map(function (l) {
      if (l.reserved) return { kind: "reserved", orderId: l.orderId, itemId: l.itemId };
      if (l.kind === "book") return { kind: "book", copyId: l.copyId, price: l.overridden || !l.askingCents ? (l.priceCents / 100).toFixed(2) : "", reason: l.reason || "" };
      if (l.kind === "quick") return { kind: "quick", id: l.quickId, quantity: l.quantity };
      return { kind: "manual", description: l.description, price: (l.priceCents / 100).toFixed(2), quantity: l.quantity, category: l.category };
    });
    // A new book is always sent with its price (the server checks 95-100%).
    lines.forEach(function (l, i) { if (l.kind === "book" && l.isNew && !l.reserved) items[i].price = (l.priceCents / 100).toFixed(2); });
    var f = { token: token, method: method, items: JSON.stringify(items), soldAtTime: $("sold-at").value || "" };
    Object.keys(extra || {}).forEach(function (k) { f[k] = extra[k]; });
    return f;
  }

  function submitSale(method, extra, errBox, button) {
    if (busy) return;
    busy = true; button.disabled = true;
    errBox.hidden = true;
    post("/admin/till/sale", payload(method, extra)).then(function (r) {
      busy = false;
      if (r.json.ok) return done(r.json);
      button.disabled = false;
      errBox.textContent = r.json.error || "The sale was not recorded."; errBox.hidden = false;
      beep();
    }).catch(function () {
      busy = false; button.disabled = false;
      errBox.textContent = "Connection problem. Press the button again: the sale cannot be recorded twice.";
      errBox.hidden = false; beep();
    });
  }

  function done(j) {
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

  // Cash
  function updateCash() {
    var t = total();
    var rec = parseCents(cashReceived === "" ? "0" : cashReceived);
    $("cash-total").textContent = fmt(t);
    $("cash-received").textContent = rec === null ? "?" : fmt(rec);
    var ok = rec !== null && rec >= t;
    $("cash-change").textContent = ok ? fmt(rec - t) : fmt(0);
    $("cash-note").textContent = rec === null ? "Enter a number." : (ok ? "" : "Still to pay: " + fmt(t - rec));
    $("cash-confirm").disabled = !ok || busy;
  }
  $("pay-cash").addEventListener("click", function () { cashReceived = ""; $("cash-error").hidden = true; show("cash-modal"); updateCash(); $("cash-confirm").blur(); });
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
  document.addEventListener("keydown", function (e) {
    if (!openModal || openModal.id !== "cash-modal" || isTextField(e.target)) return;
    if (/^[0-9.,]$/.test(e.key)) { key(e.key === "," ? "." : e.key); e.preventDefault(); }
    else if (e.key === "Backspace") { key("⌫"); e.preventDefault(); }
    else if (e.key === "Enter" && !$("cash-confirm").disabled) { $("cash-confirm").click(); e.preventDefault(); }
  });
  $("cash-confirm").addEventListener("click", function () {
    submitSale("cash", { received: cashReceived === "" ? "0" : cashReceived }, $("cash-error"), this);
  });

  // Card (manual: charge the SumUp reader, then press Card paid)
  $("pay-card").addEventListener("click", function () {
    $("card-text").textContent = "Charge " + fmt(total()) + " on the SumUp reader, then press Card paid.";
    $("card-ref").value = ""; $("card-error").hidden = true; show("card-modal");
    $("card-confirm").focus();
  });
  $("card-confirm").addEventListener("click", function () {
    submitSale("card", { cardConfirmed: "1", cardReference: $("card-ref").value.trim() }, $("card-error"), this);
  });

  restore();
  render();
  focusScan();
})();
