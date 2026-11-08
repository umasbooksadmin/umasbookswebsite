// The crop box, shared by the Cover / Picture card of a saved item (public/cover-edit.js) and the picture chooser of an
// item that is not saved yet (public/pending-picture.js).
//
// UmasCropBox.attach({ overlay, box, readout, onEscape }) wires the pointer and keyboard behaviour of the box and returns
// { get(), reset(), render() }. The box is kept as four fractions (x, y, w, h) of the picture, 0..1, so it does not matter
// how big the picture is shown. get() returns a copy of them. Mouse, pen and touch use pointer events; on the focused box the
// arrow keys move it by 1%, Shift plus arrows change its size, Escape calls onEscape.
// `overlay` is the element laid over the picture, `box` the draggable rectangle inside it (with four [data-handle] corners).
(function () {
  "use strict";

  var MIN = 0.05; // the same minimum the server enforces
  var INITIAL = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
  var STEP = 0.01;

  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  // A rectangle from two opposite corners, at least MIN each way, inside the picture.
  function fromCorners(a, b) {
    var x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
    var y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    if (x1 - x0 < MIN) { if (b.x >= a.x) x1 = Math.min(1, x0 + MIN); else x0 = Math.max(0, x1 - MIN); if (x1 - x0 < MIN) { x0 = 0; x1 = MIN; } }
    if (y1 - y0 < MIN) { if (b.y >= a.y) y1 = Math.min(1, y0 + MIN); else y0 = Math.max(0, y1 - MIN); if (y1 - y0 < MIN) { y0 = 0; y1 = MIN; } }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function attach(opts) {
    var overlay = opts.overlay, box = opts.box, readout = opts.readout;
    var sel = { x: INITIAL.x, y: INITIAL.y, w: INITIAL.w, h: INITIAL.h };

    function render() {
      box.style.left = (sel.x * 100) + "%";
      box.style.top = (sel.y * 100) + "%";
      box.style.width = (sel.w * 100) + "%";
      box.style.height = (sel.h * 100) + "%";
      var wide = Math.round(sel.w * 100);
      var tall = Math.round(sel.h * 100);
      if (readout) readout.textContent = "Keeping " + wide + "% of the width and " + tall + "% of the height.";
    }

    // Fractions of the picture for a pointer position.
    function point(e) {
      var r = overlay.getBoundingClientRect();
      if (!r.width || !r.height) return { x: 0, y: 0 };
      return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) };
    }

    var drag = null; // { kind: "move" | "corner" | "draw", ... }

    function start(e, state) {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      drag = state;
      drag.id = e.pointerId;
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not capturable: moves still arrive on the element */ }
    }

    box.addEventListener("pointerdown", function (e) {
      if (e.target !== box) return; // a handle starts its own drag
      var p = point(e);
      start(e, { kind: "move", dx: p.x - sel.x, dy: p.y - sel.y });
    });

    Array.prototype.forEach.call(box.querySelectorAll("[data-handle]"), function (h) {
      h.addEventListener("pointerdown", function (e) {
        e.stopPropagation();
        var which = h.getAttribute("data-handle");
        // The corner opposite the one grabbed stays where it is.
        var anchor = { x: which.indexOf("w") >= 0 ? sel.x + sel.w : sel.x, y: which.indexOf("n") >= 0 ? sel.y + sel.h : sel.y };
        start(e, { kind: "corner", anchor: anchor });
      });
    });

    overlay.addEventListener("pointerdown", function (e) {
      if (e.target !== overlay) return;
      var p = point(e);
      start(e, { kind: "draw", anchor: p });
      sel = fromCorners(p, p);
      render();
    });

    function onMove(e) {
      if (!drag || e.pointerId !== drag.id) return;
      var p = point(e);
      if (drag.kind === "move") {
        sel.x = clamp(p.x - drag.dx, 0, 1 - sel.w);
        sel.y = clamp(p.y - drag.dy, 0, 1 - sel.h);
      } else {
        sel = fromCorners(drag.anchor, p);
      }
      render();
    }
    function onEnd(e) {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      box.focus({ preventScroll: true });
    }
    [box, overlay].concat(Array.prototype.slice.call(box.querySelectorAll("[data-handle]"))).forEach(function (el) {
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onEnd);
      el.addEventListener("pointercancel", onEnd);
    });

    // Keyboard: arrows move the box by 1% of the picture, Shift plus arrows make it bigger or smaller (from its top left corner).
    box.addEventListener("keydown", function (e) {
      var dx = 0, dy = 0;
      if (e.key === "ArrowLeft") dx = -STEP;
      else if (e.key === "ArrowRight") dx = STEP;
      else if (e.key === "ArrowUp") dy = -STEP;
      else if (e.key === "ArrowDown") dy = STEP;
      else if (e.key === "Escape") { e.preventDefault(); if (opts.onEscape) opts.onEscape(); return; }
      else return;
      e.preventDefault();
      if (e.shiftKey) {
        sel.w = clamp(sel.w + dx, MIN, 1 - sel.x);
        sel.h = clamp(sel.h + dy, MIN, 1 - sel.y);
      } else {
        sel.x = clamp(sel.x + dx, 0, 1 - sel.w);
        sel.y = clamp(sel.y + dy, 0, 1 - sel.h);
      }
      render();
    });

    return {
      get: function () { return { x: sel.x, y: sel.y, w: sel.w, h: sel.h }; },
      reset: function () { drag = null; sel = { x: INITIAL.x, y: INITIAL.y, w: INITIAL.w, h: INITIAL.h }; render(); },
      render: render
    };
  }

  window.UmasCropBox = { attach: attach };
})();
