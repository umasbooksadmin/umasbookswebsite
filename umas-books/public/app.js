// The "← Back" link in partials/header.ejs and partials/admin_header.ejs
// used to run history.back() from an inline onclick attribute, which the
// app's CSP (script-src-attr 'none', set in src/index.js) silently
// blocks — every click did nothing. Delegated here instead, since this
// script loads on both the public dynamic pages and the admin panel.
document.addEventListener("click", function (e) {
  var backLink = e.target.closest(".site-back-link, .admin-back-link");
  if (backLink) {
    e.preventDefault();
    history.back();
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
  if (message && !window.confirm(message)) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

// Below 640px the admin sidebar (partials/admin_header.ejs) is an
// off-canvas drawer rather than a permanent column (see admin.css) —
// the hamburger button opens it, and the backdrop, its own close
// button, a nav link, or Escape all close it again.
(function () {
  var layout = document.querySelector(".admin-layout");
  if (!layout) return;
  var toggle = document.querySelector("[data-toggle-admin-nav]");
  function setOpen(open) {
    layout.classList.toggle("is-nav-open", open);
    if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false");
  }
  document.addEventListener("click", function (e) {
    if (e.target.closest("[data-toggle-admin-nav]")) { setOpen(true); return; }
    if (e.target.closest("[data-close-admin-nav]") || e.target.closest(".admin-nav a")) { setOpen(false); }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") setOpen(false);
  });
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
document.addEventListener("submit", function (e) {
  var richtexts = e.target.querySelectorAll ? e.target.querySelectorAll(".richtext") : [];
  richtexts.forEach(function (wrap) {
    var editor = wrap.querySelector(".richtext-editor");
    var hidden = wrap.nextElementSibling;
    if (editor && hidden && hidden.classList.contains("richtext-hidden")) {
      hidden.value = editor.innerHTML.trim();
    }
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
