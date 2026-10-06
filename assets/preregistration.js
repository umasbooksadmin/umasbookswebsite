// Pre-registration form (views/marketing/pre-registration.ejs): "Who is
// registering?" decides whether the child section applies. Without this script
// both blocks stay visible (the server validates either way); with it, an adult
// does not see the child section, and the child fields are marked required for
// assistive technology only when "a parent or guardian, for a child" is chosen.
// No inline script: the pages' CSP allows this file ('self').
(function () {
  function update(form) {
    var chosen = form.querySelector('input[name="who"]:checked');
    var who = chosen ? chosen.value : "";
    var block = form.querySelector("[data-child-block]");
    if (!block) return;
    block.hidden = who === "self";
    block.querySelectorAll("[data-child-field]").forEach(function (el) {
      if (who === "child") el.setAttribute("aria-required", "true");
      else el.removeAttribute("aria-required");
    });
  }
  document.addEventListener("DOMContentLoaded", function () {
    var form = document.querySelector("form.preg-form");
    if (!form) return;
    form.addEventListener("change", function (e) {
      if (e.target && e.target.name === "who") update(form);
    });
    update(form);
  });
})();
