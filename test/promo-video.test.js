import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("homepage has the self-hosted promo video above Why X-Frame", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const sec = html.indexOf('<section class="promo-video"');
  assert.ok(sec > 0);
  assert.ok(sec < html.indexOf('<section class="benefits"'));
  assert.match(html, /<h2 id="promo-video-heading">How it works<\/h2>/);
  const tag = html.match(/<video id="promo-video-player"[^>]*>/)[0];
  for (const a of ["autoplay", "muted", "loop", "playsinline", 'preload="metadata"', 'poster="/xframe-promo-poster.jpg"', "aria-label="]) assert.ok(tag.includes(a), a);
  assert.match(html, /<source src="\/xframe-promo\.mp4" type="video\/mp4"/);
  assert.match(html, /<source src="\/xframe-promo\.webm" type="video\/webm"/);
  assert.match(html, /<script src="\/promo-video\.js" defer><\/script>/);
  for (const f of ["xframe-promo.mp4", "xframe-promo.webm", "xframe-promo-poster.jpg", "promo-video.js"]) assert.ok(fs.existsSync(new URL(`../public/${f}`, import.meta.url)), f);
});
