/**
 * Pack Mule House — Cloudflare Worker
 * Catalog, cart checkout, Square Orders + Payments, inventory, MTO, admin.
 */

import { parseAddress } from "./address.js";
import { aggregateCartLines, allocateMerged, MAX_CART_LINES, parseQuantity } from "./cart.js";
import {
  catalogFilterFromEnv,
  collectTrackedVariationIds,
  decorateVariation,
  itemAllowed,
  itemCategoryIds,
  productSections,
  withoutStockSignals,
  presentAtLocation,
  publicMto,
  variationTracksInventory,
} from "./catalog.js";
import { applySecurityHeaders, shouldNoindex } from "./headers.js";
import { idempotencyKey, parseAttemptId } from "./idempotency.js";
import {
  abortCheckout,
  clientIp,
  completeCheckout,
  createAdminToken,
  extractBearer,
  getMtoState,
  isAdminHost,
  loginClear,
  loginFail,
  loginStatus,
  lowStockThreshold,
  MtoCounter,
  mtoPromise,
  passwordsMatch,
  reserveCheckout,
  resetMto,
  setMtoState,
  verifyAdminToken,
} from "./mto.js";
import { discordSafe, headerSafe, plainSafe, telegramSafe } from "./sanitize.js";
import { paymentErrorMessage } from "./payments.js";
import { applyOrderTax, taxConfigPublic, totalsFromSquareOrder } from "./tax.js";
import {
  applePayAssociation,
  flatRateShippingPhrase,
  leadTimeLabel,
  leadTimePolicySentence,
  leadTimeRulesFromEnv,
  leadTimeWeeks,
} from "./shipping.js";

export { MtoCounter };

const SQUARE_VERSION = "2025-01-23";
const SHIPPING_CENTS = 1000; // $10.00 flat
const MERCHANT_NOTIFY_EMAIL = "packmulehouse@gmail.com";

function squareBase(env) {
  return env.SQUARE_ENVIRONMENT === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function error(message, status = 400) {
  return json({ error: message }, status);
}

function clientSafeError(e, fallback, status = 502) {
  console.error(fallback, e?.message, e?.details || "");
  if (e?.publicMessage) return error(e.publicMessage, e.status || 400);
  return error(fallback, status);
}

function publicFail(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  err.publicMessage = message;
  return err;
}

function createLookupCache() {
  return { discounts: null, objects: new Map() };
}

async function squareFetch(env, path, { method = "GET", body } = {}) {
  const token = env.SQUARE_ACCESS_TOKEN;
  if (!token) {
    throw new Error("SQUARE_ACCESS_TOKEN is not configured");
  }

  const res = await fetch(`${squareBase(env)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Square-Version": SQUARE_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const msg =
      data?.errors?.[0]?.detail ||
      data?.errors?.[0]?.code ||
      `Square API ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.details = data?.errors || data;
    throw err;
  }

  return data;
}

function formatMoney(amountCents, currency = "USD") {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format((amountCents || 0) / 100);
  } catch {
    return `$${((amountCents || 0) / 100).toFixed(2)}`;
  }
}

function shippingCents(env) {
  const n = Number(env.SHIPPING_CENTS);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : SHIPPING_CENTS;
}

function publicLeadTimes(env) {
  const rules = leadTimeRulesFromEnv(env);
  return {
    defaultWeeks: rules.defaultWeeks,
    rules: rules.rules,
    policy: leadTimePolicySentence(rules),
  };
}

/**
 * Keep or drop <!--@name-->…<!--/@name--> blocks in served HTML.
 * @checkout / @nocheckout follow CHECKOUT_ENABLED; @sandbox is kept only when
 * checkout is on against the Square sandbox.
 */
export function htmlBlocks(html, env) {
  const on = checkoutEnabled(env);
  const sandbox = (env?.SQUARE_ENVIRONMENT || "sandbox") !== "production";
  const keep = { checkout: on, nocheckout: !on, sandbox: on && sandbox };
  const re = /<!--@(checkout|nocheckout|sandbox)-->([\s\S]*?)<!--\/@\1-->/g;
  // Blocks can nest (the sandbox card hint sits inside the checkout modal).
  for (let prev = null; prev !== html; ) {
    prev = html;
    html = html.replace(re, (_, name, inner) => (keep[name] ? inner : ""));
  }
  return html;
}

function htmlTokens(html, env, request) {
  const origin = String(env.SITE_ORIGIN || new URL(request.url).origin).replace(/\/$/, "");
  const phrase = flatRateShippingPhrase(shippingCents(env));
  const effective = String(env.POLICY_EFFECTIVE_DATE || "October 10, 2026").trim();
  const email = notifyEmail(env);
  return htmlBlocks(html, env)
    .replaceAll("__SITE_ORIGIN__", origin)
    .replaceAll("__SHIPPING_PHRASE__", phrase)
    .replaceAll("__LEAD_TIME_POLICY__", publicLeadTimes(env).policy)
    .replaceAll("__POLICY_EFFECTIVE__", effective)
    .replaceAll("__CONTACT_EMAIL__", email);
}

/** List active catalog discounts for display (manage in Square). Cached per request. */
async function listCatalogDiscounts(env, cache) {
  if (cache) {
    if (!cache.discounts) cache.discounts = fetchCatalogDiscounts(env);
    return cache.discounts;
  }
  return fetchCatalogDiscounts(env);
}

async function fetchCatalogDiscounts(env) {
  try {
    const data = await squareFetch(
      env,
      "/v2/catalog/list?types=DISCOUNT,PRICING_RULE,PRODUCT_SET"
    );
    const objects = data.objects || [];
    const discounts = new Map();
    const rules = [];
    const productSets = new Map();
    for (const o of objects) {
      if (o.type === "DISCOUNT" && !o.is_deleted) {
        discounts.set(o.id, o);
      } else if (o.type === "PRICING_RULE" && !o.is_deleted) {
        rules.push(o);
      } else if (o.type === "PRODUCT_SET" && !o.is_deleted) {
        productSets.set(o.id, o);
      }
    }
    const promos = [];
    for (const rule of rules) {
      const rd = rule.pricing_rule_data || {};
      if (rd.application_mode && rd.application_mode !== "AUTOMATIC") continue;
      const disc = discounts.get(rd.discount_id);
      if (!disc) continue;
      const dd = disc.discount_data || {};
      const pset = productSets.get(rd.match_products_id);
      const qmin = pset?.product_set_data?.quantity_min;
      promos.push({
        id: disc.id,
        ruleId: rule.id,
        name: dd.name || rd.name || "Discount",
        percent: dd.percentage ? Number(dd.percentage) : null,
        amountMoney: dd.amount_money || null,
        discountType: dd.discount_type || null,
        minItems: qmin != null ? Number(qmin) : null,
        ruleName: rd.name || null,
      });
    }
    promos.sort((a, b) => (a.minItems || 0) - (b.minItems || 0));
    const summary = promos.length
      ? promos
          .map((p) =>
            p.minItems && p.percent != null
              ? `${p.minItems}+ items: ${p.percent}% off`
              : p.name
          )
          .join(" · ")
      : "None (manage in Square Dashboard)";
    return { source: "square_catalog", promos, summary };
  } catch (e) {
    console.warn("listCatalogDiscounts failed", e.message);
    return { source: "square_catalog", promos: [], summary: "Unavailable" };
  }
}

function notifyEmail(env) {
  return (env.MERCHANT_NOTIFY_EMAIL || MERCHANT_NOTIFY_EMAIL).trim();
}

/** Paginate catalog list for ITEM + IMAGE objects. */
async function listCatalog(env) {
  const objects = [];
  let cursor;
  do {
    const qs = new URLSearchParams({ types: "ITEM,IMAGE,CATEGORY" });
    if (cursor) qs.set("cursor", cursor);
    const data = await squareFetch(env, `/v2/catalog/list?${qs}`);
    objects.push(...(data.objects || []));
    cursor = data.cursor;
  } while (cursor);
  return objects;
}

async function batchInventoryCounts(env, variationIds) {
  if (!variationIds.length) return new Map();
  const data = await squareFetch(env, "/v2/inventory/counts/batch-retrieve", {
    method: "POST",
    body: {
      catalog_object_ids: variationIds,
      location_ids: [env.SQUARE_LOCATION_ID],
      states: ["IN_STOCK"],
    },
  });

  const map = new Map();
  for (const c of data.counts || []) {
    if (c.state !== "IN_STOCK") continue;
    const id = c.catalog_object_id;
    // Square can go negative if past orders oversold catalog lines — treat as 0 available
    const qty = Math.max(0, Number(c.quantity || 0));
    map.set(id, (map.get(id) || 0) + qty);
  }
  return map;
}

/**
 * Catalog line items for full qty so Square pricing rules/discounts apply
 * (same catalog as POS). MTO units are restored to inventory after payment.
 */
function buildSquareLineItems(lines) {
  const items = [];
  for (const l of lines) {
    if (l.quantity <= 0) continue;
    const noteParts = [];
    if (l.inStockQty) noteParts.push(`${l.inStockQty} in stock`);
    if (l.mtoQty) noteParts.push(`${l.mtoQty} made-to-order`);
    items.push({
      quantity: String(l.quantity),
      catalog_object_id: l.variationId,
      ...(noteParts.length ? { note: noteParts.join(" · ") } : {}),
    });
  }
  return items;
}

/** After payment, put MTO units back on the shelf (Square decremented full qty). */
async function restoreMtoInventory(env, lines, orderId) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
  const changes = [];
  for (const l of lines) {
    const mto = Math.max(0, Number(l.mtoQty) || 0);
    if (!mto || !l.trackInventory) continue;
    // Move MTO portion from SOLD back to IN_STOCK
    changes.push({
      type: "ADJUSTMENT",
      adjustment: {
        catalog_object_id: l.variationId,
        from_state: "SOLD",
        to_state: "IN_STOCK",
        quantity: String(mto),
        location_id: env.SQUARE_LOCATION_ID,
        occurred_at: now,
      },
    });
  }
  if (!changes.length) return;
  try {
    await squareFetch(env, "/v2/inventory/changes/batch-create", {
      method: "POST",
      body: {
        idempotency_key: await idempotencyKey(orderId, "restore-mto"),
        changes,
      },
    });
  } catch (e) {
    console.error("restoreMtoInventory failed", e.message, e.details);
  }
}

/** Build order payload shared by CalculateOrder and CreateOrder. */
function buildOrderPayload(env, { lines, currency, shipping, shippingInfo, allocation, taxCfg }) {
  const lineItems = buildSquareLineItems(lines);
  const order = {
    location_id: env.SQUARE_LOCATION_ID,
    line_items: lineItems,
    service_charges: [
      {
        name: flatRateShippingPhrase(shipping),
        amount_money: { amount: shipping, currency },
        calculation_phase: "SUBTOTAL_PHASE",
        taxable: false,
      },
    ],
  };
  const appliedTax = applyOrderTax(env, order);
  Object.assign(taxCfg, appliedTax);

  if (shippingInfo) {
    order.reference_id = `web-${Date.now()}`;
    order.fulfillments = [
      {
        type: "SHIPMENT",
        state: "PROPOSED",
        shipment_details: {
          recipient: {
            display_name: shippingInfo.displayName,
            email_address: shippingInfo.email,
            ...(shippingInfo.phone
              ? { phone_number: shippingInfo.phone }
              : {}),
            address: shippingInfo.address,
          },
          shipping_note:
            allocation?.totalMto > 0
              ? `MADE TO ORDER: ${allocation.totalMto} unit(s). Ship ALL items together within 1 week.`
              : "Ship all items together.",
        },
      },
    ];
    order.metadata = {
      source: "packmulehouse-website",
      channel: "custom_web",
      mto_units: String(allocation?.totalMto || 0),
      in_stock_units: String(
        (lines || []).reduce((n, l) => n + (l.inStockQty || 0), 0)
      ),
      ship_together: "true",
      tax_mode: taxCfg.mode,
      tax_percent: taxCfg.chargesTax ? String(taxCfg.percent) : "0",
    };
  }

  return order;
}

function summarizeSquareOrder(order, fallback = {}) {
  const discounts = order.discounts || [];
  const discountNames = discounts
    .map((d) => d.name || "Discount")
    .filter(Boolean);
  return {
    subtotal:
      order.net_amounts?.total_money != null
        ? // net total is after tax in some fields — use line item sum for merch
          fallback.subtotal
        : fallback.subtotal,
    discount: order.total_discount_money?.amount || 0,
    discountLabel: discountNames.length
      ? discountNames.join(", ")
      : fallback.discountLabel || null,
    tax: order.total_tax_money?.amount || 0,
    shipping: fallback.shipping || 0,
    amount: order.total_money?.amount || 0,
    currency: order.total_money?.currency || "USD",
    appliedDiscounts: discounts.map((d) => ({
      name: d.name,
      percentage: d.percentage,
      amount: d.applied_money?.amount || 0,
      catalogObjectId: d.catalog_object_id || null,
    })),
  };
}

function mapCatalogToProducts(objects, inventoryMap, env, mto) {
  const images = new Map();
  const categoryNames = new Map();
  for (const o of objects) {
    if (o.type === "IMAGE" && o.image_data?.url) {
      images.set(o.id, o.image_data.url);
    } else if (o.type === "CATEGORY" && o.category_data?.name) {
      categoryNames.set(o.id, o.category_data.name);
    }
  }
  const leadRules = leadTimeRulesFromEnv(env);

  const locationId = env.SQUARE_LOCATION_ID;
  const filter = catalogFilterFromEnv(env);
  const threshold = lowStockThreshold(env);
  const products = [];
  for (const o of objects) {
    if (o.type !== "ITEM" || o.is_deleted) continue;
    const item = o.item_data;
    if (!item || item.is_archived) continue;
    if (!presentAtLocation(o, locationId)) continue;

    const catIds = itemCategoryIds(item);
    const catNames = catIds.map((id) => categoryNames.get(id)).filter(Boolean);
    if (!itemAllowed(o, filter, categoryNames)) continue;
    const weeks = leadTimeWeeks(
      { name: item.name, categoryIds: catIds, categoryNames: catNames },
      leadRules
    );
    const mtoLabel = leadTimeLabel(weeks);
    const variations = [];
    for (const v of item.variations || []) {
      if (v.is_deleted) continue;
      const vd = v.item_variation_data || {};
      if (vd.sellable === false) continue;
      if (!presentAtLocation(v, locationId)) continue;
      const money = vd.price_money;
      if (!money || money.amount == null) continue;

      const tracks = variationTracksInventory(vd, locationId);
      const shelf = tracks
        ? inventoryMap.has(v.id)
          ? inventoryMap.get(v.id)
          : 0
        : null;

      variations.push({
        ...decorateVariation(
          {
            id: v.id,
            name: vd.name || "Standard",
            amount: money.amount,
            currency: money.currency || "USD",
            priceLabel: formatMoney(money.amount, money.currency || "USD"),
            trackInventory: tracks,
            stock: shelf,
          },
          mto,
          threshold
        ),
        leadTimeWeeks: weeks,
        leadTimeLabel: mtoLabel,
      });
    }
    if (!variations.length) continue;

    const primary = [...variations].sort((a, b) => a.amount - b.amount)[0];
    const imageId = item.image_ids?.[0];

    products.push({
      id: o.id,
      name: item.name,
      description: item.description || "",
      imageUrl: imageId ? images.get(imageId) || null : null,
      variations,
      priceLabel: primary.priceLabel,
      amount: primary.amount,
      currency: primary.currency,
      defaultVariationId: primary.id,
      trackInventory: primary.trackInventory,
      lowStock: primary.lowStock,
      stockDisplay: primary.stockDisplay,
      stockTone: primary.stockTone,
      availability: primary.availability,
      maxQty: primary.maxQty,
      mtoOpen: !!mto?.open,
      leadTimeWeeks: weeks,
      leadTimeLabel: mtoLabel,
      categoryIds: catIds,
      categoryNames: catNames,
    });
  }

  products.sort((a, b) => a.name.localeCompare(b.name));
  return products;
}

export const CHECKOUT_OFF_MESSAGE =
  "Online ordering opens soon. Message us at packmulehouse@gmail.com to order.";

/** Online checkout is on only when CHECKOUT_ENABLED is "true". */
export function checkoutEnabled(env) {
  return String(env?.CHECKOUT_ENABLED ?? "false").trim().toLowerCase() === "true";
}

async function handleConfig(env) {
  const ship = shippingCents(env);
  const mto = await getMtoState(env);
  const tax = taxConfigPublic(env);
  const cache = createLookupCache();
  const discounts = await listCatalogDiscounts(env, cache);
  return json({
    applicationId: env.SQUARE_APPLICATION_ID,
    locationId: env.SQUARE_LOCATION_ID,
    environment: env.SQUARE_ENVIRONMENT || "sandbox",
    shippingCents: ship,
    shippingLabel: formatMoney(ship, "USD"),
    shippingPhrase: flatRateShippingPhrase(ship),
    leadTimes: publicLeadTimes(env),
    tax,
    discounts,
    lowStockThreshold: lowStockThreshold(env),
    mto: publicMto(mto),
    checkoutEnabled: checkoutEnabled(env),
    checkoutOffMessage: CHECKOUT_OFF_MESSAGE,
  });
}

async function handleCatalog(env) {
  try {
  const cache = createLookupCache();
  const objects = await listCatalog(env);
  const variationIds = collectTrackedVariationIds(objects, env.SQUARE_LOCATION_ID);

  let inventoryMap = new Map();
  try {
    inventoryMap = await batchInventoryCounts(env, variationIds);
  } catch (e) {
    console.warn("inventory lookup failed", e.message);
  }

  const mto = await getMtoState(env);
  const mapped = mapCatalogToProducts(objects, inventoryMap, env, mto);
  // No stock counts on the storefront until checkout is on.
  const products = checkoutEnabled(env) ? mapped : withoutStockSignals(mapped);
  const filter = catalogFilterFromEnv(env);
  const sections = productSections(products, filter.groups);

  return json(
    {
      products,
      sections,
      count: products.length,
      shippingCents: shippingCents(env),
      shippingLabel: formatMoney(shippingCents(env), "USD"),
      shippingPhrase: flatRateShippingPhrase(shippingCents(env)),
      leadTimes: publicLeadTimes(env),
      tax: taxConfigPublic(env),
      discounts: await listCatalogDiscounts(env, cache),
      lowStockThreshold: lowStockThreshold(env),
      mto: publicMto(mto),
    },
    200,
    { "Cache-Control": "public, max-age=10" }
  );
  } catch (e) {
    return clientSafeError(e, "Could not load the catalog. Please try again.");
  }
}

async function getCatalogObject(env, id, cache) {
  if (cache?.objects.has(id)) return cache.objects.get(id);
  const pending = squareFetch(env, `/v2/catalog/object/${encodeURIComponent(id)}`);
  if (cache) cache.objects.set(id, pending);
  return pending;
}

async function categoryNamesForItem(env, itemData, cache) {
  const names = new Map();
  for (const id of itemCategoryIds(itemData)) {
    try {
      const data = await getCatalogObject(env, id, cache);
      const name = data?.object?.category_data?.name;
      if (name) names.set(id, name);
    } catch (e) {
      console.warn("category lookup failed", e?.message || e);
    }
  }
  return names;
}

async function resolveVariationLine(env, variationId, quantity, cache) {
  const parsedQty = parseQuantity(quantity);
  if (parsedQty.error) throw publicFail(parsedQty.error, 400);
  const qty = parsedQty.quantity;

  const catalog = await getCatalogObject(env, variationId, cache);
  const obj = catalog.object;
  if (!obj || obj.type !== "ITEM_VARIATION" || obj.is_deleted) {
    throw publicFail("This product is not available", 400);
  }

  const vd = obj.item_variation_data || {};
  if (vd.sellable === false) {
    throw publicFail("This product is not available", 400);
  }
  const locationId = env.SQUARE_LOCATION_ID;
  if (!presentAtLocation(obj, locationId)) {
    throw publicFail("This product is not available at this location", 400);
  }

  const money = vd.price_money;
  if (!money?.amount) {
    throw publicFail("This product has no fixed price in Square", 400);
  }

  if (!vd.item_id) throw publicFail("This product is not available", 400);
  const parent = await getCatalogObject(env, vd.item_id, cache);
  const item = parent.object;
  if (!item || item.type !== "ITEM" || item.is_deleted || item.item_data?.is_archived) {
    throw publicFail("This product is not available", 400);
  }
  if (!presentAtLocation(item, locationId)) {
    throw publicFail("This product is not available at this location", 400);
  }
  const filter = catalogFilterFromEnv(env);
  const categoryNames = filter.shop.length
    ? await categoryNamesForItem(env, item.item_data, cache)
    : new Map();
  if (!itemAllowed(item, filter, categoryNames)) {
    throw publicFail("This product is not available", 400);
  }

  let itemName = item.item_data?.name || vd.name || "Item";
  if (vd.name && vd.name !== "Regular" && vd.name !== "Standard Kit") {
    itemName = `${itemName} (${vd.name})`;
  }

  return {
    variationId,
    quantity: qty,
    unitAmount: money.amount,
    currency: money.currency || "USD",
    lineTotal: money.amount * qty,
    itemName,
    trackInventory: variationTracksInventory(vd, locationId),
  };
}

/**
 * Allocate each line into in-stock vs MTO. Lines that share a variation
 * are merged first so shelf stock is only counted once.
 */
async function allocateOrderLines(env, lines) {
  const mto = await getMtoState(env);
  const trackedIds = [...new Set(lines.filter((l) => l.trackInventory).map((l) => l.variationId))];
  let counts = new Map();
  if (trackedIds.length) {
    counts = await batchInventoryCounts(env, trackedIds);
  }
  const stockByVariation = {};
  for (const line of lines) {
    if (!line.trackInventory) stockByVariation[line.variationId] = null;
    else stockByVariation[line.variationId] = counts.has(line.variationId) ? counts.get(line.variationId) : 0;
  }
  const result = allocateMerged(lines, stockByVariation, mto);
  if (result.error) throw publicFail(result.error, result.status || 409);
  return { lines: result.lines, totalMto: result.totalMto, mto };
}

/**
 * Multi-channel merchant alerts:
 * 1) ntfy.sh phone push (default — free, reliable)
 * 2) Discord webhook (optional DISCORD_WEBHOOK_URL secret)
 * 3) Resend email (optional RESEND_API_KEY secret)
 * 4) FormSubmit → Gmail (best-effort; flaky from servers)
 */
async function notifyMerchant(env, payload) {
  const subject = payload.subject;
  const text = payload.text;
  const results = [];
  const errors = [];

  console.log("ORDER_NOTIFY", { subject: headerSafe(subject, 80) });

  // --- 1) ntfy push (phone / desktop). Topic is a secret; no fallback. ---
  const ntfyTopic = String(env.NTFY_TOPIC || "").trim();
  const ntfyBase = (env.NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, "");
  if (!ntfyTopic) {
    console.warn("ntfy skipped: NTFY_TOPIC secret is not set");
  } else {
    try {
      const headers = {
        Title: headerSafe(subject, 120),
        Priority: "high",
        Tags: "package,shopping_cart",
        "Content-Type": "text/plain; charset=utf-8",
      };
      if (env.NTFY_TOKEN) {
        headers.Authorization = `Bearer ${env.NTFY_TOKEN}`;
      }
      const res = await fetch(`${ntfyBase}/${encodeURIComponent(ntfyTopic)}`, {
        method: "POST",
        headers,
        body: plainSafe(text),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`ntfy ${res.status}: ${body.slice(0, 200)}`);
      }
      results.push({ channel: "ntfy", ok: true });
    } catch (e) {
      console.error("ntfy failed", e);
      errors.push(`ntfy: ${e.message}`);
    }
  }

  // --- 2) Discord webhook (rich embed with order fields) ---
  if (env.DISCORD_WEBHOOK_URL) {
    try {
      const embed = payload.discordEmbed || {
        title: subject.slice(0, 250),
        description: text.slice(0, 4000),
        color: 0xc4a574,
      };
      const res = await fetch(env.DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: payload.discordContent || "**🛒 New Pack Mule House order**",
          embeds: [embed],
          allowed_mentions: { parse: [] },
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Discord ${res.status}: ${body.slice(0, 120)}`);
      }
      results.push({ channel: "discord", ok: true });
    } catch (e) {
      console.error("Discord failed", e);
      errors.push(`discord: ${e.message}`);
    }
  }

  // --- 2b) Telegram bot ---
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: telegramSafe(`${subject}\n\n${text}`).slice(0, 4000),
            disable_web_page_preview: true,
          }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(data?.description || `Telegram ${res.status}`);
      }
      results.push({ channel: "telegram", ok: true });
    } catch (e) {
      console.error("Telegram failed", e);
      errors.push(`telegram: ${e.message}`);
    }
  }

  // --- 3) Resend email (reliable if configured) ---
  if (env.RESEND_API_KEY) {
    try {
      const to = notifyEmail(env);
      const from = String(env.EMAIL_FROM || "").trim();
      if (!from) {
        throw new Error("EMAIL_FROM is not configured");
      }
      const html =
        payload.html ||
        `<pre style="font-family:sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>`;
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [to],
          subject: headerSafe(subject, 180),
          text,
          html,
          ...(payload.replyTo ? { reply_to: payload.replyTo } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.message || `Resend ${res.status}`);
      }
      results.push({ channel: "resend", ok: true, id: data.id });
    } catch (e) {
      console.error("Resend failed", e);
      errors.push(`resend: ${e.message}`);
    }
  }

  // --- 4) FormSubmit → Gmail (optional / best-effort) ---
  if (env.ENABLE_FORMSUBMIT === "true" || env.ENABLE_FORMSUBMIT === "1") {
    try {
      const to = notifyEmail(env);
      const siteOrigin = String(env.SITE_ORIGIN || "").trim().replace(/\/$/, "");
      if (!siteOrigin) {
        throw new Error("SITE_ORIGIN is not configured");
      }
      const res = await fetch(
        `https://formsubmit.co/ajax/${encodeURIComponent(to)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Origin: siteOrigin,
            Referer: `${siteOrigin}/`,
          },
          body: JSON.stringify({
            name: "Pack Mule House Website",
            email: payload.replyTo || "orders@packmulehouse.com",
            _subject: headerSafe(subject, 180),
            _template: "table",
            _captcha: "false",
            message: plainSafe(text),
          }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === "false" || data.success === false) {
        throw new Error(data?.message || `FormSubmit ${res.status}`);
      }
      results.push({ channel: "formsubmit", ok: true });
    } catch (e) {
      console.error("FormSubmit failed", e);
      errors.push(`formsubmit: ${e.message}`);
    }
  }

  if (!results.length) {
    throw new Error(
      errors.join("; ") || "No notification channels succeeded"
    );
  }

  return { results, errors };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildOrderEmail({
  lines,
  shipping,
  subtotal,
  discount,
  discountLabel,
  tax,
  taxLabel,
  taxIncluded,
  taxNote,
  total,
  currency,
  shippingInfo,
  orderId,
  paymentId,
  environment,
  totalMto,
  mtoRemainingAfter,
  mtoPromiseText,
}) {
  const cur = currency || "USD";
  const hasMto = (totalMto || 0) > 0;
  const hasDiscount = (discount || 0) > 0;
  const itemLines = lines
    .map((l) => {
      const parts = [];
      if (l.inStockQty) parts.push(`${l.inStockQty} in stock`);
      if (l.mtoQty) parts.push(`${l.mtoQty} MTO`);
      const tag = parts.length ? ` [${parts.join(" + ")}]` : "";
      return `• ${l.itemName} × ${l.quantity}${tag} — ${formatMoney(l.lineTotal, cur)}`;
    })
    .join("\n");

  const addr = shippingInfo.address;
  const addressLines = [
    shippingInfo.displayName,
    addr.address_line_1,
    addr.address_line_2,
    `${addr.locality}, ${addr.administrative_district_level_1} ${addr.postal_code}`,
    addr.country,
  ].filter(Boolean);

  const contactLines = [shippingInfo.email, shippingInfo.phone].filter(Boolean);

  const text = [
    `New Pack Mule House web order (${environment || "sandbox"})`,
    hasMto ? `⚠ Includes made-to-order units — ${mtoPromiseText || "ships within 1 week"}` : "",
    "",
    `Order ID: ${orderId || "—"}`,
    `Payment ID: ${paymentId || "—"}`,
    "",
    "Items:",
    itemLines,
    "",
    `Subtotal: ${formatMoney(subtotal ?? 0, cur)}`,
    hasDiscount
      ? `Discount (${discountLabel || "Volume"}): -${formatMoney(discount, cur)}`
      : "",
    `${flatRateShippingPhrase(shipping)} (US orders)`,
    taxIncluded ? "" : `Tax (${taxLabel || "Sales Tax"}): ${formatMoney(tax || 0, cur)}`,
    `Total charged: ${formatMoney(total, cur)}`,
    taxIncluded ? taxNote || "Prices include tax" : "",
    hasMto ? `MTO units this order: ${totalMto} · remaining after: ${mtoRemainingAfter}` : "",
    "",
    "Ship to:",
    ...addressLines,
    ...contactLines,
    "",
    "Ship ALL items together. Fulfill in Square Dashboard → Orders.",
  ]
    .filter((line) => line !== "")
    .join("\n");

  const safeName = discordSafe(shippingInfo.displayName);
  const itemsField = lines
    .map((l) => {
      const parts = [];
      if (l.inStockQty) parts.push(`${l.inStockQty} stock`);
      if (l.mtoQty) parts.push(`${l.mtoQty} MTO`);
      const tag = parts.length ? ` · ${parts.join(" + ")}` : "";
      return `**${discordSafe(l.itemName)}** × ${l.quantity}${tag}\n${formatMoney(l.unitAmount, cur)} each → **${formatMoney(l.lineTotal, cur)}**`;
    })
    .join("\n\n")
    .slice(0, 1024);

  const shipToField = [
    safeName,
    ...addressLines.slice(1).map((line) => discordSafe(line)),
    ...contactLines.map((line) => discordSafe(line)),
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 1024);

  const envLabel = environment === "production" ? "LIVE" : "SANDBOX";
  const totalLabel = formatMoney(total, cur);

  const fields = [
    { name: "Items", value: itemsField || "—", inline: false },
    {
      name: "Subtotal",
      value: formatMoney(subtotal ?? 0, cur),
      inline: true,
    },
  ];
  if (hasDiscount) {
    fields.push({
      name: discountLabel || "Discount",
      value: `−${formatMoney(discount, cur)}`,
      inline: true,
    });
  }
  fields.push({
    name: flatRateShippingPhrase(shipping),
    value: "US orders",
    inline: true,
  });
  if (!taxIncluded) {
    fields.push({
      name: taxLabel || "Sales Tax",
      value: formatMoney(tax || 0, cur),
      inline: true,
    });
  }
  fields.push({
    name: "Total paid",
    value: taxIncluded
      ? `**${totalLabel}**\n${taxNote || "Prices include tax"}`
      : `**${totalLabel}**`,
    inline: true,
  });

  if (hasMto) {
    fields.push({
      name: "Made to order",
      value: `**${totalMto} unit(s)**\n${mtoPromiseText || "Ships within 1 week"}\nMTO left after: **${mtoRemainingAfter}**`,
      inline: false,
    });
  }

  fields.push(
    { name: "Ship to", value: shipToField || "—", inline: false },
    {
      name: "Customer email",
      value: discordSafe(shippingInfo.email) || "—",
      inline: true,
    },
    { name: "Phone", value: discordSafe(shippingInfo.phone) || "—", inline: true },
    { name: "Order ID", value: `\`${orderId || "—"}\``, inline: false },
    { name: "Payment ID", value: `\`${paymentId || "—"}\``, inline: false }
  );

  const discordEmbed = {
    title: hasMto
      ? `New order (MTO) — ${totalLabel}`
      : `New order — ${totalLabel}`,
    description: `Pack Mule House website · **${envLabel}**${
      hasMto ? " · 🛠 made-to-order" : ""
    }`,
    color: hasMto
      ? 0xd4a017
      : environment === "production"
        ? 0x5c8a8a
        : 0xc4a574,
    fields,
    footer: {
      text: "Ship all together · Square Dashboard → Orders",
    },
    timestamp: new Date().toISOString(),
  };

  return {
    subject: headerSafe(
      `[PMH]${hasMto ? " MTO" : ""} New order ${totalLabel} — ${shippingInfo.displayName}`,
      180
    ),
    text: plainSafe(text),
    replyTo: shippingInfo.email,
    discordEmbed,
    discordContent: hasMto
      ? `**🛠 MTO order ${totalLabel}** from **${safeName}** — ship all within 1 week`
      : `**🛒 New order ${totalLabel}** from **${safeName}**`,
  };
}

async function resolveCartLines(env, rawItems, cache = createLookupCache()) {
  const agg = aggregateCartLines(rawItems, { maxLines: MAX_CART_LINES });
  if (agg.error) throw publicFail(agg.error, 400);
  const resolved = [];
  for (const item of agg.items) {
    resolved.push(
      await resolveVariationLine(env, item.variationId, item.quantity, cache)
    );
  }
  const currency = resolved[0]?.currency || "USD";
  for (const line of resolved) {
    if (line.currency !== currency) {
      throw publicFail("All cart items must share the same currency", 400);
    }
  }
  const allocation = await allocateOrderLines(env, resolved);
  return { lines: allocation.lines, currency, allocation };
}

/** Preview totals using Square CalculateOrder (same discounts as POS). */
async function handleQuote(request, env) {
  if (request.method !== "POST") {
    return error("Method not allowed", 405);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return error("Invalid JSON body");
  }
  let rawItems = Array.isArray(body.items) ? body.items : null;
  if (!rawItems?.length) return error("Cart is empty");

  try {
    const { lines, currency, allocation } = await resolveCartLines(
      env,
      rawItems
    );
    const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
    const shipping = shippingCents(env);
    const taxCfg = taxConfigPublic(env);
    const order = buildOrderPayload(env, {
      lines,
      currency,
      shipping,
      shippingInfo: null,
      allocation,
      taxCfg,
    });
    const calc = await squareFetch(env, "/v2/orders/calculate", {
      method: "POST",
      body: { order },
    });
    const summed = totalsFromSquareOrder(calc.order, { subtotal, shipping, env });
    if (!summed.matchesSquare) {
      console.warn("Square quote total does not match subtotal - discount + shipping + tax", {
        expected: summed.expected,
        amount: summed.amount,
        squareTax: calc.order?.total_tax_money?.amount || 0,
        mode: summed.taxCfg.mode,
      });
    }
    const discount = summed.discount;
    const tax = summed.tax;
    const amount = summed.amount;
    return json({
      ok: true,
      subtotal,
      shipping,
      discount,
      discountLabel: summed.discountLabel,
      tax,
      taxLabel: taxCfg.chargesTax ? `${taxCfg.name} (${taxCfg.label})` : null,
      taxMode: taxCfg.mode,
      taxIncluded: taxCfg.included,
      taxNote: taxCfg.note || null,
      amount,
      currency: summed.currency || currency,
      amountLabel: formatMoney(amount, summed.currency || currency),
      shippingLabel: formatMoney(shipping, currency),
      discountLabelMoney: discount
        ? `−${formatMoney(discount, currency)}`
        : null,
      taxAmountLabel: taxCfg.chargesTax ? formatMoney(tax, currency) : null,
      appliedDiscounts: summed.appliedDiscounts,
      mtoUnits: allocation.totalMto || 0,
      itemCount: lines.reduce((n, l) => n + l.quantity, 0),
    });
  } catch (e) {
    return clientSafeError(e, "Could not calculate the total. Please try again.");
  }
}

async function handlePay(request, env) {
  if (request.method !== "POST") {
    return error("Method not allowed", 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return error("Invalid JSON body");
  }

  const sourceId = body.sourceId || body.source_id;
  const verificationToken = body.verificationToken || body.verification_token;

  let rawItems = Array.isArray(body.items) ? body.items : null;
  if (!rawItems?.length && (body.variationId || body.variation_id)) {
    rawItems = [
      {
        variationId: body.variationId || body.variation_id,
        quantity: body.quantity || 1,
      },
    ];
  }

  if (!sourceId) return error("Missing card token");
  if (!rawItems?.length) return error("Cart is empty");

  const attemptId = parseAttemptId(body.checkoutAttemptId || body.checkout_attempt_id);
  if (!attemptId) return error("Missing checkout attempt");

  const shippingInfo = parseAddress(body);
  if (shippingInfo.error) return error(shippingInfo.error);

  let lines;
  let currency;
  let allocation;
  try {
    const resolved = await resolveCartLines(env, rawItems);
    lines = resolved.lines;
    currency = resolved.currency;
    allocation = resolved.allocation;
  } catch (e) {
    return clientSafeError(e, "Could not prepare this cart. Please try again.");
  }

  const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  const shipping = shippingCents(env);
  const taxCfg = taxConfigPublic(env);
  if (subtotal <= 0) return error("Invalid cart total");

  let gate;
  try {
    gate = await reserveCheckout(env, attemptId, allocation.totalMto || 0);
  } catch (e) {
    return clientSafeError(e, "Could not reserve made-to-order capacity. Please try again.");
  }
  if (gate.replay && gate.result) return json(gate.result);
  if (gate.busy) {
    return error("Checkout is already processing. Wait a moment and try again.", 409);
  }
  const attemptToken = gate.token;
  const mtoAfter = gate.state || allocation.mto;

  async function failCheckout(e, fallback, status) {
    const aborted = await abortCheckout(env, attemptId, attemptToken).catch((err) => {
      console.error("Failed to release checkout reservation", err);
      return { owned: false };
    });
    return { aborted, response: clientSafeError(e, fallback, status) };
  }

  let order;
  try {
    const lineItems = buildSquareLineItems(lines);
    if (!lineItems.length) {
      const failed = await failCheckout(publicFail("No fulfillable line items"), "No fulfillable line items");
      return failed.response;
    }

    const created = await squareFetch(env, "/v2/orders", {
      method: "POST",
      body: {
        idempotency_key: await idempotencyKey(attemptId, "order"),
        order: buildOrderPayload(env, {
          lines,
          currency,
          shipping,
          shippingInfo,
          allocation,
          taxCfg,
        }),
      },
    });
    order = created.order;
  } catch (e) {
    console.error("CreateOrder failed", e.details || e.message);
    return (await failCheckout(e, "Could not complete checkout. Please try again.")).response;
  }

  const orderTotal = order.total_money?.amount;
  if (orderTotal == null) {
    return (await failCheckout(null, "Could not complete checkout. Please try again.")).response;
  }

  const summed = totalsFromSquareOrder(order, { subtotal, shipping, env });
  if (!summed.matchesSquare) {
    console.warn("Square order total does not match subtotal - discount + shipping + tax", {
      expected: summed.expected,
      amount: summed.amount,
      squareTax: order.total_tax_money?.amount || 0,
      mode: taxCfg.mode,
    });
  }
  const discountCollected = summed.discount;
  const taxCollected = summed.tax;
  const appliedDiscountNames = summed.discountLabel ? summed.discountLabel.split(", ") : [];

  let payment;
  try {
    const mtoNote = allocation.totalMto > 0 ? ` · MTO ${allocation.totalMto} unit(s)` : "";
    const paymentBody = {
      source_id: sourceId,
      idempotency_key: await idempotencyKey(attemptId, "payment"),
      amount_money: {
        amount: orderTotal,
        currency: order.total_money.currency || currency,
      },
      order_id: order.id,
      location_id: env.SQUARE_LOCATION_ID,
      autocomplete: true,
      buyer_email_address: shippingInfo.email,
      note: `Pack Mule House web order ${order.id}${mtoNote}`,
    };
    if (verificationToken) paymentBody.verification_token = verificationToken;

    const paid = await squareFetch(env, "/v2/payments", {
      method: "POST",
      body: paymentBody,
    });
    payment = paid.payment;
    await restoreMtoInventory(env, lines, order.id);
  } catch (e) {
    // Log Square's code and detail. The client only gets a mapped sentence.
    console.error("Pay order failed", e.details || e.message);
    const friendly = paymentErrorMessage(e?.details);
    const failed = await failCheckout(
      e,
      friendly || "Payment could not be completed. Please try again.",
      friendly ? 400 : undefined
    );
    if (failed.aborted?.owned && order?.id) {
      try {
        await squareFetch(env, `/v2/orders/${order.id}`, {
          method: "PUT",
          body: {
            order: {
              version: order.version,
              state: "CANCELED",
              location_id: env.SQUARE_LOCATION_ID,
            },
            idempotency_key: await idempotencyKey(order.id, "cancel"),
          },
        });
      } catch (cancelErr) {
        console.warn("Could not cancel unpaid order", cancelErr.message);
      }
    }
    return failed.response;
  }

  const payload = {
    ok: true,
    orderId: order.id,
    paymentId: payment?.id,
    status: payment?.status,
    // Square's receipt_url as returned. Production opens squareup.com receipts.
    // Sandbox returns a squareupsandbox.com/receipt/preview link that Square
    // does not host (their docs: receipts aren't generated in sandbox).
    receiptUrl: payment?.receipt_url || null,
    subtotal,
    shipping,
    discount: discountCollected,
    discountLabel: appliedDiscountNames.length ? appliedDiscountNames.join(", ") : null,
    appliedDiscounts: (order.discounts || []).map((d) => ({
      name: d.name,
      percentage: d.percentage,
      amount: d.applied_money?.amount || 0,
      catalogObjectId: d.catalog_object_id || null,
    })),
    tax: taxCollected,
    taxLabel: taxCfg.chargesTax ? `${taxCfg.name} (${taxCfg.label})` : null,
    taxPercent: taxCfg.chargesTax ? taxCfg.percent : 0,
    taxMode: taxCfg.mode,
    taxIncluded: taxCfg.included,
    taxNote: taxCfg.note || null,
    amount: orderTotal,
    currency: order.total_money.currency || currency,
    amountLabel: formatMoney(orderTotal, order.total_money.currency || currency),
    shippingLabel: formatMoney(shipping, currency),
    taxAmountLabel: taxCfg.chargesTax ? formatMoney(taxCollected, currency) : null,
    items: lines.map((l) => ({
      variationId: l.variationId,
      itemName: l.itemName,
      quantity: l.quantity,
      inStockQty: l.inStockQty || 0,
      mtoQty: l.mtoQty || 0,
      lineTotal: l.lineTotal,
      lineTotalLabel: formatMoney(l.lineTotal, l.currency),
    })),
    itemCount: lines.reduce((n, l) => n + l.quantity, 0),
    mtoUnits: allocation.totalMto || 0,
    mtoPromise: mtoPromise(env),
    shipTogether: true,
    notified: false,
  };

  try {
    const mail = buildOrderEmail({
      lines,
      shipping,
      subtotal,
      discount: discountCollected,
      discountLabel: payload.discountLabel,
      tax: taxCollected,
      taxLabel: taxCfg.chargesTax ? `${taxCfg.name} (${taxCfg.label})` : null,
      taxIncluded: taxCfg.included,
      taxNote: taxCfg.note || null,
      total: orderTotal,
      currency: payload.currency,
      shippingInfo,
      orderId: order.id,
      paymentId: payment?.id,
      environment: env.SQUARE_ENVIRONMENT || "sandbox",
      totalMto: allocation.totalMto,
      mtoRemainingAfter: mtoAfter?.remaining ?? allocation.mto?.remaining,
      mtoPromiseText: mtoPromise(env),
    });
    const notifyResult = await notifyMerchant(env, mail);
    payload.notified = (notifyResult?.results || []).length > 0;
  } catch (e) {
    console.error("Merchant notify failed", e);
  }

  try {
    await completeCheckout(env, attemptId, attemptToken, payload);
  } catch (e) {
    console.error("Failed to store checkout attempt", e);
  }

  return json(payload);
}

async function requireAdmin(request, env) {
  const token = extractBearer(request);
  if (!(await verifyAdminToken(env, token))) {
    return error("Unauthorized", 401);
  }
  return null;
}

async function handleAdminLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return error("Invalid JSON");
  }
  if (!env.ADMIN_PASSWORD) {
    return error("Admin sign-in is not configured", 500);
  }
  if (!env.ADMIN_SESSION_SECRET) {
    return error("Admin sign-in is not configured", 500);
  }
  if (!env.MTO_COUNTER) {
    return error("Admin sign-in is not configured", 500);
  }

  const ip = clientIp(request);
  let status;
  try {
    status = await loginStatus(env, ip);
  } catch (e) {
    console.error("login status failed", e);
    return error("Admin sign-in is unavailable", 503);
  }
  const password = String(body.password ?? "");
  const matches = await passwordsMatch(password, env.ADMIN_PASSWORD);
  if (status.locked) {
    return error("Too many sign-in attempts. Try again later.", 429);
  }
  if (!password || !matches) {
    try {
      const failed = await loginFail(env, ip);
      if (failed.locked) {
        return error("Too many sign-in attempts. Try again later.", 429);
      }
    } catch (e) {
      console.error("login fail counter failed", e);
    }
    return error("Invalid password", 401);
  }
  try {
    await loginClear(env, ip);
    const token = await createAdminToken(env);
    return json({ ok: true, token, expiresInHours: 12 });
  } catch (e) {
    console.error("admin token failed", e);
    return error("Admin sign-in is not configured", 500);
  }
}

async function handleAdminStatus(request, env) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  const state = await getMtoState(env);
  return json(state);
}

async function handleAdminMto(request, env) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  let body;
  try {
    body = await request.json();
  } catch {
    return error("Invalid JSON");
  }
  const action = body.action;
  if (action === "reset") {
    return json(await resetMto(env));
  }
  if (action === "enable") {
    return json(await setMtoState(env, { enabled: true }));
  }
  if (action === "disable") {
    return json(await setMtoState(env, { enabled: false }));
  }
  if (action === "set") {
    return json(
      await setMtoState(env, {
        remaining: body.remaining,
        enabled: body.enabled,
      })
    );
  }
  return error("Unknown action");
}

function isHtmlOrScript(pathname) {
  return (
    pathname === "/" ||
    pathname.endsWith(".html") ||
    pathname.endsWith(".js") ||
    pathname.endsWith(".css")
  );
}

/** Always fetch a full asset body. A 304 would reuse the cached CSP. */
function unconditionalAssetRequest(url, request) {
  const headers = new Headers(request.headers);
  headers.delete("If-None-Match");
  headers.delete("If-Modified-Since");
  headers.delete("If-Range");
  return new Request(url, { method: "GET", headers });
}

async function serveAsset(request, env, rewritePath) {
  if (!env.ASSETS) {
    return error("Not found", 404);
  }

  const base = new URL(request.url);
  const tryPaths = [];
  if (rewritePath) {
    tryPaths.push(rewritePath);
    // Assets may clean-URL redirect foo.html → /foo; also try bare path
    if (rewritePath.endsWith(".html")) {
      tryPaths.push(rewritePath.replace(/\.html$/, ""));
    }
  } else {
    tryPaths.push(base.pathname);
    if (base.pathname === "/" || base.pathname === "") {
      tryPaths.push("/index.html");
    } else if (!base.pathname.includes(".")) {
      tryPaths.push(`${base.pathname.replace(/\/$/, "")}.html`);
    }
  }

  let res = null;
  let usedPath = base.pathname;
  for (const p of tryPaths) {
    const u = new URL(request.url);
    u.pathname = p.startsWith("/") ? p : `/${p}`;
    usedPath = u.pathname;
    const assetRequest = unconditionalAssetRequest(u.toString(), request);
    res = await env.ASSETS.fetch(assetRequest);
    if (res.status === 200) break;
    // Follow a single assets redirect to another path
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("Location");
      if (loc) {
        const next = new URL(loc, u);
        const candidates = [next.pathname];
        if (!next.pathname.endsWith(".html") && !next.pathname.includes(".")) {
          candidates.push(`${next.pathname.replace(/\/$/, "")}.html`);
        }
        for (const c of candidates) {
          const u2 = new URL(request.url);
          u2.pathname = c;
          const r2 = await env.ASSETS.fetch(unconditionalAssetRequest(u2.toString(), request));
          if (r2.status === 200) {
            res = r2;
            usedPath = c;
            break;
          }
        }
        if (res.status === 200) break;
      }
    }
  }

  if (res && isHtmlOrScript(usedPath) && res.status === 200) {
    const headers = new Headers(res.headers);
    const isHtml =
      usedPath.endsWith(".html") || usedPath === "/" || usedPath === "/admin";
    // The document is the CSP. no-store keeps a previous deploy's policy
    // from sticking to a cached page. There is no <meta> CSP to diverge from.
    headers.set("Cache-Control", isHtml ? "no-store" : "no-cache, must-revalidate");
    if (isHtml) headers.set("CDN-Cache-Control", "no-store");
    if (isHtml) {
      headers.set("Content-Type", "text/html; charset=utf-8");
      const html = htmlTokens(await res.text(), env, request);
      return new Response(html, { status: res.status, headers });
    }
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }

  return res || error("Not found", 404);
}

async function handleNotifyTest(env) {
  try {
    const result = await notifyMerchant(env, {
      subject: "[PMH] Test notification",
      text: [
        "This is a test alert from the Pack Mule House website.",
        `Time: ${new Date().toISOString()}`,
        "",
        "If you got this, order notifications are working.",
      ].join("\n"),
      replyTo: notifyEmail(env),
    });
    if (result.errors?.length) console.error("notify test partial", result.errors);
    return json({
      ok: true,
      channels: result.results.map((r) => r.channel),
    });
  } catch (e) {
    console.error("notify test failed", e);
    return error("Notification test failed", 502);
  }
}

// Search engines index the apex domain only, so the sitemap always lists it.
const SITEMAP_ORIGIN = "https://packmulehouse.com";
const SITEMAP_PATHS = ["/", "/quote", "/shipping", "/returns", "/privacy", "/terms", "/contact"];

function sitemapXml() {
  const urls = SITEMAP_PATHS.map((p) => `  <url><loc>${SITEMAP_ORIGIN}${p}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

async function route(request, env, url) {
  const adminHost = isAdminHost(url.hostname);

  if (url.pathname === "/robots.txt") {
    const body = shouldNoindex(env, url.hostname)
      ? "User-agent: *\nDisallow: /\n"
      : "User-agent: *\nAllow: /\n";
    return new Response(`${body}\nSitemap: ${SITEMAP_ORIGIN}/sitemap.xml\n`, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  if (url.pathname === "/sitemap.xml") {
    return new Response(sitemapXml(), {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

  // Original brand file is kept out of public/. Refuse the old URL too.
  if (url.pathname === "/logo.png") return error("Not found", 404);

  if (url.pathname === "/.well-known/apple-developer-merchantid-domain-association") {
    const body = applePayAssociation(env);
    if (!body.trim()) {
      return new Response("Apple Pay domain association is not configured.\n", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/plain", "Cache-Control": "no-cache" },
    });
  }

  if (url.pathname === "/api/admin/login" && request.method === "POST") {
    return handleAdminLogin(request, env);
  }
  if (url.pathname === "/api/admin/status" && request.method === "POST") {
    return handleAdminStatus(request, env);
  }
  if (url.pathname === "/api/admin/mto" && request.method === "POST") {
    return handleAdminMto(request, env);
  }

  if (url.pathname === "/api/config") {
    return handleConfig(env);
  }
  if (url.pathname === "/api/catalog") {
    return handleCatalog(env);
  }
  if (
    (url.pathname === "/api/pay" || url.pathname === "/api/quote") &&
    !checkoutEnabled(env)
  ) {
    return error(CHECKOUT_OFF_MESSAGE, 503);
  }
  if (url.pathname === "/api/pay") {
    return handlePay(request, env);
  }
  if (url.pathname === "/api/quote" && request.method === "POST") {
    return handleQuote(request, env);
  }
  if (url.pathname === "/api/notify-test" && request.method === "POST") {
    const denied = await requireAdmin(request, env);
    if (denied) return denied;
    return handleNotifyTest(env);
  }

  if (adminHost) {
    return serveAsset(request, env, "/pmh-console.html");
  }

  if (
    url.pathname === "/admin" ||
    url.pathname === "/admin/" ||
    url.pathname === "/admin.html" ||
    url.pathname === "/pmh-console.html"
  ) {
    return serveAsset(request, env, "/pmh-console.html");
  }

  return serveAsset(request, env);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let response;
    try {
      response = await route(request, env, url);
    } catch (e) {
      console.error(e);
      response = e?.publicMessage
        ? error(e.publicMessage, e.status || 400)
        : error("Server error", 500);
    }
    const headers = new Headers(response.headers);
    applySecurityHeaders(headers, env, url);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
