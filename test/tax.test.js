import test from "node:test";
import assert from "node:assert/strict";
import {
  TAX_NOTE,
  addedTaxCents,
  applyOrderTax,
  checkoutTotalCents,
  taxConfigPublic,
  taxMode,
  totalsFromSquareOrder,
} from "../src/tax.js";

const includedEnv = { TAX_MODE: "included", TAX_PERCENT: "6", TAX_NAME: "Sales Tax" };
const addedEnv = { TAX_MODE: "added", TAX_PERCENT: "6", TAX_APPLIES_TO_SHIPPING: "true" };

function sampleOrder() {
  return {
    location_id: "LOC",
    line_items: [{ quantity: "2", catalog_object_id: "var" }],
    service_charges: [
      {
        name: "Flat rate shipping",
        amount_money: { amount: 1000, currency: "USD" },
        calculation_phase: "SUBTOTAL_PHASE",
        taxable: true,
      },
    ],
  };
}

test("tax mode defaults to included and keeps the configured rate", () => {
  assert.equal(taxMode({}), "included");
  assert.equal(taxMode({ TAX_MODE: "INCLUSIVE" }), "included");
  const cfg = taxConfigPublic({ TAX_PERCENT: "6" });
  assert.equal(cfg.mode, "included");
  assert.equal(cfg.included, true);
  assert.equal(cfg.chargesTax, false);
  assert.equal(cfg.percent, 6);
  assert.equal(cfg.note, TAX_NOTE);
  assert.equal(addedTaxCents({ TAX_PERCENT: "6" }, 4000, 1000, 500), 0);
});

test("included orders have no tax line and still auto-apply discounts", () => {
  const order = sampleOrder();
  const cfg = applyOrderTax(includedEnv, order);
  assert.equal(cfg.chargesTax, false);
  assert.equal(order.taxes, undefined);
  assert.equal(order.pricing_options.auto_apply_discounts, true);
  assert.equal(order.pricing_options.auto_apply_taxes, false);
  assert.equal(order.service_charges[0].taxable, false);
});

test("included quote total is subtotal minus discounts plus shipping and matches Square", () => {
  const subtotal = 4000;
  const discount = 500;
  const shipping = 1000;
  const square = {
    total_discount_money: { amount: discount, currency: "USD" },
    total_tax_money: { amount: 0, currency: "USD" },
    total_money: { amount: checkoutTotalCents({ subtotal, discount, shipping, tax: 0 }), currency: "USD" },
    discounts: [{ name: "4+ items", percentage: "10", applied_money: { amount: discount } }],
  };
  const totals = totalsFromSquareOrder(square, { subtotal, shipping, env: includedEnv });
  assert.equal(totals.tax, 0);
  assert.equal(totals.discount, 500);
  assert.equal(totals.amount, 4500);
  assert.equal(totals.expected, 4500);
  assert.equal(totals.matchesSquare, true);
  assert.equal(totals.appliedDiscounts[0].name, "4+ items");
  assert.equal(totals.taxCfg.note, TAX_NOTE);
});

test("added mode charges TAX_PERCENT on merchandise and shipping", () => {
  const order = sampleOrder();
  const cfg = applyOrderTax(addedEnv, order);
  assert.equal(cfg.chargesTax, true);
  assert.equal(cfg.note, "");
  assert.equal(order.taxes.length, 1);
  assert.equal(order.taxes[0].percentage, "6");
  assert.equal(order.taxes[0].scope, "ORDER");
  assert.equal(order.pricing_options.auto_apply_discounts, true);
  assert.equal(order.pricing_options.auto_apply_taxes, false);
  assert.equal(order.service_charges[0].taxable, true);

  const subtotal = 4000;
  const discount = 500;
  const shipping = 1000;
  const tax = addedTaxCents(addedEnv, subtotal, shipping, discount);
  assert.equal(tax, 270);
  const square = {
    total_discount_money: { amount: discount },
    total_tax_money: { amount: tax },
    total_money: { amount: checkoutTotalCents({ subtotal, discount, shipping, tax }) },
    discounts: [{ name: "Volume", applied_money: { amount: discount } }],
  };
  const totals = totalsFromSquareOrder(square, { subtotal, shipping, env: addedEnv });
  assert.equal(totals.tax, 270);
  assert.equal(totals.amount, 4770);
  assert.equal(totals.matchesSquare, true);
});

test("added mode can tax merchandise only", () => {
  const env = { TAX_MODE: "added", TAX_PERCENT: "6", TAX_APPLIES_TO_SHIPPING: "false" };
  const order = sampleOrder();
  applyOrderTax(env, order);
  assert.equal(order.service_charges[0].taxable, false);
  assert.equal(addedTaxCents(env, 4000, 1000, 500), 210);
});

test("a zero rate in added mode does not invent a tax line", () => {
  const env = { TAX_MODE: "added", TAX_PERCENT: "0" };
  const cfg = taxConfigPublic(env);
  assert.equal(cfg.chargesTax, false);
  assert.equal(cfg.included, false);
  const order = sampleOrder();
  applyOrderTax(env, order);
  assert.equal(order.taxes, undefined);
  assert.equal(addedTaxCents(env, 2000, 1000, 0), 0);
});
