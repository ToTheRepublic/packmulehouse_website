import test from "node:test";
import assert from "node:assert/strict";
import { packComponents, unitDemand, distributeAllocation, PACK_COMPONENTS_BY_SKU,
  packContentsByVariation,
  packIntroFromDescription,
  contentsFromComponents,
  packSavings,
  packSavingsLabel,
  annotateGalleryPacks,
  featureGalleryPacks,
  GALLERY_PACKS_SECTION_NAME,
} from "../src/packs.js";
import { allocateMerged } from "../src/cart.js";
import { applyOrderTax } from "../src/tax.js";
import { findJsonLdProduct } from "../src/jsonld.js";

const K46 = "DESGHCDBJCM6GNRSBBHQKMWY", K57 = "AW6DCEW3YXATUM6ZFYTGH4MQ", K810 = "7U2KH4UA36JGNLYQOKHO6L5Q";

function allocate(lines, stock, mto) {
  const demand = unitDemand(lines);
  const r = allocateMerged(demand, stock, mto);
  if (r.error) return r;
  const per = {};
  for (const l of r.lines) per[l.variationId] = { inStock: l.inStockQty, mto: l.mtoQty };
  return { lines: distributeAllocation(lines, per), totalMto: r.totalMto };
}

test("every pack holds exactly five kits", () => {
  for (const [sku, c] of Object.entries(PACK_COMPONENTS_BY_SKU)) {
    assert.equal(Object.values(c).reduce((a, b) => a + b, 0), 5, sku);
  }
  assert.deepEqual(packComponents("xfmix-5pk"), { [K46]: 2, [K57]: 2, [K810]: 1 });
  assert.equal(packComponents("XF0046"), null);
});

test("a pack with no shelf stock uses five MTO slots", () => {
  const pack = { variationId: "P46", quantity: 1, components: { [K46]: 5 }, trackInventory: false };
  const r = allocate([pack], { [K46]: 0 }, { open: true, remaining: 50 });
  assert.equal(r.totalMto, 5);
  assert.equal(r.lines[0].mtoQty, 5);
});

test("singles and packs share shelf stock (no double count)", () => {
  const single = { variationId: K46, quantity: 2, trackInventory: true };
  const pack = { variationId: "P46", quantity: 1, components: { [K46]: 5 } };
  const r = allocate([single, pack], { [K46]: 4 }, { open: true, remaining: 50 });
  assert.equal(r.lines[0].inStockQty, 2);
  assert.equal(r.lines[1].inStockQty, 2);
  assert.equal(r.lines[1].mtoQty, 3);
  assert.equal(r.totalMto, 3);
  assert.deepEqual(r.lines[1].componentAlloc, [{ variationId: K46, inStock: 2, mto: 3 }]);
});

test("packs can't exceed MTO capacity", () => {
  const pack = { variationId: "PMIX", quantity: 2, components: { [K46]: 2, [K57]: 2, [K810]: 1 } };
  const r = allocate([pack], { [K46]: 0, [K57]: 0, [K810]: 0 }, { open: true, remaining: 9 });
  assert.equal(r.status, 409);
  const closed = allocate([pack], { [K46]: 0, [K57]: 0, [K810]: 0 }, { open: false, remaining: 50 });
  assert.equal(closed.status, 409);
});

test("website orders never auto-apply Square discounts", () => {
  const order = {};
  applyOrderTax({ TAX_MODE: "included" }, order);
  assert.equal(order.pricing_options.auto_apply_discounts, false);
});

test("JSON-LD still describes the single kit, not the pack", () => {
  const products = [
    { name: "X-Frame Complete Kit", categoryNames: ["X-Frame"] },
    { name: "X-Frame Gallery Pack", categoryNames: ["X-Frame"] },
  ];
  assert.equal(findJsonLdProduct(products, "X-Frame").name, "X-Frame Complete Kit");
});


const PACK_DESCRIPTION =
  "Five X-Frame Complete Kits in one pack, for a gallery wall. Each kit is a frame backing and wall mount. 4x6 5-Pack: five 4x6 Drop In kits. 5x7 5-Pack: five 5x7 Drop In kits. 8x10 5-Pack: five 8x10 Drop In kits. Peel and Stick 5-Pack: five Peel and Stick kits for frames you already own. Mixed Gallery Wall 5-Pack: two 4x6, two 5x7 and one 8x10 Drop In kit.";

const PACK_NAMES = [
  "4x6 5-Pack",
  "5x7 5-Pack",
  "8x10 5-Pack",
  "Peel and Stick 5-Pack",
  "Mixed Gallery Wall 5-Pack",
];

const K_PEEL = "ZIUUGDSMGYXIWDTEPQQ7CBQ6";

function shopProducts() {
  const kits = {
    id: "KIT",
    name: "X-Frame Complete Kit",
    categoryNames: ["X-Frame"],
    variations: [
      { id: K46, name: "4x6 Drop In Complete Kit", amount: 2200, currency: "USD", priceLabel: "$22.00" },
      { id: K57, name: "5x7 Drop In Complete Kit", amount: 2600, currency: "USD", priceLabel: "$26.00" },
      { id: K810, name: "8x10 Drop In Complete Kit", amount: 3200, currency: "USD", priceLabel: "$32.00" },
      { id: K_PEEL, name: "Peel and Stick Complete Kit (Existing Frames)", amount: 2700, currency: "USD", priceLabel: "$27.00" },
    ],
  };
  const packs = {
    id: "UNFNDN4ZTUNZYOGAG7DJDN44",
    name: "X-Frame Gallery Pack",
    description: PACK_DESCRIPTION,
    categoryNames: ["X-Frame"],
    imageUrl: "https://example.com/item.jpg",
    variations: [
      { id: "P46", name: "4x6 5-Pack", amount: 9500, currency: "USD", priceLabel: "$95.00", imageUrl: "https://example.com/4x6.jpg" },
      { id: "P57", name: "5x7 5-Pack", amount: 11000, currency: "USD", priceLabel: "$110.00", imageUrl: "https://example.com/5x7.jpg" },
      { id: "P810", name: "8x10 5-Pack", amount: 13500, currency: "USD", priceLabel: "$135.00", imageUrl: null },
      { id: "PPS", name: "Peel and Stick 5-Pack", amount: 11500, currency: "USD", priceLabel: "$115.00", imageUrl: "https://example.com/peel.jpg" },
      { id: "PMIX", name: "Mixed Gallery Wall 5-Pack", amount: 10900, currency: "USD", priceLabel: "$109.00", imageUrl: null },
    ],
  };
  const canyon = { id: "W", name: "Wind River Canyon (large)", categoryNames: ["Wind River Canyon Models"], variations: [{ id: "W1", name: "Dark Mode", amount: 20000 }] };
  return [kits, packs, canyon];
}

const SKUS = {
  P46: "XF0046-5PK",
  P57: "XF0057-5PK",
  P810: "XF0810-5PK",
  PPS: "XF00PS-5PK",
  PMIX: "XFMIX-5PK",
};

test("pack contents are taken from the Square item description, never invented", () => {
  const byName = packContentsByVariation(PACK_DESCRIPTION, PACK_NAMES);
  assert.equal(byName["4x6 5-Pack"], "Five 4x6 Drop In kits.");
  assert.equal(byName["5x7 5-Pack"], "Five 5x7 Drop In kits.");
  assert.equal(byName["8x10 5-Pack"], "Five 8x10 Drop In kits.");
  assert.equal(byName["Peel and Stick 5-Pack"], "Five Peel and Stick kits for frames you already own.");
  assert.equal(byName["Mixed Gallery Wall 5-Pack"], "Two 4x6, two 5x7 and one 8x10 Drop In kit.");
  assert.deepEqual(packContentsByVariation("", PACK_NAMES), {});
  assert.deepEqual(packContentsByVariation("A pack of kits.", PACK_NAMES), {});
  assert.equal(
    packIntroFromDescription(PACK_DESCRIPTION, PACK_NAMES),
    "Five X-Frame Complete Kits in one pack, for a gallery wall. Each kit is a frame backing and wall mount."
  );
});

test("pack savings use single-kit Square prices and are omitted when unverified", () => {
  const prices = { [K46]: 2200, [K57]: 2600, [K810]: 3200, [K_PEEL]: 2700 };
  const five46 = packSavings(9500, { [K46]: 5 }, prices);
  assert.deepEqual(five46, { singlesTotalCents: 11000, savingsCents: 1500, kitCount: 5, savingsPerKitCents: 300 });
  assert.equal(packSavingsLabel(five46), "Save $15.00 ($3.00 per kit) versus buying the kits separately");

  const mixed = packSavings(10900, { [K46]: 2, [K57]: 2, [K810]: 1 }, prices);
  assert.equal(mixed.singlesTotalCents, 12800);
  assert.equal(mixed.savingsCents, 1900);
  assert.equal(mixed.savingsPerKitCents, 380);

  assert.equal(packSavings(9500, { [K46]: 5 }, {}), null);
  assert.equal(packSavings(11000, { [K46]: 5 }, prices), null);
  assert.equal(
    contentsFromComponents({ [K46]: 2, [K57]: 2, [K810]: 1 }, {
      [K46]: "4x6 Drop In Complete Kit",
      [K57]: "5x7 Drop In Complete Kit",
      [K810]: "8x10 Drop In Complete Kit",
    }),
    "2 × 4x6 Drop In Complete Kit, 2 × 5x7 Drop In Complete Kit, and 1 × 8x10 Drop In Complete Kit."
  );
});

test("featureGalleryPacks lifts pack variations into a section after X-Frames", () => {
  const products = shopProducts();
  annotateGalleryPacks(products, SKUS);
  const packItem = products.find((p) => p.id === "UNFNDN4ZTUNZYOGAG7DJDN44");
  assert.equal(packItem.variations.every((v) => v.isPack), true);
  assert.equal(packItem.variations[0].contents, "Five 4x6 Drop In kits.");
  assert.equal(packItem.variations[0].savingsCents, 1500);
  assert.equal(packItem.variations[4].savingsCents, 1900);
  assert.equal(packItem.variations[2].savingsCents, 2500);

  const sections = [
    { name: "X-Frames", products: [products[0], products[1]] },
    { name: "Wind River Canyon Models", products: [products[2]] },
  ];
  const featured = featureGalleryPacks(sections, products);
  assert.deepEqual(
    featured.map((s) => [s.name, s.products.map((p) => p.name)]),
    [
      ["X-Frames", ["X-Frame Complete Kit"]],
      [
        GALLERY_PACKS_SECTION_NAME,
        [
          "4x6 5-Pack",
          "5x7 5-Pack",
          "8x10 5-Pack",
          "Peel and Stick 5-Pack",
          "Mixed Gallery Wall 5-Pack",
        ],
      ],
      ["Wind River Canyon Models", ["Wind River Canyon (large)"]],
    ]
  );
  const packSection = featured[1];
  assert.match(packSection.intro, /Five X-Frame Complete Kits in one pack/);
  assert.equal(packSection.intro.includes("10%"), false);
  assert.equal(packSection.intro.includes("20%"), false);
  const mix = packSection.products[4];
  assert.equal(mix.isPack, true);
  assert.equal(mix.defaultVariationId, "PMIX");
  assert.equal(mix.variations.length, 1);
  assert.equal(mix.amount, 10900);
  assert.equal(mix.contents, "Two 4x6, two 5x7 and one 8x10 Drop In kit.");
  assert.equal(mix.savingsLabel, "Save $19.00 ($3.80 per kit) versus buying the kits separately");
  assert.equal(mix.imageUrl, "https://example.com/item.jpg");
  assert.equal(packSection.products[0].imageUrl, "https://example.com/4x6.jpg");
});
