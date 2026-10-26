// The "← Back" link in partials/header.ejs and partials/admin_header.ejs
// used to run history.back() from an inline onclick attribute, which the
// app's CSP (script-src-attr 'none', set in src/index.js) silently
// blocks — every click did nothing. Delegated here instead, since this
// script loads on both the public dynamic pages and the admin panel.
document.addEventListener("click", function (e) {
  var backLink = e.target.closest(".site-back-link, .admin-back-link");
  if (backLink) {
    // The public "Back" links are real links (to the home page), so they
    // still work without JavaScript or when the page was opened directly
    // (no earlier page of ours to go back to). With history, go back.
    var hasHistory = history.length > 1 && document.referrer && document.referrer.indexOf(location.origin) === 0;
    if (hasHistory || backLink.getAttribute("href") === "#") {
      e.preventDefault();
      history.back();
    }
  }
});

// Destructive-action confirmations. The admin forms used to carry an inline
// onsubmit="return confirm(...)", which the app's CSP (script-src-attr
// 'none') silently blocks — so the buttons submitted with no confirmation
// at all. A form now declares data-confirm="message"; this one delegated
// capture-phase listener asks, and cancels the submit if declined.
document.addEventListener("submit", function (e) {
  var form = e.target;
  var message = form && form.getAttribute ? form.getAttribute("data-confirm") : null;
  // data-confirm-field="name" data-confirm-values="a,b": ask only when that field (a bulk-action select) has one of those values.
  var field = message && form.getAttribute("data-confirm-field");
  if (field) {
    var control = form.elements[field];
    var wanted = (form.getAttribute("data-confirm-values") || "").split(",");
    if (!control || wanted.indexOf(control.value) < 0) message = null;
  }
  if (message && !window.confirm(message)) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

// "Mark collected and paid": show the discount live (list total minus the amount typed) and make the
// note required while the amount is below the list total. The server enforces both anyway.
(function () {
  function update(input) {
    var total = Number(input.getAttribute("data-discount-total"));
    var out = document.getElementById(input.getAttribute("data-discount-out"));
    var note = document.getElementById(input.getAttribute("data-discount-note"));
    var typed = Math.round(Number(String(input.value).replace(",", ".")) * 100);
    var discount = isFinite(typed) && input.value !== "" ? total - typed : 0;
    if (out) {
      if (discount > 0) out.textContent = "Discount: \u20AC" + (discount / 100).toFixed(2);
      else if (discount < 0) out.textContent = "The amount cannot be more than the list total (\u20AC" + (total / 100).toFixed(2) + ").";
      else out.textContent = "";
    }
    if (note) note.required = discount > 0;
  }
  document.addEventListener("input", function (e) {
    if (e.target && e.target.matches && e.target.matches("[data-discount-total]")) update(e.target);
  });
  var first = document.querySelector("[data-discount-total]");
  if (first) update(first);
})();

// Up to 900px the admin sidebar (partials/admin_header.ejs) is an off-canvas
// drawer rather than a permanent column (see admin.css). The hamburger button
// opens it; the backdrop, its own close button, a menu link or Escape close it.
// While it is open it behaves like a dialog: focus moves into it (the close
// button), Tab and Shift+Tab stay inside it (everything behind it is inert),
// the page behind does not scroll, and closing returns focus to the hamburger.
(function () {
  var layout = document.querySelector(".admin-layout");
  if (!layout) return;
  var toggle = document.querySelector("[data-toggle-admin-nav]");
  var drawer = document.getElementById("admin-sidebar");
  var phone = window.matchMedia ? window.matchMedia("(max-width: 900px)") : null;
  var isOpen = false;
  // What sits behind the open drawer: the page itself and the skip link.
  function behind() { return Array.prototype.slice.call(document.querySelectorAll(".admin-main, .skip-link, .admin-preview-note, .admin-sandbox-note")); }
  function setInert(on) {
    behind().forEach(function (el) {
      if (on) el.setAttribute("inert", ""); else el.removeAttribute("inert");
    });
  }
  function focusables() {
    if (!drawer) return [];
    return Array.prototype.slice.call(drawer.querySelectorAll("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"));
  }
  function setOpen(open, opts) {
    if (open === isOpen) return;
    isOpen = open;
    layout.classList.toggle("is-nav-open", open);
    document.documentElement.classList.toggle("is-admin-nav-open", open);
    if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (drawer) {
      // Open, it is a modal dialog (Escape closes it); closed, it is just the page's navigation again.
      ["role:dialog", "aria-modal:true", "aria-label:Menu"].forEach(function (pair) {
        var kv = pair.split(":");
        if (open) drawer.setAttribute(kv[0], kv[1]); else drawer.removeAttribute(kv[0]);
      });
    }
    setInert(open);
    if (open) {
      var first = drawer && drawer.querySelector(".admin-nav-close");
      if (first) first.focus();
    } else if (opts && opts.returnFocus && toggle) {
      toggle.focus();
    }
  }
  document.addEventListener("click", function (e) {
    if (e.target.closest("[data-toggle-admin-nav]")) { setOpen(!isOpen, { returnFocus: true }); return; }
    if (e.target.closest("[data-close-admin-nav]") || e.target.closest(".admin-nav a")) { setOpen(false, { returnFocus: true }); }
  });
  document.addEventListener("keydown", function (e) {
    if (!isOpen) return;
    if (e.key === "Escape") { e.preventDefault(); setOpen(false, { returnFocus: true }); return; }
    if (e.key !== "Tab") return;
    var items = focusables();
    if (!items.length) return;
    var firstEl = items[0], lastEl = items[items.length - 1], active = document.activeElement;
    if (!drawer.contains(active)) { e.preventDefault(); firstEl.focus(); }
    else if (e.shiftKey && active === firstEl) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && active === lastEl) { e.preventDefault(); firstEl.focus(); }
  });
  // Turning the phone sideways past 900px (or resizing a window) makes the drawer a permanent column: drop the lock.
  if (phone) {
    var onChange = function () { if (!phone.matches) setOpen(false, {}); };
    if (phone.addEventListener) phone.addEventListener("change", onChange); else if (phone.addListener) phone.addListener(onChange);
  }
})();

document.addEventListener("click", function (e) {
  var btn = e.target.closest("[data-toggle-password]");
  if (!btn) return;
  var input = document.getElementById(btn.getAttribute("data-toggle-password"));
  if (!input) return;
  var showing = input.type === "text";
  input.type = showing ? "password" : "text";
  var fr = document.documentElement.lang === "fr";
  btn.textContent = showing ? (fr ? "Afficher" : "Show") : (fr ? "Masquer" : "Hide");
  btn.setAttribute("aria-label", showing ? (fr ? "Afficher le mot de passe" : "Show password") : (fr ? "Masquer le mot de passe" : "Hide password"));
  btn.setAttribute("aria-pressed", showing ? "false" : "true");
});

document.addEventListener("change", function (e) {
  var input = e.target.closest("input[type=file][data-file-name-target]");
  if (!input) return;
  var target = document.getElementById(input.getAttribute("data-file-name-target"));
  var chosen = input.files && input.files[0];
  var maxBytes = Number(input.getAttribute("data-max-bytes")) || 0;
  if (chosen && maxBytes && chosen.size > maxBytes) {
    // Tell them now, before anything typed is sent and lost.
    window.alert("That picture is " + (chosen.size / 1048576).toFixed(1) + " MB; the limit is " + (input.getAttribute("data-max-label") || "smaller") + ". Please choose a smaller one (or resize it first).");
    input.value = "";
    if (target) target.textContent = "No image selected";
    return;
  }
  if (target) {
    var file = input.files && input.files[0];
    target.textContent = file ? file.name : "No photo selected";
  }
  if (input.hasAttribute("data-auto-submit-file") && input.files && input.files[0]) {
    if (input.form.requestSubmit) input.form.requestSubmit();
    else input.form.submit();
  }
});

// A <label for> on a hidden file input is unreliable for triggering the
// camera on iOS Safari (it sometimes falls back to the Files app instead
// of the capture UI) — a real button calling .click() on the input is
// more consistent.
document.addEventListener("click", function (e) {
  var btn = e.target.closest("[data-trigger-file]");
  if (!btn) return;
  var input = document.getElementById(btn.getAttribute("data-trigger-file"));
  if (input) input.click();
});

// Barcode scanners "type" the ISBN then usually send Enter, which submits
// the form natively — but some scanners skip the Enter, so also submit as
// soon as the field settles at a full ISBN-10/13 length. A 13-digit ISBN
// passes through 10 digits while it's still being typed (it starts with
// "978"/"979"), so checking on every keystroke fires a premature submit
// with only the first 10 digits — debounce until input pauses instead.
var autoSubmitIsbnTimer = null;
document.addEventListener("input", function (e) {
  var input = e.target.closest("[data-auto-submit-isbn]");
  if (!input) return;
  clearTimeout(autoSubmitIsbnTimer);
  autoSubmitIsbnTimer = setTimeout(function () {
    var digits = input.value.replace(/[^0-9Xx]/g, "");
    if (digits.length === 10 || digits.length === 13) {
      if (input.form.requestSubmit) input.form.requestSubmit();
      else input.form.submit();
    }
  }, 200);
});

// Preview an AI-generated description before saving — the field named by
// data-generate-description gets filled in place so it can be reviewed
// or edited before the form is submitted.
document.addEventListener("click", function (e) {
  var btn = e.target.closest("[data-generate-description]");
  if (!btn) return;
  e.preventDefault();
  var form = btn.closest("form");
  var descField = document.getElementById(btn.getAttribute("data-generate-description"));
  var descFrAttr = btn.getAttribute("data-generate-description-fr");
  var descFrField = descFrAttr ? document.getElementById(descFrAttr) : null;
  if (!form || !descField) return;

  var titleInput = form.querySelector("[name=title]");
  var title = titleInput ? titleInput.value.trim() : "";
  if (!title) {
    alert("Enter a title first.");
    return;
  }

  var field = function (name) {
    var el = form.querySelector("[name=" + name + "]");
    return el ? el.value : "";
  };
  var params = new URLSearchParams();
  params.set("_csrf", field("_csrf"));
  params.set("title", title);
  params.set("author", field("author"));
  params.set("publisher", field("publisher"));
  params.set("publishedYear", field("publishedYear"));

  var originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Generating…";

  fetch("/admin/inventory/generate-description", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  })
    .then(function (res) {
      return res.json().then(function (data) { return { ok: res.ok, data: data }; });
    })
    .then(function (result) {
      if (result.ok) {
        descField.value = result.data.description;
        if (descFrField && result.data.descriptionFr) descFrField.value = result.data.descriptionFr;
      } else {
        alert(result.data.error || "Couldn't generate a description.");
      }
    })
    .catch(function () {
      alert("Couldn't generate a description — check your connection and try again.");
    })
    .finally(function () {
      btn.disabled = false;
      btn.textContent = originalText;
    });
});

// Announcement editor's "N/200" excerpt counter (see data-char-count in
// admin/announcements.ejs).
document.addEventListener("input", function (e) {
  var el = e.target.closest("[data-char-count]");
  if (!el) return;
  var counter = document.getElementById(el.getAttribute("data-char-count"));
  if (counter) counter.textContent = String(el.value.length);
});

// Minimal rich-text editor for the announcement/blog content field: a
// contenteditable div with a toolbar driving the (deprecated but still
// universally supported) document.execCommand, rather than pulling in a
// whole editor library for a handful of formatting buttons. The
// contenteditable div itself has no `name` — its innerHTML is copied into
// the paired hidden textarea.richtext-hidden (expected as its very next
// sibling) right before the form submits, since a contenteditable node
// isn't part of native form submission.
document.addEventListener("click", function (e) {
  var btn = e.target.closest(".richtext-toolbar [data-cmd]");
  if (!btn) return;
  e.preventDefault();
  var wrap = btn.closest(".richtext");
  var editor = wrap && wrap.querySelector(".richtext-editor");
  if (!editor) return;
  editor.focus();
  var cmd = btn.getAttribute("data-cmd");
  var arg = btn.getAttribute("data-arg") || null;
  if (cmd === "createLink") {
    var url = window.prompt("Link URL:", "https://");
    if (!url) return;
    arg = url;
  }
  document.execCommand(cmd, false, arg);
});
// The hidden textarea must NOT be `required`: a required control that is
// display:none can never be focused, so the browser (Safari and Chrome alike)
// refuses to submit and shows nothing at all. Emptiness is checked here
// instead, with a visible message (a .field-error right after the textarea).
document.addEventListener("submit", function (e) {
  var richtexts = e.target.querySelectorAll ? e.target.querySelectorAll(".richtext") : [];
  var firstEmpty = null;
  richtexts.forEach(function (wrap) {
    var editor = wrap.querySelector(".richtext-editor");
    var hidden = wrap.nextElementSibling;
    if (editor && hidden && hidden.classList.contains("richtext-hidden")) {
      hidden.value = editor.innerHTML.trim();
      var message = wrap.getAttribute("data-richtext-required");
      var note = hidden.nextElementSibling;
      if (note && !note.classList.contains("field-error")) note = null;
      // data-richtext-skip-when="status=draft": empty is fine while that field has that value.
      var skip = wrap.getAttribute("data-richtext-skip-when");
      if (skip && e.target.elements) {
        var kv = skip.split("=");
        var field = e.target.elements[kv[0]];
        if (field && field.value === kv[1]) message = null;
      }
      var empty = !!message && !editor.textContent.replace(/\u00a0/g, " ").trim() && !editor.querySelector("img");
      if (note) note.hidden = !empty;
      wrap.classList.toggle("richtext-invalid", empty);
      if (empty && !firstEmpty) firstEmpty = editor;
    }
  });
  if (firstEmpty) {
    e.preventDefault();
    firstEmpty.focus();
    if (firstEmpty.scrollIntoView) firstEmpty.scrollIntoView({ block: "center" });
  }
});
document.addEventListener("input", function (e) {
  var editor = e.target.closest && e.target.closest(".richtext-editor");
  if (!editor) return;
  var wrap = editor.closest(".richtext");
  var note = wrap && wrap.nextElementSibling && wrap.nextElementSibling.nextElementSibling;
  if (note && note.classList.contains("field-error")) note.hidden = true;
  if (wrap) wrap.classList.remove("richtext-invalid");
});

// A form with data-saving-text shows that text on its submit button once the
// browser really is sending it (not when validation stopped it), so a slow
// save (a big photo) is visibly working and cannot be sent twice.
document.addEventListener("submit", function (e) {
  var form = e.target;
  var text = form.getAttribute && form.getAttribute("data-saving-text");
  if (!text) return;
  setTimeout(function () {
    if (e.defaultPrevented) return;
    form.querySelectorAll("button[type=submit]").forEach(function (btn) {
      btn.setAttribute("data-idle-label", btn.innerHTML);
      btn.innerHTML = text;
      btn.disabled = true;
    });
  }, 0);
});
// Back/forward cache restores the page as it was left: undo the "Saving" state.
window.addEventListener("pageshow", function () {
  document.querySelectorAll("button[data-idle-label]").forEach(function (btn) {
    btn.innerHTML = btn.getAttribute("data-idle-label");
    btn.removeAttribute("data-idle-label");
    btn.disabled = false;
  });
});

// Generic conditional-visibility helper: an element with
// data-show-when="fieldName=value" is shown only when the form field of
// that name currently has that value (radios/checkboxes: the checked
// one's value, or "on"/"" for a lone checkbox) — used for the
// announcement form's "set expiration date" checkbox and "schedule for
// later" status radio.
function applyShowWhen(form) {
  form.querySelectorAll("[data-show-when]").forEach(function (el) {
    var eq = el.getAttribute("data-show-when").split("=");
    var name = eq[0], expected = eq[1];
    var checked = form.querySelector('[name="' + name + '"]:checked');
    var field = checked || form.querySelector('[name="' + name + '"]');
    var current = field ? (field.type === "checkbox" ? (field.checked ? "on" : "") : field.value) : "";
    el.style.display = current === expected ? "" : "none";
  });
}
document.addEventListener("change", function (e) {
  var form = e.target.closest("form");
  if (form) applyShowWhen(form);
});
document.addEventListener("DOMContentLoaded", function () {
  document.querySelectorAll("form").forEach(applyShowWhen);
});

// A table's "select all" checkbox (data-select-all="group") checks/
// unchecks every checkbox sharing data-select-all-item="group" — used for
// the Announcements table's bulk-action row selection.
document.addEventListener("change", function (e) {
  var master = e.target.closest("[data-select-all]");
  if (!master) return;
  var name = master.getAttribute("data-select-all");
  var form = master.closest("form") || document;
  form.querySelectorAll('[data-select-all-item="' + name + '"]').forEach(function (cb) {
    cb.checked = master.checked;
  });
});

// Header account dropdown (logged-in members only — see partials/header.ejs).
(function () {
  function closeMenu(menu) {
    menu.classList.remove("is-open");
    menu.querySelector(".account-toggle").setAttribute("aria-expanded", "false");
  }
  document.addEventListener("click", function (e) {
    var toggle = e.target.closest(".account-toggle");
    var openMenu = document.querySelector(".account-menu.is-open");
    if (toggle) {
      var menu = toggle.closest(".account-menu");
      var wasOpen = menu.classList.contains("is-open");
      if (openMenu && openMenu !== menu) closeMenu(openMenu);
      menu.classList.toggle("is-open", !wasOpen);
      toggle.setAttribute("aria-expanded", String(!wasOpen));
      return;
    }
    if (openMenu && !e.target.closest(".account-menu")) closeMenu(openMenu);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    var openMenu = document.querySelector(".account-menu.is-open");
    if (openMenu) closeMenu(openMenu);
  });
})();

// A book cover that fails to load (deleted image, network error) would show the
// browser's broken-image frame. Swap it for the neutral "No cover" box of the
// same size instead. Done here, not with an inline onerror attribute (the CSP
// blocks inline handlers). Cover images carry data-cover. "error" does not
// bubble, so listen in the capture phase; images that failed before this script
// ran are caught on DOMContentLoaded.
(function () {
  function toPlaceholder(img) {
    if (!img || img.tagName !== "IMG" || !img.hasAttribute("data-cover") || !img.parentNode) return;
    var box = document.createElement("div");
    box.className = img.className + " cover-none cover-missing book-thumb-placeholder";
    var fr = document.documentElement.lang === "fr";
    var alt = img.getAttribute("alt");
    if (alt) { box.setAttribute("role", "img"); box.setAttribute("aria-label", alt); }
    else box.setAttribute("aria-hidden", "true");
    box.textContent = fr ? "Pas de couverture" : "No cover";
    img.parentNode.replaceChild(box, img);
  }
  document.addEventListener("error", function (e) { toPlaceholder(e.target); }, true);
  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("img[data-cover]").forEach(function (img) {
      if (img.complete && img.naturalWidth === 0) toPlaceholder(img);
    });
  });
})();

// A refused customer form (contact, request a book, sign-up) comes back with an error summary
// (views/partials/form_error_summary.ejs, data-form-errors): put focus on it so keyboard and screen-reader
// users land on the problem and its links to the fields, not at the top of the page.
document.addEventListener("DOMContentLoaded", function () {
  var summary = document.querySelector("[data-form-errors]");
  if (!summary) return;
  try { summary.focus({ preventScroll: false }); } catch { summary.focus(); }
});
