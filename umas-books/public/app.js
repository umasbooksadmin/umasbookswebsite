document.addEventListener("click", function (e) {
  var btn = e.target.closest("[data-toggle-password]");
  if (!btn) return;
  var input = document.getElementById(btn.getAttribute("data-toggle-password"));
  if (!input) return;
  var showing = input.type === "text";
  input.type = showing ? "password" : "text";
  btn.textContent = showing ? "Show" : "Hide";
  btn.setAttribute("aria-label", showing ? "Show password" : "Hide password");
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
      if (result.ok) descField.value = result.data.description;
      else alert(result.data.error || "Couldn't generate a description.");
    })
    .catch(function () {
      alert("Couldn't generate a description — check your connection and try again.");
    })
    .finally(function () {
      btn.disabled = false;
      btn.textContent = originalText;
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
