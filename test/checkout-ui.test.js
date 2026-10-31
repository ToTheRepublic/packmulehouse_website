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
