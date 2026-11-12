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

/** Format cents the same way the storefront shows prices. */
function moneyLabel(cents, currency = "USD") {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format((cents || 0) / 100);
  } catch {
    return `$${((cents || 0) / 100).toFixed(2)}`;
  }
}

/**
 * Pull each pack variation's contents clause from the Square item description.
 * Looks for "Variation Name: …" and takes the text until the next named
 * variation or the end. Returns a map of variation name → clause. Clauses
 * that are not in the description are omitted — never invented.
 */
export function packContentsByVariation(description, variationNames) {
  const desc = String(description || "");
  const names = [...new Set((variationNames || []).map((n) => String(n || "").trim()).filter(Boolean))];
  if (!desc || !names.length) return {};
  const lower = desc.toLowerCase();
  const hits = [];
  for (const name of names) {
    const needle = `${name.toLowerCase()}:`;
    const idx = lower.indexOf(needle);
    if (idx < 0) continue;
    hits.push({ name, start: idx, bodyStart: idx + needle.length });
  }
  hits.sort((a, b) => a.start - b.start);
  const out = {};
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].start : desc.length;
    let text = desc.slice(hits[i].bodyStart, end).trim();
    text = text.replace(/^[,;\s]+/, "").replace(/[\s.]+$/g, "").trim();
    if (!text) continue;
    text = text.charAt(0).toUpperCase() + text.slice(1);
    out[hits[i].name] = /[.!?]$/.test(text) ? text : `${text}.`;
  }
  return out;
}

/**
 * Opening sentences of the item description, before the first
 * "Variation Name:" clause. Empty string when there is no such lead-in.
 */
export function packIntroFromDescription(description, variationNames) {
  const desc = String(description || "").trim();
  if (!desc) return "";
  const lower = desc.toLowerCase();
  let cut = desc.length;
  for (const name of variationNames || []) {
    const needle = `${String(name || "").trim().toLowerCase()}:`;
    if (!needle.startsWith(":")) {
      const idx = lower.indexOf(needle);
      if (idx >= 0 && idx < cut) cut = idx;
    }
  }
  return desc.slice(0, cut).trim().replace(/[\s.]+$/g, (m) => (m.includes(".") ? "." : ""));
}

/**
 * Fallback contents line from the pack's component map and the catalog's
 * own kit variation names. Used only when the item description has no clause
 * for that pack. Counts and names come from Square data already on the site.
 */
export function contentsFromComponents(components, nameByVariationId) {
  if (!components) return "";
  const parts = [];
  for (const [id, n] of Object.entries(components)) {
    const name = nameByVariationId instanceof Map ? nameByVariationId.get(id) : nameByVariationId?.[id];
    if (!name || !n) return "";
    parts.push(`${n} × ${name}`);
  }
  if (!parts.length) return "";
  if (parts.length === 1) return `${parts[0]}.`;
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}.`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}.`;
}

/**
 * Pack price versus the sum of its single-kit shelf prices. Returns null
 * when any component price is missing or the pack is not cheaper, so the
 * storefront can omit the savings line rather than guess.
 */
export function packSavings(packAmount, components, priceByVariationId) {
  if (!components || packAmount == null) return null;
  let singlesTotalCents = 0;
  let kitCount = 0;
  for (const [id, n] of Object.entries(components)) {
    const entry = priceByVariationId instanceof Map ? priceByVariationId.get(id) : priceByVariationId?.[id];
    const amount = typeof entry === "number" ? entry : entry?.amount;
    if (amount == null || Number.isNaN(Number(amount)) || !n) return null;
    singlesTotalCents += Number(amount) * n;
    kitCount += n;
  }
  const savingsCents = singlesTotalCents - packAmount;
  if (savingsCents <= 0 || kitCount <= 0) return null;
  return {
    singlesTotalCents,
    savingsCents,
    kitCount,
    savingsPerKitCents: Math.round(savingsCents / kitCount),
  };
}

export function packSavingsLabel(savings, currency = "USD") {
  if (!savings || savings.savingsCents <= 0) return null;
  const pack = moneyLabel(savings.savingsCents, currency);
  const per = moneyLabel(savings.savingsPerKitCents, currency);
  return `Save ${pack} (${per} per kit) versus buying the kits separately`;
}

/**
 * Mark pack variations with contents and verified savings, using SKUs to
 * match PACK_COMPONENTS_BY_SKU and catalog prices for the kits inside.
 * `skuByVariationId` is not copied onto the public variation.
 */
export function annotateGalleryPacks(products, skuByVariationId) {
  const list = products || [];
  const priceById = new Map();
  const nameById = new Map();
  for (const p of list) {
    for (const v of p.variations || []) {
      priceById.set(v.id, { amount: v.amount, currency: v.currency, name: v.name });
      nameById.set(v.id, v.name);
    }
  }
  for (const p of list) {
    const names = (p.variations || []).map((v) => v.name);
    const byName = packContentsByVariation(p.description, names);
    for (const v of p.variations || []) {
      const sku = skuByVariationId instanceof Map ? skuByVariationId.get(v.id) : skuByVariationId?.[v.id];
      const components = packComponents(sku);
      if (!components) continue;
      const contents = byName[v.name] || contentsFromComponents(components, nameById);
      const savings = packSavings(v.amount, components, priceById);
      v.isPack = true;
      if (contents) v.contents = contents;
      if (savings) {
        v.singlesTotalCents = savings.singlesTotalCents;
        v.savingsCents = savings.savingsCents;
        v.savingsPerKitCents = savings.savingsPerKitCents;
        v.savingsLabel = packSavingsLabel(savings, v.currency || "USD");
      }
    }
  }
  return list;
}

function packCard(product, variation) {
  return {
    id: `${product.id}:${variation.id}`,
    name: variation.name,
    description: variation.contents || "",
    contents: variation.contents || null,
    savingsLabel: variation.savingsLabel || null,
    savingsCents: variation.savingsCents ?? null,
    savingsPerKitCents: variation.savingsPerKitCents ?? null,
    singlesTotalCents: variation.singlesTotalCents ?? null,
    imageUrl: variation.imageUrl || product.imageUrl || null,
    variations: [variation],
    priceLabel: variation.priceLabel,
    amount: variation.amount,
    currency: variation.currency,
    defaultVariationId: variation.id,
    trackInventory: variation.trackInventory,
    lowStock: variation.lowStock,
    stockDisplay: variation.stockDisplay,
    stockTone: variation.stockTone,
    availability: variation.availability,
    maxQty: variation.maxQty,
    mtoOpen: product.mtoOpen,
    leadTimeWeeks: variation.leadTimeWeeks ?? product.leadTimeWeeks,
    leadTimeLabel: variation.leadTimeLabel ?? product.leadTimeLabel,
    categoryIds: product.categoryIds,
    categoryNames: product.categoryNames,
    isPack: true,
    packItemId: product.id,
    packItemName: product.name,
  };
}

export const GALLERY_PACKS_SECTION_NAME = "Gallery Packs";

/**
 * Lift pack items out of ordinary shop sections and add a "Gallery Packs"
 * section with one card per pack variation, placed just after the section
 * that used to hold the pack item (typically X-Frames).
 */
export function featureGalleryPacks(sections, products) {
  const packItems = (products || []).filter((p) =>
    (p.variations || []).some((v) => v.isPack)
  );
  if (!packItems.length) return sections;

  const packIds = new Set(packItems.map((p) => p.id));
  const cards = [];
  const intros = [];
  for (const p of packItems) {
    const intro = packIntroFromDescription(
      p.description,
      (p.variations || []).map((v) => v.name)
    );
    if (intro) intros.push(intro);
    for (const v of p.variations || []) {
      if (v.isPack) cards.push(packCard(p, v));
    }
  }
  if (!cards.length) return sections;

  const section = {
    name: GALLERY_PACKS_SECTION_NAME,
    products: cards,
  };
  if (intros[0]) section.intro = intros[0];

  if (!Array.isArray(sections) || !sections.length) return [section];

  const out = [];
  let inserted = false;
  for (const s of sections) {
    const remaining = (s.products || []).filter((p) => !packIds.has(p.id));
    if (remaining.length) out.push({ ...s, products: remaining });
    if (!inserted && (s.products || []).some((p) => packIds.has(p.id))) {
      out.push(section);
      inserted = true;
    }
  }
  if (!inserted) out.unshift(section);
  return out;
}
