import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { findJsonLdProduct, injectProductOffers, offersFromProduct } from "../src/jsonld.js";
import {
  cachedCatalogSnapshot,
  catalogTtlMs,
  resetCatalogCache,
  withProductJsonLd,
} from "../src/worker.js";

// Load the browser script the way the page does (a classic script).
const sandbox = { Intl };
vm.runInNewContext(
  fs.readFileSync(new URL("../public/variant-picker.js", import.meta.url), "utf8"),
  sandbox
);
const raw = sandbox.PMHPicker;
// Results come from another realm; copy them into this one for deepEqual.
const picker = Object.fromEntries(
  Object.entries(raw).map(([k, f]) => [k, (...a) => { const r = f(...a); return (r && r.constructor && r.constructor.name === "Map") ? new Map(r) : r && typeof r === "object" ? JSON.parse(JSON.stringify(r)) : r; }])
);

// Shape of /api/catalog products (as mapped from Square). Prices here are
// test fixtures, deliberately different from the shelf prices, to prove
// nothing on the page is hard-coded.
const xframe = {
  id: "ITEM1",
  name: "X-Frame Complete Kit",
  categoryNames: ["X-Frame"],
  imageUrl: "https://items-images.example/xf.jpg",
  priceLabel: "$21.00",
  variations: [
    { id: "V46", name: "4x6 Drop In Complete Kit", amount: 2100, currency: "USD", priceLabel: "$21.00", availability: "in_stock" },
    { id: "V57", name: "5x7 Drop In Complete Kit", amount: 2500, currency: "USD", priceLabel: "$25.00", availability: "low" },
    { id: "V810", name: "8x10 Drop In Complete Kit", amount: 3300, currency: "USD", priceLabel: "$33.00", availability: "mto" },
    { id: "VPS", name: "Peel and Stick Complete Kit (Existing Frames)", amount: 2800, currency: "USD", priceLabel: "$28.00", availability: "unavailable" },
  ],
};
const keychain = {
  id: "ITEM2",
  name: "Keychain",
  categoryNames: ["Wind River Canyon Keychain"],
  variations: [{ id: "VK", name: "Regular", amount: 1000, currency: "USD", priceLabel: "$10.00" }],
};
const ORIGIN = "https://shop.example";
const read = (f) => fs.readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8");
const ldOf = (html) =>
  JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
const productNode = (html) => ldOf(html)["@graph"].find((n) => n["@type"] === "Product");

test("picker: 'Starting at' lowest price until a size is picked, then that size's price", () => {
  assert.equal(picker.needsPicker(xframe), true);
  assert.equal(picker.needsPicker(keychain), false);
  assert.deepEqual(picker.priceDisplay(xframe, null), { from: true, label: "$21.00" });
  assert.deepEqual(picker.priceDisplay(xframe, "V810"), { from: false, label: "$33.00" });
  assert.deepEqual(picker.priceDisplay(xframe, "nope"), { from: true, label: "$21.00" });
  assert.deepEqual(picker.priceDisplay(keychain, null), { from: false, label: "$10.00" });
});

test("picker: selected variation id is what goes in the cart; no pick, no add", () => {
  assert.equal(picker.selectedVariation(xframe, "VPS").id, "VPS");
  assert.equal(picker.selectedVariation(xframe, null), null);
  assert.equal(picker.selectedVariation(keychain, null).id, "VK");
});

test("picker: four Square variations become short size labels", () => {
  assert.equal(picker.pickerLabel(xframe), "Size");
  assert.equal(picker.pickerLabel(keychain), "Option");
  assert.deepEqual([...picker.optionLabels(xframe).values()], [
    "4x6 Drop In",
    "5x7 Drop In",
    "8x10 Drop In",
    "Peel and Stick (Existing Frames)",
  ]);
});

test("checkout.js sends the picked variation and loads the picker first", () => {
  const js = read("checkout.js");
  assert.match(js, /addToCart\(p, pickQty, selectedId\)/);
  assert.match(js, /picker\.selectedVariation\(product, variationId\)/);
  const html = read("index.html");
  assert.ok(html.indexOf("/variant-picker.js") < html.indexOf("/checkout.js"));
});

test("index.html ships no hard-coded product prices", () => {
  const html = read("index.html");
  const node = productNode(html);
  assert.equal(node.offers, undefined);
  assert.doesNotMatch(html, /"price"\s*:|lowPrice|highPrice/);
});

test("offers come from the Square product: prices, names, ids, availability", () => {
  assert.equal(findJsonLdProduct([keychain, xframe]).id, "ITEM1");
  const o = offersFromProduct(xframe, ORIGIN);
  assert.equal(o.lowPrice, "21.00");
  assert.equal(o.highPrice, "33.00");
  assert.equal(o.offerCount, 4);
  assert.deepEqual(o.offers.map((x) => [x.sku, x.price]), [
    ["V46", "21.00"], ["V57", "25.00"], ["V810", "33.00"], ["VPS", "28.00"],
  ]);
  assert.deepEqual(o.offers.map((x) => x.availability.split("/").pop()), [
    "InStock", "LimitedAvailability", "BackOrder", "OutOfStock",
  ]);
  assert.equal(o.offers[0].seller["@id"], `${ORIGIN}/#organization`);
});

test("JSON-LD injection writes Square offers and stays valid JSON", async () => {
  const html = read("index.html").replaceAll("__SITE_ORIGIN__", ORIGIN);
  const out = await withProductJsonLd(html, {}, ORIGIN, async () => ({ products: [xframe, keychain] }));
  const node = productNode(out);
  assert.equal(node.offers.lowPrice, "21.00");
  assert.equal(node.offers.offers.length, 4);
  assert.ok(node.image.includes(xframe.imageUrl));
  assert.equal(ldOf(out)["@graph"][0]["@type"], "Organization");
});

test("Square down: last good offers from KV, else no offers, never broken JSON", async () => {
  const html = read("index.html").replaceAll("__SITE_ORIGIN__", ORIGIN);
  const store = new Map();
  const kv = { get: async (k) => store.get(k) ?? null, put: async (k, v) => void store.set(k, v) };
  const fail = async () => { throw new Error("Square 503"); };

  const none = await withProductJsonLd(html, { MTO_STATE: kv }, ORIGIN, fail);
  assert.equal(productNode(none).offers, undefined);

  await withProductJsonLd(html, { MTO_STATE: kv }, ORIGIN, async () => ({ products: [xframe] }));
  const cached = await withProductJsonLd(html, { MTO_STATE: kv }, ORIGIN, fail);
  assert.equal(productNode(cached).offers.highPrice, "33.00");

  const missing = await withProductJsonLd(html, {}, ORIGIN, async () => ({ products: [keychain] }));
  assert.equal(productNode(missing).offers, undefined);
});

test("JSON-LD escapes '<' so a Square name can't close the script", () => {
  const evil = { ...xframe, variations: [{ ...xframe.variations[0], name: "</script><b>" }] };
  const out = injectProductOffers(read("index.html"), offersFromProduct(evil, ORIGIN));
  const block = out.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];
  assert.doesNotMatch(block, /<\/script>|<b>/);
  assert.equal(JSON.parse(block)["@graph"][1].offers.offers[0].name, "</script><b>");
});

test("catalog snapshot is cached for CATALOG_TTL_SECONDS (default 60s)", async () => {
  assert.equal(catalogTtlMs({}), 60000);
  assert.equal(catalogTtlMs({ CATALOG_TTL_SECONDS: "15" }), 15000);
  resetCatalogCache();
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    const body = String(url).includes("/catalog/list") ? { objects: [] } : { counts: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    const env = { SQUARE_ACCESS_TOKEN: "test", SQUARE_ENVIRONMENT: "sandbox" };
    await cachedCatalogSnapshot(env);
    await cachedCatalogSnapshot(env);
    assert.equal(calls, 1);
    await cachedCatalogSnapshot(env, Date.now() + 61000);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = realFetch;
    resetCatalogCache();
  }
});
