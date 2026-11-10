import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../public/how-it-works.html", import.meta.url), "utf8");
const worker = fs.readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
const index = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("how-it-works page has title, meta description, and JSON-LD", () => {
  assert.match(html, /<title>How X-Frame Works \| Pack Mule House<\/title>/);
  assert.match(html, /<meta name="description" content="Learn how to hang X-Frame/);
  assert.match(html, /<link rel="canonical" href="__SITE_ORIGIN__\/how-it-works"/);
  const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(ld, "JSON-LD block");
  const data = JSON.parse(ld[1]);
  const nodes = data["@graph"];
  assert.ok(nodes.some((n) => n["@type"] === "VideoObject"));
  assert.ok(nodes.some((n) => n["@type"] === "HowTo" && Array.isArray(n.step) && n.step.length >= 5));
  const video = nodes.find((n) => n["@type"] === "VideoObject");
  assert.equal(video.duration, "PT1M45S");
  assert.match(video.contentUrl, /xframe-howto\.mp4$/);
});

test("how-it-works video uses controls and no autoplay", () => {
  const tag = html.match(/<video id="howto-video-player"[^>]*>/)[0];
  assert.ok(tag.includes("controls"), "controls");
  assert.ok(tag.includes("playsinline"), "playsinline");
  assert.ok(tag.includes('preload="metadata"'), "preload");
  assert.ok(tag.includes('poster="/xframe-howto-poster.jpg"'), "poster");
  assert.ok(!/\bautoplay\b/.test(tag), "must not autoplay");
  assert.ok(!/\bmuted\b/.test(tag), "must not be muted");
  assert.ok(!/\bloop\b/.test(tag), "must not loop");
  const player = html.slice(html.indexOf('<video id="howto-video-player"'), html.indexOf("</video>", html.indexOf('<video id="howto-video-player"')) + 8);
  assert.ok(player.indexOf("xframe-howto.webm") < player.indexOf("xframe-howto.mp4"));
  assert.match(player, /<source src="\/xframe-howto\.webm" type="video\/webm"/);
  assert.match(player, /<source src="\/xframe-howto\.mp4" type="video\/mp4"/);
  const files = [
    "xframe-howto.mp4",
    "xframe-howto.webm",
    "xframe-howto-poster.jpg",
    "xframe-howto-step1.jpg",
    "xframe-howto-step2.jpg",
    "xframe-howto-step2-strips.jpg",
    "xframe-howto-step3.jpg",
    "xframe-howto-step4.jpg",
    "xframe-howto-step4-tabs.jpg",
    "xframe-howto-step5.jpg",
    "xframe-howto-peel.jpg",
    "xframe-howto-swap.jpg",
  ];
  for (const f of files) {
    assert.ok(fs.existsSync(new URL(`../public/${f}`, import.meta.url)), f);
  }
});

test("how-it-works page writes out the five hanging steps plus peel-and-stick", () => {
  assert.match(html, /Hold the leveling tool on the wall and press to mark your mounting holes/);
  assert.match(html, /Fasten the wall mount at your marks/);
  assert.match(html, /medium Command strips/);
  assert.match(html, /peel the liners/);
  assert.match(html, /won't adjust once it's stuck/);
  assert.match(html, /Take the backing out of the frame and set the X-Frame in its place/);
  assert.match(html, /Put a clip on each corner/);
  assert.match(html, /press them down over the X-Frame instead/);
  assert.match(html, /Hang it on the wall mount/);
  assert.match(html, /just about anything you want to hang/);
  assert.match(html, /about five seconds/);
  assert.doesNotMatch(html, /frames, signs, boards/i);
});

test("sitemap and product section point at the how-to", () => {
  assert.match(worker, /const SITEMAP_PATHS = \[[^\]]*"\/how-it-works"/);
  const tag = index.match(/<video id="products-howto-player"[^>]*>/)[0];
  assert.ok(tag.includes("controls") && !/\bautoplay\b/.test(tag));
  assert.match(index, /href="\/how-it-works"/);
  assert.match(index, /<source src="\/xframe-howto\.mp4" type="video\/mp4"/);
});
