// Load YouTube IFrame API and force closed captions off on start / play.
(function () {
  var VIDEO_ID = "5uQ2c1h6dxc";
  var player = null;

  function forceCaptionsOff() {
    if (!player || typeof player.unloadModule !== "function") return;
    try {
      player.unloadModule("captions");
      player.unloadModule("cc");
    } catch (e) { /* ignore */ }
    try {
      if (typeof player.setOption === "function") {
        player.setOption("captions", "track", {});
      }
    } catch (e2) { /* ignore */ }
  }

  var WATCH_URL = "https://www.youtube.com/watch?v=" + VIDEO_ID;
  var fellBack = false;
  var readyTimer = null;

  // If YouTube can't play the video (onError, or the player never gets
  // ready), show the thumbnail as a link to the video on YouTube instead of
  // an error box or an endless spinner.
  function showFallback() {
    if (fellBack) return;
    fellBack = true;
    clearTimeout(readyTimer);
    var mount = document.getElementById("yt-player") ||
      document.querySelector(".video-wrapper iframe");
    if (!mount) return;
    var link = document.createElement("a");
    link.className = "video-fallback";
    link.href = WATCH_URL;
    link.target = "_blank";
    link.rel = "noopener";
    link.setAttribute("aria-label", "Watch the X-Frame Drop-In System video on YouTube");
    var img = document.createElement("img");
    img.src = "https://i.ytimg.com/vi/" + VIDEO_ID + "/hqdefault.jpg";
    // Decorative: the link's aria-label already names the video.
    img.alt = "";
    img.width = 480;
    img.height = 360;
    var label = document.createElement("span");
    label.className = "video-fallback-label";
    label.textContent = "▶ Watch on YouTube";
    link.append(img, label);
    mount.replaceWith(link);
    reveal();
    try { if (player && player.destroy) player.destroy(); } catch (e) { /* ignore */ }
  }

  // Keep the player iframe invisible until it is ready so the wrapper's
  // thumbnail background shows instead of a black box while YouTube loads.
  var wrapper = document.querySelector(".video-wrapper");
  function reveal() { if (wrapper) wrapper.classList.remove("yt-pending"); }

  window.onYouTubeIframeAPIReady = function () {
    readyTimer = setTimeout(showFallback, 15000);
    if (wrapper) wrapper.classList.add("yt-pending");
    setTimeout(reveal, 8000);
    player = new YT.Player("yt-player", {
      host: "https://www.youtube-nocookie.com",
      videoId: VIDEO_ID,
      playerVars: {
        autoplay: 1,
        mute: 1,
        loop: 1,
        playlist: VIDEO_ID,
        playsinline: 1,
        rel: 0,
        modestbranding: 1,
        controls: 1,
        cc_load_policy: 0,
        iv_load_policy: 3,
        fs: 1,
      },
      events: {
        onError: function () {
          showFallback();
        },
        onReady: function () {
          clearTimeout(readyTimer);
          reveal();
          forceCaptionsOff();
          try {
            player.mute();
            player.playVideo();
          } catch (e) { /* ignore */ }
        },
        onStateChange: function (ev) {
          if (ev.data === YT.PlayerState.PLAYING || ev.data === YT.PlayerState.BUFFERING) {
            forceCaptionsOff();
          }
        },
        onApiChange: function () {
          forceCaptionsOff();
        },
      },
    });
  };

  if (!document.getElementById("yt-iframe-api")) {
    var tag = document.createElement("script");
    tag.id = "yt-iframe-api";
    tag.src = "https://www.youtube.com/iframe_api";
    tag.async = true;
    tag.onerror = showFallback;
    document.head.appendChild(tag);
  }
})();
