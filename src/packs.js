/**
 * X-Frame Gallery Packs. Each pack is its own Square variation (its own price,
 * not tracked in Square). For stock and made-to-order slots the site treats a
 * pack as the single kits inside it, so packs and singles draw on the same
 * shelf stock and the same MTO capacity and can't oversell either.
 *
 * Keys are pack variation SKUs in Square; values map single-kit variation ids
 * to how many of each are in one pack.
 */
const KIT_4X6 = "DESGHCDBJCM6GNRSBBHQKMWY";
const KIT_5X7 = "AW6DCEW3YXATUM6ZFYTGH4MQ";
const KIT_8X10 = "7U2KH4UA36JGNLYQOKHO6L5Q";
const KIT_PEEL = "ZIUUGDSMGYXIWDTEPQQ7CBQ6";

export const PACK_COMPONENTS_BY_SKU = {
  "XF0046-5PK": { [KIT_4X6]: 5 },
  "XF0057-5PK": { [KIT_5X7]: 5 },
  "XF0810-5PK": { [KIT_8X10]: 5 },
  "XF00PS-5PK": { [KIT_PEEL]: 5 },
  "XFMIX-5PK": { [KIT_4X6]: 2, [KIT_5X7]: 2, [KIT_8X10]: 1 },
};

export function packComponents(sku) {
  const c = PACK_COMPONENTS_BY_SKU[String(sku || "").trim().toUpperCase()];
  return c ? { ...c } : null;
}

/**
 * Turn resolved cart lines into per-variation unit demand. A pack line adds
 * its components x quantity; a single adds itself.
 * Returns [{ variationId, quantity, trackInventory, itemName }].
 */
export function unitDemand(lines) {
  const map = new Map();
  const add = (id, qty, tracked, name) => {
    const prev = map.get(id);
    if (prev) prev.quantity += qty;
    else map.set(id, { variationId: id, quantity: qty, trackInventory: tracked, itemName: name });
  };
  for (const l of lines) {
    if (l.components) {
      for (const [id, n] of Object.entries(l.components)) add(id, n * l.quantity, true, l.itemName);
    } else {
      add(l.variationId, l.quantity, !!l.trackInventory, l.itemName);
    }
  }
  return [...map.values()];
}

/**
 * Spread per-variation allocation ({ id: { inStock, mto } }) back onto the
 * cart lines. Singles take shelf stock first, then packs in cart order.
 */
export function distributeAllocation(lines, perVariation) {
  const left = {};
  for (const [id, a] of Object.entries(perVariation)) left[id] = { inStock: a.inStock, mto: a.mto };
  const take = (id, n) => {
    const pool = left[id] || { inStock: n, mto: 0 };
    const s = Math.min(n, pool.inStock);
    pool.inStock -= s;
    const m = n - s;
    pool.mto = Math.max(0, pool.mto - m);
    left[id] = pool;
    return { inStock: s, mto: m };
  };
  const singles = lines.filter((l) => !l.components);
  const packs = lines.filter((l) => l.components);
  const out = new Map();
  for (const l of singles) {
    const t = take(l.variationId, l.quantity);
    out.set(l, { ...l, inStockQty: t.inStock, mtoQty: t.mto });
  }
  for (const l of packs) {
    let inStock = 0;
    let mto = 0;
    const componentAlloc = [];
    for (const [id, n] of Object.entries(l.components)) {
      const t = take(id, n * l.quantity);
      inStock += t.inStock;
      mto += t.mto;
      componentAlloc.push({ variationId: id, inStock: t.inStock, mto: t.mto });
    }
    out.set(l, { ...l, inStockQty: inStock, mtoQty: mto, componentAlloc });
  }
  return lines.map((l) => out.get(l));
}
