import test from "node:test";
import assert from "node:assert/strict";
import { packComponents, unitDemand, distributeAllocation, PACK_COMPONENTS_BY_SKU } from "../src/packs.js";
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
