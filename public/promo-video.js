// Respect prefers-reduced-motion: no autoplay; show the poster with controls.
(function () {
  var v = document.getElementById("promo-video-player");
  if (!v || !window.matchMedia) return;
  var mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  function apply() {
    if (mq.matches) {
      v.autoplay = false;
      v.removeAttribute("autoplay");
      v.pause();
      v.controls = true;
      try { v.currentTime = 0; v.load(); } catch (e) {}
    }
  }
  apply();
  if (mq.addEventListener) mq.addEventListener("change", apply);
})();
