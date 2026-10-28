/**
 * Cart quantity rules and in-stock vs made-to-order allocation.
 * Duplicate lines for the same variation are merged before stock is checked.
 */

import { allocateUnits } from "./mto.js";

export const MAX_LINE_QTY = 20;
export const MAX_CART_LINES = 25;

export function parseQuantity(quantity, max = MAX_LINE_QTY) {
  let n;
  if (typeof quantity === "number" && Number.isFinite(quantity)) {
    if (!Number.isInteger(quantity)) {
      return { error: `Quantity must be a whole number from 1 to ${max}` };
    }
    n = quantity;
  } else if (typeof quantity === "string" && /^[0-9]+$/.test(quantity.trim())) {
    n = Number(quantity.trim());
    if (!Number.isInteger(n)) {
      return { error: `Quantity must be a whole number from 1 to ${max}` };
    }
  } else {
    return { error: `Quantity must be a whole number from 1 to ${max}` };
  }
  if (n < 1 || n > max) {
    return { error: `Quantity must be a whole number from 1 to ${max}` };
  }
  return { quantity: n };
}

/**
 * Merge lines that share a variation. The per-item max applies to the total,
 * not to each duplicate line on its own.
 */
export function aggregateCartLines(
  rawItems,
  { maxQty = MAX_LINE_QTY, maxLines = MAX_CART_LINES } = {}
) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { error: "Cart is empty" };
  }
  if (rawItems.length > maxLines) {
    return { error: "Too many line items" };
  }

  const totals = new Map();
  const order = [];
  for (const line of rawItems) {
    const variationId = line && (line.variationId || line.variation_id);
    if (variationId == null || String(variationId).trim() === "") {
      return { error: "Each cart line needs a variationId" };
    }
    const id = String(variationId).trim();
    const parsed = parseQuantity(line?.quantity, maxQty);
    if (parsed.error) return { error: parsed.error };
    if (!totals.has(id)) order.push(id);
    const next = (totals.get(id) || 0) + parsed.quantity;
    if (next > maxQty) {
      return {
        error: `You can order at most ${maxQty} of each item (got ${next}).`,
      };
    }
    totals.set(id, next);
  }

  return {
    items: order.map((variationId) => ({
      variationId,
      quantity: totals.get(variationId),
    })),
  };
}

/**
 * Allocate already-resolved lines. Same variation is merged again so a caller
 * that skipped aggregateCartLines still cannot spend shelf stock twice.
 */
export function allocateMerged(lines, stockByVariation, mtoState) {
  const merged = new Map();
  const order = [];
  for (const line of lines) {
    const id = line.variationId;
    const prev = merged.get(id);
    if (!prev) {
      merged.set(id, { ...line, quantity: line.quantity });
      order.push(id);
    } else {
      prev.quantity += line.quantity;
    }
  }

  let totalMto = 0;
  const problems = [];
  const out = [];

  for (const id of order) {
    const line = merged.get(id);
    const tracked = !!line.trackInventory;
    const known = Object.prototype.hasOwnProperty.call(stockByVariation, id);
    const stock = tracked ? (known ? stockByVariation[id] ?? 0 : 0) : null;
    const alloc = allocateUnits(stock, line.quantity, mtoState);
    if (!alloc.ok) {
      problems.push(`${line.itemName || id}: ${alloc.error}`);
      continue;
    }
    out.push({
      ...line,
      quantity: line.quantity,
      inStockQty: alloc.inStock,
      mtoQty: alloc.mto,
      stockAtOrder: stock,
      lineTotal:
        line.unitAmount != null ? line.unitAmount * line.quantity : line.lineTotal,
    });
    totalMto += alloc.mto;
  }

  if (problems.length) {
    return { error: problems.join(" "), status: 409 };
  }

  if (totalMto > 0) {
    if (!mtoState.open) {
      return {
        error: "Made-to-order is on standby. Reduce quantities to what is in stock.",
        status: 409,
      };
    }
    if (totalMto > mtoState.remaining) {
      return {
        error: `Not enough made-to-order capacity for this cart (need ${totalMto}, ${mtoState.remaining} left).`,
        status: 409,
      };
    }
  }

  return { lines: out, totalMto, mto: mtoState };
}

/** Test helper: aggregate raw lines, then allocate against a stock map. */
export function previewAllocation(rawItems, stockByVariation, mtoState) {
  const agg = aggregateCartLines(rawItems);
  if (agg.error) return agg;
  const lines = agg.items.map((item) => {
    const stock = stockByVariation[item.variationId];
    return {
      variationId: item.variationId,
      quantity: item.quantity,
      itemName: item.variationId,
      trackInventory: stock != null,
    };
  });
  return allocateMerged(lines, stockByVariation, mtoState);
}
