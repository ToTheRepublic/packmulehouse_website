import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildPromos, normalizePromoName, promoSummary } from "../src/promos.js";

// Real (read-only) Square production DISCOUNT/PRICING_RULE/PRODUCT_SET objects.
const objects = JSON.parse(
  fs.readFileSync(new URL("./fixtures/square-promos.json", import.meta.url), "utf8")
);
const shop = [
  {
    id: "MUDBGMGUXMQOU27I4GLEXM6I",
    name: "X-Frame Complete Kit",
    categoryIds: ["XFRAMECAT"],
    categoryNames: ["X-Frame"],
    variations: [
      { id: "DESGHCDBJCM6GNRSBBHQKMWY" },
      { id: "AW6DCEW3YXATUM6ZFYTGH4MQ" },
      { id: "7U2KH4UA36JGNLYQOKHO6L5Q" },
      { id: "ZIUUGDSMGYXIWDTEPQQ7CBQ6" },
    ],
  },
  { id: "KEY", name: "Keychain", categoryIds: ["K"], categoryNames: ["Wind River Canyon Keychain"], variations: [{ id: "IZTNYNNT4PEAXOSJ5CPIZDFP" }] },
];

test("only rules that can apply to shop items are shown", () => {
  const r = buildPromos(objects, shop);
  assert.deepEqual(r.promos.map((p) => p.id), ["Z6FCLMUIWKHLY2BZDTMCTMHV", "CW4LTSLZZGNKAFDDHOCF6IDM"]);
  assert.equal(r.summary, "X-Frame kits: 10% off 3+ · 20% off 5+");
  assert.equal(r.promos[0].label, "10% off 3+ X-Frame kits");
  assert.deepEqual(r.promos[0].appliesTo.length, 4);
  assert.ok(!r.promos[0].appliesTo.includes("IZTNYNNT4PEAXOSJ5CPIZDFP"));
});

test("names de-duplicate case- and punctuation-insensitively", () => {
  assert.equal(normalizePromoName("2 for ($5 Off)"), normalizePromoName("2 For  ($5 off)"));
  const r = buildPromos(objects, null); // no shop filter
  const labels = r.promos.map((p) => p.label);
  assert.equal(labels.filter((l) => /^2 for/i.test(l)).length, 1);
  assert.ok(!/2 For \(\$5 Off\).*2 for/i.test(r.summary));
});

test("empty promo list summary", () => {
  assert.match(promoSummary([]), /^None/);
});

test("checkout locks page scroll while open and restores the offset", () => {
  const js = fs.readFileSync(new URL("../public/checkout.js", import.meta.url), "utf8");
  assert.match(js, /function lockPageScroll/);
  assert.match(js, /position = "fixed"/);
  assert.match(js, /window\.scrollTo\(0, y\)/);
  assert.match(js, /lockPageScroll\(\);\s*\n\s*if \(step === "pay"\)/);
  assert.match(js, /unlockPageScroll\(\);/);
});
