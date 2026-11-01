// Respect prefers-reduced-motion: no autoplay; show the poster with controls.
["promo-video-player", "hero-video-player"].forEach(function (id) {
  var v = document.getElementById(id);
  if (!v || !window.matchMedia) return;
  var mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  function apply() {
    if (mq.matches) {
      v.autoplay = false;
      v.removeAttribute("autoplay");
      v.pause();
      if (id !== "hero-video-player") v.controls = true;
      try { v.currentTime = 0; v.load(); } catch (e) {}
    }
  }
  apply();
  if (mq.addEventListener) mq.addEventListener("change", apply);
});
