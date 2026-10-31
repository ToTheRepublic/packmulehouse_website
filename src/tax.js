/**
 * Shelf prices already include tax (market pricing) unless TAX_MODE=added.
 * Added mode charges TAX_PERCENT on top. Included mode sends no tax to Square.
 */

export const TAX_NOTE = "Prices include tax";

export function taxMode(env) {
  const raw = String(env?.TAX_MODE ?? "included").trim().toLowerCase();
  if (raw === "added" || raw === "exclusive" || raw === "extra") return "added";
  return "included";
}

export function taxPercent(env) {
  const n = Number(env?.TAX_PERCENT);
  return Number.isFinite(n) && n >= 0 ? n : 6;
}

export function taxName(env) {
  return (env?.TAX_NAME || "Sales Tax").trim() || "Sales Tax";
}

export function taxAppliesToShipping(env) {
  const v = env?.TAX_APPLIES_TO_SHIPPING;
  if (v === false || v === "false" || v === "0") return false;
  return true;
}

/** A separate tax line is charged only in added mode with a positive rate. */
export function chargesSeparateTax(env) {
  return taxMode(env) === "added" && taxPercent(env) > 0;
}

export function taxConfigPublic(env) {
  const mode = taxMode(env);
  const percent = taxPercent(env);
  const included = mode !== "added";
  const chargesTax = chargesSeparateTax(env);
  return {
    mode,
    included,
    chargesTax,
    percent,
    name: taxName(env),
    appliesToShipping: taxAppliesToShipping(env),
    label: included ? "Included" : percent > 0 ? `${percent}%` : "None",
    note: included ? TAX_NOTE : "",
  };
}

/** Extra tax cents when mode is added. Included mode always returns 0. */
export function addedTaxCents(env, subtotalCents, shippingCentsAmt, discountCents = 0) {
  if (!chargesSeparateTax(env)) return 0;
  const merch = Math.max(0, (subtotalCents || 0) - (discountCents || 0));
  const base = merch + (taxAppliesToShipping(env) ? shippingCentsAmt || 0 : 0);
  return Math.round((base * taxPercent(env)) / 100);
}

/** subtotal − discounts + shipping + any separate tax. */
export function checkoutTotalCents({ subtotal = 0, discount = 0, shipping = 0, tax = 0 }) {
  return Math.max(0, subtotal - discount) + shipping + (tax || 0);
}

/**
 * Website orders and quotes never auto-apply Square pricing rules: the site
 * sells at shelf price (packs carry their own price). The rules stay in Square
 * for in-person sales. Included mode does not add a tax and turns off
 * location tax rules so they are not stacked on shelf prices.
 */
export function applyOrderTax(env, order) {
  const cfg = taxConfigPublic(env);
  order.pricing_options = {
    ...(order.pricing_options || {}),
    auto_apply_discounts: false,
    auto_apply_taxes: false,
  };
  if (Array.isArray(order.service_charges)) {
    for (const charge of order.service_charges) {
      charge.taxable = Boolean(cfg.chargesTax && cfg.appliesToShipping);
    }
  }
  if (cfg.chargesTax) {
    order.taxes = [
      {
        uid: "SALES_TAX",
        name: cfg.name,
        percentage: String(cfg.percent),
        scope: "ORDER",
      },
    ];
  } else {
    delete order.taxes;
  }
  return cfg;
}

/**
 * Quote figures from a Square CalculateOrder/CreateOrder response.
 * `amount` is Square's total. `matchesSquare` is true when that total equals
 * subtotal − discounts + shipping + separate tax (0 when tax is included).
 */
export function totalsFromSquareOrder(order, { subtotal, shipping, env }) {
  const taxCfg = taxConfigPublic(env);
  const discount = order?.total_discount_money?.amount || 0;
  const squareTax = order?.total_tax_money?.amount || 0;
  const amount = order?.total_money?.amount || 0;
  const tax = taxCfg.chargesTax ? squareTax : 0;
  const expected = checkoutTotalCents({ subtotal, discount, shipping, tax });
  const discounts = order?.discounts || [];
  return {
    subtotal,
    discount,
    discountLabel: discounts.map((d) => d.name).filter(Boolean).join(", ") || null,
    shipping,
    tax,
    amount,
    expected,
    matchesSquare: amount === expected,
    currency: order?.total_money?.currency || "USD",
    taxCfg,
    appliedDiscounts: discounts.map((d) => ({
      name: d.name,
      percentage: d.percentage,
      amount: d.applied_money?.amount || 0,
      catalogObjectId: d.catalog_object_id || null,
    })),
  };
}
