import test from "node:test";
import assert from "node:assert/strict";
import { typeForPath, withAssetType } from "../src/content-type.js";

test("typeForPath maps common asset extensions", () => {
  assert.match(typeForPath("/site-footer.css"), /^text\/css/);
  assert.match(typeForPath("/promo-video.js"), /^text\/javascript/);
  assert.equal(typeForPath("/xframe-promo.mp4"), "video/mp4");
  assert.equal(typeForPath("/xframe-promo.webm"), "video/webm");
  assert.equal(typeForPath("/xframe-photo-720.webp"), "image/webp");
  assert.equal(typeForPath("/unknown.zzz"), null);
  assert.equal(typeForPath("/noext"), null);
});

test("withAssetType fixes octet-stream and missing types only", async () => {
  const bad = new Response("x", { headers: { "Content-Type": "application/octet-stream" } });
  assert.match(withAssetType(bad, "/a.css").headers.get("Content-Type"), /^text\/css/);
  const none = new Response(new Uint8Array([1]));
  none.headers.delete("Content-Type");
  assert.equal(withAssetType(none, "/v.mp4").headers.get("Content-Type"), "video/mp4");
  const good = new Response("x", { headers: { "Content-Type": "image/png" } });
  assert.equal(withAssetType(good, "/a.css"), good);
  const unknown = new Response("x", { headers: { "Content-Type": "application/octet-stream" } });
  assert.equal(withAssetType(unknown, "/a.zzz"), unknown);
});
