import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("checkout locks page scroll while open and restores the offset", () => {
  const js = fs.readFileSync(new URL("../public/checkout.js", import.meta.url), "utf8");
  assert.match(js, /function lockPageScroll/);
  assert.match(js, /position = "fixed"/);
  assert.match(js, /window\.scrollTo\(0, y\)/);
  assert.match(js, /lockPageScroll\(\);\s*\n\s*if \(step === "pay"\)/);
  assert.match(js, /unlockPageScroll\(\);/);
});

test("empty cart hides shipping and total rows", () => {
  const js = fs.readFileSync(new URL("../public/checkout.js", import.meta.url), "utf8");
  assert.match(js, /shipRow\.hidden = !cart\.length/);
  assert.match(js, /totalRow\.hidden = !cart\.length/);
});

test("admin console has a test-notification button wired to /api/notify-test", () => {
  const html = fs.readFileSync(new URL("../public/pmh-console.html", import.meta.url), "utf8");
  const js = fs.readFileSync(new URL("../public/pmh-console.js", import.meta.url), "utf8");
  assert.match(html, /id="btn-notify-test"/);
  assert.match(js, /api\("\/api\/notify-test"/);
});

test("homepage renders a Gallery Packs section with contents and verified savings", () => {
  const js = fs.readFileSync(new URL("../public/checkout.js", import.meta.url), "utf8");
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(js, /if \(section\.name === "Gallery Packs"\) block\.id = "gallery-packs"/);
  assert.match(js, /intro\.className = "product-section-intro"/);
  assert.match(js, /intro\.textContent = section\.intro/);
  assert.match(js, /save\.className = "pack-savings"/);
  assert.match(js, /save\.textContent = p\.savingsLabel/);
  assert.match(js, /p\.isPack \? " pack-card" : ""/);
  assert.equal(/10%\s*off/i.test(js), false);
  assert.equal(/20%\s*off/i.test(js), false);
  assert.match(html, /\.product-section-intro/);
  assert.match(html, /\.pack-savings/);
});
