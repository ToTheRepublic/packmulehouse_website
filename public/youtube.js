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

  window.onYouTubeIframeAPIReady = function () {
    player = new YT.Player("yt-player", {
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
        onReady: function () {
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
    document.head.appendChild(tag);
  }
})();
