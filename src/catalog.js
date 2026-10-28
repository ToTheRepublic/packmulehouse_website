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

/**
 * Ordered shop sections. Commas separate entries so names can contain spaces.
 * An entry is a Square category name or id ("X-Frame"), or a section label
 * followed by "=" and one or more categories separated by "|"
 * ("X-Frames = X-Frame | X-Frame Add-Ons").
 */
export function shopCategoryGroups(env) {
  return String(env?.SHOP_CATEGORIES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf("=");
      if (eq < 0) return { name: entry, keys: [entry] };
      const name = entry.slice(0, eq).trim();
      const keys = entry
        .slice(eq + 1)
        .split("|")
        .map((k) => k.trim())
        .filter(Boolean);
      return { name: name || keys[0] || "", keys: keys.length ? keys : [name] };
    })
    .filter((g) => g.name);
}

/** Section labels, in shop order. */
export function shopCategoryLabels(env) {
  return shopCategoryGroups(env).map((g) => g.name);
}

/**
 * Unset SHOP_CATEGORIES, SQUARE_CATEGORY_ID, and SQUARE_ITEM_IDS means every
 * catalog item. SHOP_CATEGORIES accepts category names or ids, in shop order.
 */
export function catalogFilterFromEnv(env) {
  const ids = splitIds(env?.SQUARE_ITEM_IDS);
  const cats = splitIds(env?.SQUARE_CATEGORY_ID);
  const groups = shopCategoryGroups(env);
  const shop = groups.map((g) => g.name);
  return {
    active: ids.length > 0 || cats.length > 0 || shop.length > 0,
    ids: new Set(ids),
    cats: new Set(cats),
    shop,
    groups,
    shopKeys: new Set(groups.flatMap((g) => g.keys).map((s) => s.toLowerCase())),
  };
}

/** Category ids from the current categories array and the legacy category_id. */
export function itemCategoryIds(itemData) {
  const ids = [];
  const push = (id) => {
    if (!id || ids.includes(id)) return;
    ids.push(id);
  };
  if (!itemData) return ids;
  if (itemData.category_id) push(itemData.category_id);
  if (itemData.reporting_category?.id) push(itemData.reporting_category.id);
  for (const c of itemData.categories || []) {
    if (typeof c === "string") push(c);
    else push(c?.id || c?.category_id);
  }
  return ids;
}

function nameFor(namesById, id) {
  if (!namesById || !id) return "";
  if (typeof namesById.get === "function") return namesById.get(id) || "";
  return namesById[id] || "";
}

function matchesShopCategory(filter, id, name) {
  if (!filter?.shopKeys?.size) return false;
  if (id && filter.shopKeys.has(String(id).toLowerCase())) return true;
  const label = String(name || "").trim().toLowerCase();
  return Boolean(label) && filter.shopKeys.has(label);
}

export function itemAllowed(itemObj, filter, namesById) {
  if (!filter?.active) return true;
  if (filter.ids.has(itemObj?.id)) return true;
  const ids = itemCategoryIds(itemObj?.item_data);
  for (const id of ids) {
    if (filter.cats.has(id)) return true;
    if (matchesShopCategory(filter, id, nameFor(namesById, id))) return true;
  }
  return false;
}

/**
 * One section per configured category, in that order. Empty categories are
 * omitted. An item in more than one configured category is listed in each.
 * Returns null when the shop list is unset so the storefront stays one grid.
 */
export function productSections(products, shopLabels) {
  if (!shopLabels?.length) return null;
  const sections = [];
  for (const entry of shopLabels) {
    const group = typeof entry === "string" ? { name: entry, keys: [entry] } : entry;
    const wanted = group.keys.map((k) => String(k).trim().toLowerCase());
    const matched = (products || []).filter((p) => {
      const keys = [...(p.categoryIds || []), ...(p.categoryNames || [])]
        .map((s) => String(s || "").trim().toLowerCase())
        .filter(Boolean);
      return keys.some((k) => wanted.includes(k));
    });
    if (matched.length) sections.push({ name: group.name, products: matched });
  }
  return sections;
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

/**
 * Storefront copy without stock signals (low-stock count, made-to-order and
 * unavailable labels). Used while online checkout is off, so shoppers don't
 * see counts they can't act on yet.
 */
export function withoutStockSignals(products) {
  const strip = (o) => ({ ...o, lowStock: null, stockDisplay: null, stockTone: null });
  return (products || []).map((p) => ({
    ...strip(p),
    variations: (p.variations || []).map(strip),
  }));
}
