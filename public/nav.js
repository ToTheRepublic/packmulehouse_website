// Mobile menu: hamburger toggles the header nav below 860px.
(function () {
  "use strict";
  var toggle = document.getElementById("nav-toggle");
  var nav = document.getElementById("site-nav");
  if (!toggle || !nav) return;

  function setOpen(open, focusToggle) {
    nav.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    if (open) {
      var first = nav.querySelector("a");
      if (first) first.focus();
    } else if (focusToggle) {
      toggle.focus();
    }
  }

  function isOpen() {
    return toggle.getAttribute("aria-expanded") === "true";
  }

  toggle.addEventListener("click", function () {
    setOpen(!isOpen(), false);
  });

  nav.addEventListener("click", function (e) {
    if (e.target.closest("a") && isOpen()) setOpen(false, false);
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && isOpen()) {
      e.preventDefault();
      setOpen(false, true);
    }
  });

  document.addEventListener("click", function (e) {
    if (isOpen() && !nav.contains(e.target) && !toggle.contains(e.target)) setOpen(false, false);
  });

  // Back to desktop width: reset the menu state.
  var mq = window.matchMedia("(min-width: 861px)");
  var onChange = function () {
    if (mq.matches && isOpen()) setOpen(false, false);
  };
  if (mq.addEventListener) mq.addEventListener("change", onChange);
})();
