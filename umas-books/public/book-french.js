// "Update the French from the English" on the book edit page and the Add Book form (views/admin/inventory/show.ejs, new.ejs).
// Sends the English genres and description as they are NOW in the form (unsaved edits included) to
// /admin/inventory/translate-french and puts the answer into the two French boxes. It never saves: the admin reads the
// French, changes it, and presses Save. A French box that already has text is only replaced after the admin confirms.
// Works only with JavaScript: the button's wrapper is `hidden` in the page and shown here. Also shows a small hint under a
// French box once the English above it was edited and the French box has text.
(function () {
  var tools = document.querySelectorAll("[data-fr-sync-tools]");
  for (var i = 0; i < tools.length; i++) tools[i].hidden = false;

  function byId(id) { return id ? document.getElementById(id) : null; }
  function filled(el) { return !!(el && String(el.value).trim()); }
  function setText(el, text, isError) {
    if (!el) return;
    el.textContent = text;
    if (el.classList) el.classList.toggle("fr-error", !!isError);
  }

  // The four boxes of a button, found by the ids it names.
  function boxes(btn) {
    return {
      genre: byId(btn.getAttribute("data-fr-genre")),
      genreFr: byId(btn.getAttribute("data-fr-genre-fr")),
      desc: byId(btn.getAttribute("data-fr-desc")),
      descFr: byId(btn.getAttribute("data-fr-desc-fr")),
    };
  }

  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("[data-fr-sync]");
    if (!btn) return;
    e.preventDefault();
    if (btn.getAttribute("aria-disabled") === "true") return; // working already (aria-disabled, not disabled: focus stays)
    var form = btn.closest("form");
    var b = boxes(btn);
    var status = byId(btn.getAttribute("data-fr-status"));
    if (!form || !b.genre || !b.genreFr || !b.desc || !b.descFr) return;
    var save = btn.getAttribute("data-fr-save-label") || "Save changes";

    if (filled(b.genreFr) || filled(b.descFr)) {
      var ok = window.confirm("Replace the French genres and description with a fresh translation of the English? Your current French text in those boxes will be overwritten (nothing is saved until you press " + save + ").");
      if (!ok) return;
    }

    var token = form.querySelector("[name=_csrf]");
    var params = new URLSearchParams();
    params.set("_csrf", token ? token.value : "");
    params.set("genre", b.genre.value);
    params.set("description", b.desc.value);

    var label = btn.textContent;
    btn.setAttribute("aria-disabled", "true");
    btn.textContent = "Updating…";
    setText(status, "Updating the French…", false);

    fetch(btn.getAttribute("data-fr-url"), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: params.toString(),
    })
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (r) {
        if (!r.ok) { setText(status, (r.data && r.data.error) || "The French could not be updated. Nothing was changed.", true); return; }
        var d = r.data;
        // Only what the server made is written: no English genres, or no English description, leaves that French box as it was.
        if (d.genreFr) { b.genreFr.value = d.genreFr; markFresh(b.genreFr); }
        if (d.descriptionFr) { b.descFr.value = d.descriptionFr; markFresh(b.descFr); }
        if (d.aiMessage) setText(status, d.aiMessage, true);
        else setText(status, "French updated from the English. Check it, then press " + save + ".", false);
      })
      .catch(function () { setText(status, "Could not reach the server. Check your connection and try again. Nothing was changed.", true); })
      .then(function () {
        btn.removeAttribute("aria-disabled");
        btn.textContent = label;
      });
  });

  // ---- the "English changed" hint under a French box ----
  // A hint (data-fr-stale="<French box id>" data-fr-english="<English box id>") shows once the English box was edited (an input
  // event) after the page loaded, or after the last update, and the French box has text.
  var stale = {}; // English box id -> true while edited and not refreshed since
  function updateHints() {
    var hints = document.querySelectorAll("[data-fr-stale]");
    for (var k = 0; k < hints.length; k++) {
      var fr = byId(hints[k].getAttribute("data-fr-stale"));
      hints[k].hidden = !(stale[hints[k].getAttribute("data-fr-english")] && filled(fr));
    }
  }
  function markFresh(frBox) {
    var hints = document.querySelectorAll("[data-fr-stale]");
    for (var k = 0; k < hints.length; k++) {
      if (hints[k].getAttribute("data-fr-stale") === frBox.id) stale[hints[k].getAttribute("data-fr-english")] = false;
    }
    updateHints();
  }
  document.addEventListener("input", function (e) {
    var id = e.target && e.target.id;
    if (!id) return;
    var hints = document.querySelectorAll("[data-fr-stale]");
    for (var k = 0; k < hints.length; k++) {
      if (hints[k].getAttribute("data-fr-english") === id) stale[id] = true;
    }
    updateHints();
  });
})();
