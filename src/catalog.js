/**
 * Catalog filtering, inventory-tracking detection, and the public product shape.
 * Exact shelf counts stay on the server. The storefront gets a low-stock
 * number only under the threshold, plus an in-stock / MTO flag.
 */

import { maxOrderable } from "./mto.js";

export function variationTracksInventory(vd, locationId) {
  const override = (vd?.location_overrides || []).find(
    (o) => o.location_id === locationId
  );
  if (override && typeof override.track_inventory === "boolean") {
    return override.track_inventory;
  }
  return !!vd?.track_inventory;
}

export function presentAtLocation(obj, locationId) {
  if (!obj) return false;
  if (!locationId) return true;
  const absent = obj.absent_at_location_ids || [];
  if (absent.includes(locationId)) return false;
  if (obj.present_at_all_locations === false) {
    return (obj.present_at_location_ids || []).includes(locationId);
  }
  return true;
}

function splitIds(value) {
  return String(value || "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Unset filter means every catalog item (sandbox). */
export function catalogFilterFromEnv(env) {
  const ids = splitIds(env?.SQUARE_ITEM_IDS);
  const cats = splitIds(env?.SQUARE_CATEGORY_ID);
  return {
    active: ids.length > 0 || cats.length > 0,
    ids: new Set(ids),
    cats: new Set(cats),
  };
}

export function itemCategoryIds(itemData) {
  const ids = [];
  if (!itemData) return ids;
  if (itemData.category_id) ids.push(itemData.category_id);
  if (itemData.reporting_category?.id) ids.push(itemData.reporting_category.id);
  for (const c of itemData.categories || []) {
    if (c?.id) ids.push(c.id);
  }
  return ids;
}

export function itemAllowed(itemObj, filter) {
  if (!filter?.active) return true;
  if (filter.ids.has(itemObj?.id)) return true;
  return itemCategoryIds(itemObj?.item_data).some((id) => filter.cats.has(id));
}

export function collectTrackedVariationIds(objects, locationId) {
  const ids = [];
  for (const o of objects || []) {
    if (o.type !== "ITEM" || o.is_deleted) continue;
    for (const v of o.item_data?.variations || []) {
      if (v.is_deleted) continue;
      if (variationTracksInventory(v.item_variation_data, locationId)) {
        ids.push(v.id);
      }
    }
  }
  return ids;
}

/**
 * Public variation. `stock` and `rawStock` are not copied through.
 * `lowStock` is set only when 0 < shelf < threshold.
 */
export function decorateVariation(v, mto, threshold) {
  const tracked = !!v.trackInventory;
  const shelf = tracked ? Math.max(0, Number(v.stock) || 0) : null;
  let stockDisplay = null;
  let stockTone = null;
  let availability = "in_stock";
  let lowStock = null;

  if (tracked && shelf != null) {
    if (shelf <= 0) {
      if (mto?.open) {
        stockDisplay = "Made to order";
        stockTone = "mto";
        availability = "mto";
      } else {
        stockDisplay = "Currently unavailable";
        stockTone = "out";
        availability = "unavailable";
      }
    } else if (shelf < threshold) {
      lowStock = shelf;
      stockDisplay = `Only ${shelf} left`;
      stockTone = "fomo";
      availability = "low";
    }
  }

  return {
    id: v.id,
    name: v.name,
    amount: v.amount,
    currency: v.currency,
    priceLabel: v.priceLabel,
    trackInventory: tracked,
    lowStock,
    stockDisplay,
    stockTone,
    availability,
    maxQty: maxOrderable(tracked ? shelf : null, mto),
  };
}

export function publicMto(mto) {
  return {
    open: !!mto?.open,
    promise: mto?.promise || "",
  };
}
