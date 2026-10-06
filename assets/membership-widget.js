// Click-to-load for the HelloAsso membership form (views/marketing/membership.ejs).
// The iframe does NOT exist until the visitor presses "Show the HelloAsso form":
// HelloAsso may set its own cookies and sees the visitor's IP address, so
// nothing is requested from it before that choice (see the privacy policy).
// The address comes from the holder's data-src and is only used when it points
// at www.helloasso.com. No inline handlers: the page's CSP is also satisfied by
// a plain external script.
(function () {
  var ORIGIN = "https://www.helloasso.com";

  document.addEventListener("DOMContentLoaded", function () {
    var holder = document.getElementById("haWidgetHolder");
    var button = document.getElementById("haShow");
    if (!holder || !button) return;

    button.addEventListener("click", function () {
      var src = holder.getAttribute("data-src") || "";
      if (src.indexOf(ORIGIN + "/") !== 0 || document.getElementById("haWidget")) return;
      var fr = document.documentElement.lang === "fr";

      var frame = document.createElement("iframe");
      frame.id = "haWidget";
      frame.title = holder.getAttribute(fr ? "data-title-fr" : "data-title-en") || "HelloAsso membership form";
      frame.setAttribute("allow", "payment 'self' https://paymenthub.helloassopay.com https://helloasso.com");
      frame.setAttribute("allowtransparency", "true");
      frame.setAttribute("scrolling", "auto");
      frame.style.cssText = "width: 100%; height: 750px; border: none;";
      frame.src = src;
      holder.appendChild(frame);

      // The widget reports its content height; grow the frame to fit.
      window.addEventListener("message", function (e) {
        if (e.origin !== ORIGIN || e.source !== frame.contentWindow) return;
        var h = e.data && Number(e.data.height);
        if (h > 0 && h > parseFloat(frame.height || 0)) frame.height = h + "px";
      });

      var gate = document.getElementById("haGate");
      if (gate) gate.hidden = true;
      frame.focus();
    });
  });
})();
