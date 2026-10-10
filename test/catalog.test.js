import test from "node:test";
import assert from "node:assert/strict";
import {
  catalogFilterFromEnv,
  collectTrackedVariationIds,
  decorateVariation,
  itemAllowed,
  itemCategoryIds,
  presentAtLocation,
  productSections,
  publicMto,
  shopCategoryLabels,
  variationTracksInventory,
} from "../src/catalog.js";

const mtoOpen = { open: true, enabled: true, remaining: 50, max: 50 };

test("location-level inventory tracking is detected", () => {
  const vd = {
    track_inventory: false,
    location_overrides: [{ location_id: "LOC", track_inventory: true }],
  };
  assert.equal(variationTracksInventory(vd, "LOC"), true);
  assert.equal(variationTracksInventory({ track_inventory: true }, "LOC"), true);
  assert.equal(
    variationTracksInventory(
      {
        track_inventory: true,
        location_overrides: [{ location_id: "LOC", track_inventory: false }],
      },
      "LOC"
    ),
    false
  );

  const ids = collectTrackedVariationIds(
    [
      {
        type: "ITEM",
        item_data: {
          variations: [
            { id: "loc-only", item_variation_data: vd },
            {
              id: "untracked",
              item_variation_data: { track_inventory: false },
            },
          ],
        },
      },
    ],
    "LOC"
  );
  assert.deepEqual(ids, ["loc-only"]);
});

test("public catalog hides exact stock above the threshold and MTO remaining", () => {
  const plenty = decorateVariation(
    { id: "v", name: "Kit", amount: 100, currency: "USD", priceLabel: "$1.00", trackInventory: true, stock: 15, rawStock: 15 },
    mtoOpen,
    10
  );
  assert.equal(plenty.lowStock, null);
  assert.equal(plenty.availability, "in_stock");
  assert.equal("stock" in plenty, false);
  assert.equal("rawStock" in plenty, false);

  const low = decorateVariation(
    { id: "v", name: "Kit", amount: 100, currency: "USD", priceLabel: "$1.00", trackInventory: true, stock: 3 },
    mtoOpen,
    10
  );
  assert.equal(low.lowStock, 3);
  assert.equal(low.stockDisplay, "Only 3 left");

  const mto = decorateVariation(
    { id: "v", name: "Kit", amount: 100, currency: "USD", priceLabel: "$1.00", trackInventory: true, stock: 0 },
    mtoOpen,
    10
  );
  assert.equal(mto.availability, "mto");
  assert.equal(mto.lowStock, null);

  assert.deepEqual(publicMto({ open: true, remaining: 12, max: 50, enabled: true, promise: "Soon" }), {
    open: true,
    promise: "Soon",
  });
});

test("catalog filter is a no-op until configured", () => {
  const open = catalogFilterFromEnv({});
  assert.equal(itemAllowed({ id: "x", item_data: {} }, open), true);

  const cats = catalogFilterFromEnv({ SQUARE_CATEGORY_ID: "CAT_FRAMES" });
  const item = {
    id: "item",
    item_data: { categories: [{ id: "CAT_FRAMES" }] },
  };
  assert.equal(itemAllowed(item, cats), true);
  assert.equal(itemAllowed({ id: "other", item_data: { category_id: "CAT_DINOS" } }, cats), false);

  const ids = catalogFilterFromEnv({ SQUARE_ITEM_IDS: "keep-me, also-this" });
  assert.equal(itemAllowed({ id: "keep-me", item_data: {} }, ids), true);
  assert.equal(itemAllowed({ id: "nope", item_data: {} }, ids), false);
});

test("shop categories match names case-insensitively and ids, in order", () => {
  assert.deepEqual(
    shopCategoryLabels({ SHOP_CATEGORIES: "X-Frame, Wind River Canyon, Keychains" }),
    ["X-Frame", "Wind River Canyon", "Keychains"]
  );
  const filter = catalogFilterFromEnv({
    SHOP_CATEGORIES: "X-Frame, Wind River Canyon, Keychains",
  });
  const names = new Map([
    ["CAT_X", "x-frame"],
    ["CAT_WIND", "Wind River Canyon"],
    ["CAT_KEY", "Keychains"],
    ["CAT_OTHER", "Posters"],
  ]);
  const xframe = {
    id: "item-x",
    item_data: { category_id: "CAT_X", categories: [{ id: "CAT_KEY" }] },
  };
  const posters = { id: "item-p", item_data: { categories: [{ id: "CAT_OTHER" }] } };
  const byId = { id: "item-id", item_data: { categories: [{ id: "keychains" }] } };
  assert.equal(itemAllowed(xframe, filter, names), true);
  assert.equal(itemAllowed(posters, filter, names), false);
  assert.equal(itemAllowed(byId, filter, names), true);
  assert.deepEqual(itemCategoryIds(xframe.item_data), ["CAT_X", "CAT_KEY"]);

  const products = [
    { id: "a", name: "Kit", categoryIds: ["CAT_X"], categoryNames: ["X-Frame"] },
    { id: "b", name: "Canyon", categoryIds: ["CAT_WIND"], categoryNames: ["Wind River Canyon"] },
    { id: "c", name: "Both", categoryIds: ["CAT_X", "CAT_KEY"], categoryNames: ["X-Frame", "Keychains"] },
  ];
  const sections = productSections(products, [
    ...filter.shop.slice(0, 1),
    "Posters",
    ...filter.shop.slice(1),
  ]);
  assert.deepEqual(
    sections.map((s) => [s.name, s.products.map((p) => p.id)]),
    [
      ["X-Frame", ["a", "c"]],
      ["Wind River Canyon", ["b"]],
      ["Keychains", ["c"]],
    ]
  );
  assert.equal(productSections(products, []), null);
});

test("location presence rejects absent and allowlisted locations", () => {
  assert.equal(presentAtLocation({ present_at_all_locations: true }, "L"), true);
  assert.equal(
    presentAtLocation({ present_at_all_locations: true, absent_at_location_ids: ["L"] }, "L"),
    false
  );
  assert.equal(
    presentAtLocation({ present_at_all_locations: false, present_at_location_ids: ["L"] }, "L"),
    true
  );
  assert.equal(
    presentAtLocation({ present_at_all_locations: false, present_at_location_ids: ["OTHER"] }, "L"),
    false
  );
});
