// A picture chooser for a form whose item is not saved yet (views/partials/pending_picture.ejs): after a file is chosen the
// admin can turn it, crop it, reset it or remove it right away, before pressing the form's own Save button.
//
// Everything is done in the browser, on a canvas. The chosen file is drawn upright (EXIF orientation honoured), at most MAX_EDGE
// pixels on the long side, on a white background (a transparent PNG would turn black as a JPEG). After every change the result
// is encoded as a JPEG (quality 0.9) and put back in the same file input with a DataTransfer, so the form posts the multipart
// field exactly as it does for a plain file, and the server code (validation, upright, resize, store) is unchanged. The submit
// waits for an encoding still running.
//
// Without JavaScript, or in a browser that has no canvas / DataTransfer, or for a file the browser cannot read (a HEIC photo
// from an iPhone, say), the file input stays a plain file input and the file is sent as it was chosen. The crop box is
// public/crop-box.js (the same box as the Cover / Picture card of a saved item). Several choosers on one page work.
(function () {
  "use strict";

  var MAX_EDGE = 2000;
  var QUALITY = 0.9;
  var HUGE_FILE = 60 * 1024 * 1024; // do not even try to decode more than this in a phone browser

  function supported() {
    try {
      if (!window.UmasCropBox || !document.createElement("canvas").toBlob || !window.File || !window.DataTransfer || !window.URL) return false;
      var dt = new DataTransfer();
      dt.items.add(new File(["x"], "x.jpg", { type: "image/jpeg" }));
      return dt.files.length === 1;
    } catch { return false; }
  }

  function newCanvas(w, h) {
    var c = document.createElement("canvas");
    c.width = w; c.height = h;
    return c;
  }

  // The picture as an upright, opaque canvas, at most MAX_EDGE on the long side. Rejects when the browser cannot read the file.
  function decode(file) {
    function draw(source, w, h) {
      var scale = Math.min(1, MAX_EDGE / Math.max(w, h));
      var c = newCanvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
      var ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(source, 0, 0, c.width, c.height);
      return c;
    }
    if (window.createImageBitmap) {
      return window.createImageBitmap(file, { imageOrientation: "from-image" }).then(function (bmp) {
        var c = draw(bmp, bmp.width, bmp.height);
        if (bmp.close) bmp.close();
        return c;
      }, function () { return viaImage(); });
    }
    return viaImage();
    // Older browsers: an <img> is shown upright by every current browser (EXIF orientation applies by default).
    function viaImage() {
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () {
          try { resolve(draw(img, img.naturalWidth, img.naturalHeight)); } catch (e) { reject(e); } finally { URL.revokeObjectURL(url); }
        };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("unreadable")); };
        img.src = url;
      });
    }
  }

  function init(root) {
    var input = root.querySelector("[data-pending-input]");
    var editor = root.querySelector("[data-pending-editor]");
    var canvas = root.querySelector("[data-pending-canvas]");
    var overlay = root.querySelector("[data-pending-overlay]");
    var box = root.querySelector("[data-pending-box]");
    var panel = root.querySelector("[data-pending-crop]");
    var readout = root.querySelector("[data-pending-readout]");
    var note = root.querySelector("[data-pending-note]");
    var live = root.querySelector("[data-pending-live]");
    var openBtn = root.querySelector("[data-pending-crop-open]");
    var form = input && input.form;
    if (!input || !editor || !canvas || !overlay || !box || !panel || !openBtn || !form) return;
    var noun = root.getAttribute("data-noun") || "picture";
    var maxBytes = Number(root.getAttribute("data-max-bytes")) || 8 * 1024 * 1024;
    var baseName = "picture";

    var crop = window.UmasCropBox.attach({ overlay: overlay, box: box, readout: readout, onEscape: function () { closeCrop("Crop cancelled."); } });
    var base = null; // the upright picture as first drawn: what Reset goes back to
    var token = 0; // a newer choice makes an older decode / encode irrelevant
    var syncing = null; // the promise of the encode that is putting the result in the file input
    var resubmit = false;

    function say(text) {
      if (!live) return;
      live.textContent = "";
      window.setTimeout(function () { live.textContent = text; }, 30);
    }
    function showNote(text) { note.textContent = text || ""; note.hidden = !text; }

    function setCanvas(c) {
      canvas.width = c.width; canvas.height = c.height;
      canvas.getContext("2d").drawImage(c, 0, 0);
    }

    function toBlob(c, q) {
      return new Promise(function (resolve) { c.toBlob(function (b) { resolve(b); }, "image/jpeg", q); });
    }
    // JPEG under the size limit: lower the quality, then the size, only when a very big picture needs it.
    function encode() {
      var c = canvas;
      var q = QUALITY;
      function attempt(n) {
        return toBlob(c, q).then(function (b) {
          if (!b) return null;
          if (b.size <= maxBytes || n >= 6) return b;
          if (q > 0.7) q -= 0.1;
          else {
            var s = newCanvas(Math.round(c.width * 0.8), Math.round(c.height * 0.8));
            s.getContext("2d").drawImage(c, 0, 0, s.width, s.height);
            c = s;
          }
          return attempt(n + 1);
        });
      }
      return attempt(0);
    }

    function putInInput(blob) {
      var dt = new DataTransfer();
      if (blob) dt.items.add(new File([blob], baseName + ".jpg", { type: "image/jpeg", lastModified: Date.now() }));
      input.files = dt.files;
    }

    // Put the picture as it is now in the file input (a rotate or crop is allowed to finish before the form is sent).
    function sync() {
      var mine = ++token;
      var p = encode().then(function (blob) {
        if (mine !== token) return;
        if (!blob) { fail(); return; }
        putInInput(blob);
      }).catch(fail).then(function () { if (syncing === p) syncing = null; });
      syncing = p;
      return p;
    }

    // Anything went wrong in the browser: the file input is left as the admin chose it, and says so.
    function fail() {
      editor.hidden = true;
      closeCrop();
      showNote("This " + noun + " cannot be edited here. It will be added as it is; you can turn or crop it on the edit page after saving.");
    }

    function clear() {
      token++;
      base = null;
      editor.hidden = true;
      closeCrop();
      showNote("");
    }

    function onChosen() {
      var file = input.files && input.files[0];
      clear();
      if (!file) return;
      baseName = (file.name || "picture").replace(/\.[^.]*$/, "").replace(/[^\w.-]+/g, "-").slice(0, 60) || "picture";
      var mine = token;
      if (file.size > HUGE_FILE || !/^image\/(jpeg|png|webp)$/.test(file.type || "")) {
        // HEIC / HEIF from an iPhone, or a type the browser does not name: left for the server to accept or refuse.
        showNote("This kind of file cannot be edited here (for example a HEIC photo). It will be sent as it is: if it is not a JPEG, PNG or WebP the site will tell you. You can turn or crop the " + noun + " on its edit page after saving.");
        return;
      }
      decode(file).then(function (c) {
        if (mine !== token) return;
        base = c;
        setCanvas(c);
        editor.hidden = false;
        sync();
        say("Picture chosen. You can turn it, crop it or remove it before saving.");
      }, function () {
        if (mine !== token) return;
        showNote("The browser could not read this " + noun + " to edit it. It will be sent as it is: if it is not a valid JPEG, PNG or WebP the site will tell you. You can turn or crop it on the edit page after saving.");
      });
    }

    function rotate(dir) {
      if (!base) return;
      closeCrop();
      var r = newCanvas(canvas.height, canvas.width);
      var ctx = r.getContext("2d");
      ctx.translate(r.width / 2, r.height / 2);
      ctx.rotate((dir === "left" ? -1 : 1) * Math.PI / 2);
      ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
      setCanvas(r);
      sync();
      say("Turned " + dir + ".");
    }

    function applyCrop() {
      var s = crop.get();
      var sx = Math.round(s.x * canvas.width), sy = Math.round(s.y * canvas.height);
      var sw = Math.max(1, Math.min(canvas.width - sx, Math.round(s.w * canvas.width)));
      var sh = Math.max(1, Math.min(canvas.height - sy, Math.round(s.h * canvas.height)));
      var c = newCanvas(sw, sh);
      c.getContext("2d").drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
      setCanvas(c);
      closeCrop();
      sync();
      say("Cropped.");
    }

    function openCrop() {
      crop.reset();
      overlay.hidden = false;
      panel.hidden = false;
      openBtn.setAttribute("aria-expanded", "true");
      say("Crop mode. Drag the box to choose the part of the " + noun + " to keep, then press Apply crop.");
      box.focus({ preventScroll: true });
    }
    function closeCrop(text) {
      var wasOpen = !panel.hidden;
      overlay.hidden = true;
      panel.hidden = true;
      openBtn.setAttribute("aria-expanded", "false");
      if (text) say(text);
      if (wasOpen && text) openBtn.focus();
    }

    function remove() {
      clear();
      token++;
      putInInput(null);
      input.value = "";
      say("The " + noun + " was removed. Nothing will be saved for it.");
      input.focus();
    }

    function reset() {
      if (!base) return;
      closeCrop();
      setCanvas(base);
      sync();
      say("Back to the " + noun + " as you chose it.");
    }

    input.addEventListener("change", onChosen);
    root.querySelector("[data-pending-rotate=left]").addEventListener("click", function () { rotate("left"); });
    root.querySelector("[data-pending-rotate=right]").addEventListener("click", function () { rotate("right"); });
    openBtn.addEventListener("click", function () { if (panel.hidden) openCrop(); else closeCrop(); });
    root.querySelector("[data-pending-crop-apply]").addEventListener("click", applyCrop);
    root.querySelector("[data-pending-crop-reset]").addEventListener("click", function () { crop.reset(); say("Selection reset."); box.focus({ preventScroll: true }); });
    root.querySelector("[data-pending-crop-cancel]").addEventListener("click", function () { closeCrop("Crop cancelled."); });
    root.querySelector("[data-pending-reset]").addEventListener("click", reset);
    root.querySelector("[data-pending-remove]").addEventListener("click", remove);

    // A submit while the result is still being encoded waits for it, then sends the form the same way.
    form.addEventListener("submit", function (e) {
      if (resubmit || !syncing) return;
      e.preventDefault();
      var by = e.submitter;
      syncing.then(function () {
        resubmit = true;
        try { if (form.requestSubmit) form.requestSubmit(by || undefined); else form.submit(); } finally { resubmit = false; }
      });
    });

    // A file already chosen (the browser kept it after a back navigation): treat it like a new choice.
    if (input.files && input.files.length) onChosen();
  }

  if (!supported()) return;
  Array.prototype.forEach.call(document.querySelectorAll("[data-pending-picture]"), init);
})();
