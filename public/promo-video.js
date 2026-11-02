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

// Hero video plays once and holds its last frame until reload.
(function () {
  var v = document.getElementById("hero-video-player");
  if (!v) return;
  v.loop = false;
  function hold() {
    v.pause();
    v.controls = false;
    if (isFinite(v.duration) && v.duration > 0.1) {
      try { v.currentTime = v.duration - 0.05; } catch (e) {}
    }
  }
  v.addEventListener("timeupdate", function () {
    if (isFinite(v.duration) && v.currentTime >= v.duration - 0.08) hold();
  });
  v.addEventListener("ended", hold);
})();
