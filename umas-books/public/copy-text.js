// Buttons marked data-copy-text copy that text to the clipboard (the CSP forbids inline handlers).
// Falls back to a hidden textarea + execCommand when navigator.clipboard is unavailable.
(function () {
  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }
  Array.prototype.forEach.call(document.querySelectorAll("[data-copy-text]"), function (b) {
    b.addEventListener("click", function () {
      var status = b.parentNode && b.parentNode.querySelector("[data-copy-status]");
      copy(b.getAttribute("data-copy-text")).then(function (ok) {
        if (status) {
          status.textContent = ok ? "Copied" : "Could not copy: select the code and copy it by hand";
          setTimeout(function () { status.textContent = ""; }, 2500);
        }
      });
    });
  });
})();
