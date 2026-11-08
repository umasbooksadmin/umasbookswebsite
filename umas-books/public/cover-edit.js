// The Cover card on a book's admin page (views/admin/inventory/show.ejs): the crop box.
//
// Everything else on the card (replace, rotate, remove) is a plain form post and works without this file. This adds the one thing
// a form cannot do: choose a part of the picture by dragging. Without JavaScript the Crop button stays hidden.
//
// The box itself (drag, corners, keyboard) is public/crop-box.js, shared with public/pending-picture.js; it is kept as four
// fractions (x, y, w, h) of the picture, 0..1. "Apply crop"
// puts the fractions in the hidden fields of a normal form and submits it; the server validates them again and does the
// cutting (lib/coverEdit.js). Mouse, pen and touch use pointer events; the keyboard works on the focused box.

(function () {
  "use strict";

  var card = document.querySelector("[data-cover-edit]");
  if (!card) return;

  var noun = card.getAttribute("data-noun") || "cover"; // "cover" on a book, "picture" on an educational item
  var live = card.querySelector("[data-cover-live]");
  var message = card.querySelector("[data-cover-message]");
  // After a rotate, crop, replace or remove the page reloads at the card: read the result out and put the focus on it.
  if (message) {
    try { message.focus({ preventScroll: false }); } catch { /* older browsers */ }
  }

  var panel = card.querySelector("[data-cover-crop]");
  var openBtn = card.querySelector("[data-cover-crop-open]");
  if (!panel || !openBtn) return;

  var stage = panel.querySelector("[data-cover-stage]");
  var img = panel.querySelector("[data-cover-stage-img]");
  var overlay = panel.querySelector("[data-cover-overlay]");
  var box = panel.querySelector("[data-cover-box]");
  var readout = panel.querySelector("[data-cover-readout]");
  var form = panel.querySelector("[data-cover-crop-form]");
  var resetBtn = panel.querySelector("[data-cover-reset]");
  var cancelBtn = panel.querySelector("[data-cover-cancel]");
  if (!stage || !img || !overlay || !box || !form) return;

  var crop = window.UmasCropBox && window.UmasCropBox.attach({ overlay: overlay, box: box, readout: readout, onEscape: function () { close("Crop cancelled."); } });
  if (!crop) return; // crop-box.js (loaded before this file) is missing: the Crop button stays hidden

  function say(text) {
    if (!live) return;
    live.textContent = "";
    // A changed text is what a screen reader announces: clear first, set on the next tick.
    window.setTimeout(function () { live.textContent = text; }, 30);
  }

  function open() {
    crop.reset();
    panel.hidden = false;
    openBtn.setAttribute("aria-expanded", "true");
    say("Crop mode. Drag the box to choose the part of the " + noun + " to keep, then press Apply crop.");
    box.focus({ preventScroll: true });
    if (panel.scrollIntoView) panel.scrollIntoView({ block: "nearest" });
  }
  function close(text) {
    panel.hidden = true;
    openBtn.setAttribute("aria-expanded", "false");
    if (text) say(text);
    openBtn.focus();
  }

  openBtn.hidden = false; // JavaScript works: the Crop button can be shown
  openBtn.addEventListener("click", function () { if (panel.hidden) open(); else close(); });
  cancelBtn.addEventListener("click", function () { close("Crop cancelled."); });
  resetBtn.addEventListener("click", function () {
    crop.reset();
    say("Selection reset.");
    box.focus({ preventScroll: true });
  });

  form.addEventListener("submit", function () {
    var fields = crop.get();
    Object.keys(fields).forEach(function (k) { form.elements[k].value = fields[k].toFixed(6); });
    say("Cropping the " + noun + ".");
  });
})();
