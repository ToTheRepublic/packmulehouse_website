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

test("homepage hero shows the X-Frame hero video with poster and reduced-motion handling", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const hero = html.slice(html.indexOf('<section class="hero">'), html.indexOf("<!-- VIDEO -->"));
  const tag = hero.match(/<video id="hero-video-player"[^>]*>/)[0];
  for (const a of ["autoplay", "muted", "loop", "playsinline", 'preload="metadata"', 'poster="/xframe-hero-poster.jpg"', "aria-label="]) assert.ok(tag.includes(a), a);
  assert.ok(hero.indexOf("xframe-hero.webm") < hero.indexOf("xframe-hero.mp4"));
  assert.match(hero, /Shop X-Frame/);
  const js = fs.readFileSync(new URL("../public/promo-video.js", import.meta.url), "utf8");
  assert.match(js, /hero-video-player/);
  for (const f of ["xframe-hero.mp4", "xframe-hero.webm", "xframe-hero-poster.jpg"]) assert.ok(fs.existsSync(new URL(`../public/${f}`, import.meta.url)), f);
});
