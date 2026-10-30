/**
 * Product JSON-LD driven from the Square catalog.
 *
 * public/index.html ships an Organization + Product graph with no prices.
 * The Worker fills the Product's offers server-side from the same mapped
 * catalog the storefront uses, so crawlers see current Square prices without
 * running JavaScript. If Square is unreachable it falls back to the last good
 * offers (KV), and failing that leaves the Product without offers. The JSON
 * is always re-serialized, so the block stays valid either way.
 */

const AVAILABILITY = {
  in_stock: "https://schema.org/InStock",
  low: "https://schema.org/LimitedAvailability",
  mto: "https://schema.org/BackOrder",
  unavailable: "https://schema.org/OutOfStock",
};

/** Default: the Product node whose @id ends with #x-frame, fed by Square category "X-Frame". */
export const JSONLD_PRODUCT_ANCHOR = "#x-frame";
export const JSONLD_DEFAULT_CATEGORY = "X-Frame";

function money(amountCents) {
  return (Number(amountCents) / 100).toFixed(2);
}

/** Pick the Square product for the JSON-LD Product (category name or id, else item name match). */
export function findJsonLdProduct(products, key = JSONLD_DEFAULT_CATEGORY) {
  const want = String(key || "").trim().toLowerCase();
  if (!want) return null;
  const list = products || [];
  const byCategory = list.find((p) =>
    [...(p.categoryNames || []), ...(p.categoryIds || [])].some(
      (c) => String(c).trim().toLowerCase() === want
    )
  );
  if (byCategory) return byCategory;
  return list.find((p) => String(p.name || "").toLowerCase().includes(want)) || null;
}

/** schema.org AggregateOffer for one mapped catalog product, or null. */
export function offersFromProduct(product, origin) {
  const vars = (product?.variations || []).filter(
    (v) => Number.isFinite(Number(v.amount)) && Number(v.amount) > 0
  );
  if (!vars.length) return null;
  const currency = vars[0].currency || "USD";
  const amounts = vars.map((v) => Number(v.amount));
  const url = `${origin}/#products`;
  return {
    "@type": "AggregateOffer",
    priceCurrency: currency,
    lowPrice: money(Math.min(...amounts)),
    highPrice: money(Math.max(...amounts)),
    offerCount: vars.length,
    offers: vars.map((v) => ({
      "@type": "Offer",
      name: v.name,
      sku: v.id,
      price: money(v.amount),
      priceCurrency: v.currency || currency,
      availability: AVAILABILITY[v.availability] || AVAILABILITY.in_stock,
      url,
      seller: { "@id": `${origin}/#organization` },
    })),
  };
}

const LD_RE = /(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/;

/** JSON safe inside a <script> element. */
export function scriptSafeJson(value) {
  return JSON.stringify(value, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

/**
 * Set (or remove, when offers is null) the offers on the anchored Product node.
 * Returns the html unchanged if there is no parseable JSON-LD block.
 */
export function injectProductOffers(html, offers, { anchor = JSONLD_PRODUCT_ANCHOR, product } = {}) {
  const m = String(html).match(LD_RE);
  if (!m) return html;
  let data;
  try {
    data = JSON.parse(m[2]);
  } catch {
    return html;
  }
  const nodes = Array.isArray(data?.["@graph"]) ? data["@graph"] : [data];
  const node = nodes.find(
    (n) => n && n["@type"] === "Product" && String(n["@id"] || "").endsWith(anchor)
  );
  if (!node) return html;
  if (offers) node.offers = offers;
  else delete node.offers;
  if (product?.imageUrl) {
    const imgs = Array.isArray(node.image) ? node.image : node.image ? [node.image] : [];
    if (!imgs.includes(product.imageUrl)) node.image = [...imgs, product.imageUrl];
  }
  return html.replace(LD_RE, (_, open, __, close) => `${open}\n${scriptSafeJson(data)}\n  ${close}`);
}
