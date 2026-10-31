/**
 * Turn Square DISCOUNT / PRICING_RULE / PRODUCT_SET objects into the offers the
 * shop shows. Only automatic rules that can match something the shop sells are
 * kept, so rules for market-only products (flags, magnets, …) never show up.
 * Display names are de-duplicated case- and space-insensitively.
 */

export function normalizePromoName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Leaf ids (items, variations, categories) a product set can match. */
export function productSetLeafIds(setId, productSets, seen = new Set()) {
  const out = { all: false, ids: new Set() };
  if (seen.has(setId)) return out;
  seen.add(setId);
  const ps = productSets.get(setId);
  if (!ps) return out;
  const d = ps.product_set_data || {};
  if (d.all_products) out.all = true;
  for (const id of [...(d.product_ids_any || []), ...(d.product_ids_all || [])]) {
    if (productSets.has(id)) {
      const sub = productSetLeafIds(id, productSets, seen);
      if (sub.all) out.all = true;
      sub.ids.forEach((x) => out.ids.add(x));
    } else {
      out.ids.add(id);
    }
  }
  return out;
}

/** Shop variation ids a set of leaf ids covers. */
function matchedVariations(leaf, products) {
  const hit = [];
  for (const p of products || []) {
    const pHit =
      leaf.all ||
      leaf.ids.has(p.id) ||
      (p.categoryIds || []).some((c) => leaf.ids.has(c));
    for (const v of p.variations || []) {
      if (pHit || leaf.ids.has(v.id)) hit.push({ product: p, variationId: v.id });
    }
  }
  return hit;
}

function scopeLabel(hits) {
  const products = [...new Set(hits.map((h) => h.product))];
  if (products.length !== 1) return "items";
  const p = products[0];
  const cat = (p.categoryNames || [])[0];
  const base = cat || p.name || "";
  if (!base) return "items";
  return /kit/i.test(p.name || "") ? `${base} kits` : `${base} items`;
}

function money(cents) {
  const n = Number(cents || 0) / 100;
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/**
 * @param {object[]} objects Square catalog objects (DISCOUNT, PRICING_RULE, PRODUCT_SET)
 * @param {object[]|null} products Shop products (/api/catalog shape). null = no filtering.
 */
export function buildPromos(objects, products) {
  const discounts = new Map();
  const productSets = new Map();
  const rules = [];
  for (const o of objects || []) {
    if (o.is_deleted) continue;
    if (o.type === "DISCOUNT") discounts.set(o.id, o);
    else if (o.type === "PRICING_RULE") rules.push(o);
    else if (o.type === "PRODUCT_SET") productSets.set(o.id, o);
  }
  const today = new Date().toISOString().slice(0, 10);
  const promos = [];
  for (const rule of rules) {
    const rd = rule.pricing_rule_data || {};
    if (rd.application_mode && rd.application_mode !== "AUTOMATIC") continue;
    if (rd.valid_until_date && rd.valid_until_date < today) continue;
    if (rd.valid_from_date && rd.valid_from_date > today) continue;
    const disc = discounts.get(rd.discount_id);
    if (!disc) continue;
    const dd = disc.discount_data || {};
    const pset = productSets.get(rd.match_products_id);
    const leaf = productSetLeafIds(rd.match_products_id, productSets);
    let appliesTo = null;
    let scope = "items";
    if (products) {
      const hits = matchedVariations(leaf, products);
      if (!hits.length) continue; // rule can't apply to anything sold online
      appliesTo = [...new Set(hits.map((h) => h.variationId))];
      scope = scopeLabel(hits);
    }
    const qmin = pset?.product_set_data?.quantity_min;
    const percent = dd.percentage ? Number(dd.percentage) : null;
    const minItems = qmin != null ? Number(qmin) : null;
    const name = dd.name || rd.name || "Discount";
    let label = name;
    if (minItems && percent != null) label = `${percent}% off ${minItems}+ ${scope}`;
    else if (minItems && dd.amount_money) label = `${money(dd.amount_money.amount)} off ${minItems}+ ${scope}`;
    promos.push({
      id: disc.id,
      ruleId: rule.id,
      name,
      label,
      scope,
      percent,
      amountMoney: dd.amount_money || null,
      discountType: dd.discount_type || null,
      minItems,
      ruleName: rd.name || null,
      appliesTo,
    });
  }
  promos.sort((a, b) => (a.minItems || 0) - (b.minItems || 0));
  // De-dupe by normalized display label.
  const seen = new Set();
  const unique = [];
  for (const p of promos) {
    const key = normalizePromoName(p.label);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }
  return { source: "square_catalog", promos: unique, summary: promoSummary(unique) };
}

/** "X-Frame kits: 10% off 3+ · 20% off 5+" */
export function promoSummary(promos) {
  if (!promos.length) return "None (manage in Square Dashboard)";
  const tiers = new Map();
  const other = [];
  for (const p of promos) {
    if (p.minItems && p.percent != null) {
      if (!tiers.has(p.scope)) tiers.set(p.scope, []);
      tiers.get(p.scope).push(`${p.percent}% off ${p.minItems}+`);
    } else other.push(p.label);
  }
  const parts = [];
  for (const [scope, t] of tiers) {
    const s = scope.charAt(0).toUpperCase() + scope.slice(1);
    parts.push(`${s}: ${t.join(" · ")}`);
  }
  return [...parts, ...other].join(" · ");
}
