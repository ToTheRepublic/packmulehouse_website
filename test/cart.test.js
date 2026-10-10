import test from "node:test";
import assert from "node:assert/strict";
import { aggregateCartLines, parseQuantity, previewAllocation } from "../src/cart.js";

const openMto = { open: true, enabled: true, remaining: 50, max: 50 };

test("one line of 6 against stock 3 needs 3 made-to-order units", () => {
  const result = previewAllocation(
    [{ variationId: "peel", quantity: 6 }],
    { peel: 3 },
    openMto
  );
  assert.equal(result.totalMto, 3);
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].quantity, 6);
  assert.equal(result.lines[0].inStockQty, 3);
  assert.equal(result.lines[0].mtoQty, 3);
});

test("two lines of 3 for the same variation are aggregated before stock is applied", () => {
  const result = previewAllocation(
    [
      { variationId: "peel", quantity: 3 },
      { variationId: "peel", quantity: 3 },
    ],
    { peel: 3 },
    openMto
  );
  assert.equal(result.error, undefined);
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].quantity, 6);
  assert.equal(result.totalMto, 3);
  assert.equal(result.lines[0].inStockQty, 3);
});

test("per-item max applies to the combined quantity", () => {
  const result = aggregateCartLines([
    { variationId: "peel", quantity: 11 },
    { variationId: "peel", quantity: 11 },
  ]);
  assert.match(result.error, /at most 20/);
});

test("quantity must be an integer from 1 to 20", () => {
  assert.match(parseQuantity(1.5).error, /whole number/);
  assert.match(parseQuantity(-5).error, /whole number/);
  assert.match(parseQuantity(0).error, /whole number/);
  assert.match(parseQuantity(21).error, /whole number/);
  assert.match(parseQuantity("1.5").error, /whole number/);
  assert.match(parseQuantity(true).error, /whole number/);
  assert.equal(parseQuantity(1).quantity, 1);
  assert.equal(parseQuantity(20).quantity, 20);
  assert.equal(parseQuantity("4").quantity, 4);
});

test("more than 25 lines is rejected", () => {
  const items = Array.from({ length: 26 }, (_, i) => ({
    variationId: `v${i}`,
    quantity: 1,
  }));
  assert.equal(aggregateCartLines(items).error, "Too many line items");
});

test("made-to-order pool is shared across different variations", () => {
  const mto = { open: true, enabled: true, remaining: 5, max: 50 };
  const over = previewAllocation(
    [
      { variationId: "a", quantity: 3 },
      { variationId: "b", quantity: 3 },
    ],
    { a: 0, b: 0 },
    mto
  );
  assert.match(over.error, /need 6/);

  const ok = previewAllocation(
    [
      { variationId: "a", quantity: 3 },
      { variationId: "b", quantity: 2 },
    ],
    { a: 0, b: 0 },
    mto
  );
  assert.equal(ok.totalMto, 5);
});

test("untracked stock is treated as in stock", () => {
  const result = previewAllocation(
    [{ variationId: "poster", quantity: 2 }],
    { poster: null },
    { open: false, enabled: false, remaining: 0, max: 50 }
  );
  assert.equal(result.totalMto, 0);
  assert.equal(result.lines[0].inStockQty, 2);
});
