/**
 * Pack Mule House — Cloudflare Worker
 * Serves static assets + Square Catalog / Payments API (sandbox or production).
 */

const SQUARE_VERSION = "2025-01-23";

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

function error(message, status = 400, details) {
  return json({ error: message, details }, status);
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

/** Paginate catalog list for ITEM + IMAGE objects. */
async function listCatalog(env) {
  const objects = [];
  let cursor;
  do {
    const qs = new URLSearchParams({ types: "ITEM,IMAGE" });
    if (cursor) qs.set("cursor", cursor);
    const data = await squareFetch(env, `/v2/catalog/list?${qs}`);
    objects.push(...(data.objects || []));
    cursor = data.cursor;
  } while (cursor);
  return objects;
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

function mapCatalogToProducts(objects) {
  const images = new Map();
  for (const o of objects) {
    if (o.type === "IMAGE" && o.image_data?.url) {
      images.set(o.id, o.image_data.url);
    }
  }

  const products = [];
  for (const o of objects) {
    if (o.type !== "ITEM" || o.is_deleted) continue;
    const item = o.item_data;
    if (!item || item.is_archived) continue;

    const variations = [];
    for (const v of item.variations || []) {
      if (v.is_deleted) continue;
      const vd = v.item_variation_data || {};
      if (vd.sellable === false) continue;
      const money = vd.price_money;
      if (!money || money.amount == null) continue;

      variations.push({
        id: v.id,
        name: vd.name || "Standard",
        amount: money.amount,
        currency: money.currency || "USD",
        priceLabel: formatMoney(money.amount, money.currency || "USD"),
      });
    }
    if (!variations.length) continue;

    // Prefer lowest fixed price as the card price (kits usually have one variation)
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
    });
  }

  // Stable sort: name ascending so cards don't jump around
  products.sort((a, b) => a.name.localeCompare(b.name));
  return products;
}

async function handleConfig(env) {
  return json({
    applicationId: env.SQUARE_APPLICATION_ID,
    locationId: env.SQUARE_LOCATION_ID,
    environment: env.SQUARE_ENVIRONMENT || "sandbox",
  });
}

async function handleCatalog(env) {
  const objects = await listCatalog(env);
  const products = mapCatalogToProducts(objects);
  return json(
    { products, count: products.length },
    200,
    // short cache so UI is snappy but prices stay fresh enough in sandbox
    { "Cache-Control": "public, max-age=30" }
  );
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
  const variationId = body.variationId || body.variation_id;
  const quantity = Math.max(1, Math.min(20, Number(body.quantity) || 1));
  const buyerEmail = (body.buyerEmail || body.email || "").trim() || undefined;
  const verificationToken = body.verificationToken || body.verification_token;

  if (!sourceId) return error("Missing sourceId (card token)");
  if (!variationId) return error("Missing variationId");

  // Never trust client price — look up catalog variation
  let catalog;
  try {
    catalog = await squareFetch(
      env,
      `/v2/catalog/object/${encodeURIComponent(variationId)}`
    );
  } catch (e) {
    return error("Product not found in Square catalog", 404, e.details);
  }

  const obj = catalog.object;
  if (!obj || obj.type !== "ITEM_VARIATION") {
    return error("Invalid product variation");
  }

  const vd = obj.item_variation_data || {};
  const money = vd.price_money;
  if (!money?.amount) {
    return error("This product has no fixed price in Square");
  }

  const unitAmount = money.amount;
  const currency = money.currency || "USD";
  const totalAmount = unitAmount * quantity;

  // Parent item name for note (best-effort)
  let itemName = vd.name || "Item";
  if (vd.item_id) {
    try {
      const parent = await squareFetch(
        env,
        `/v2/catalog/object/${encodeURIComponent(vd.item_id)}`
      );
      if (parent.object?.item_data?.name) {
        itemName = parent.object.item_data.name;
        if (vd.name && vd.name !== "Regular" && vd.name !== "Standard Kit") {
          itemName = `${itemName} (${vd.name})`;
        }
      }
    } catch {
      /* ignore */
    }
  }

  const paymentBody = {
    source_id: sourceId,
    idempotency_key: crypto.randomUUID(),
    amount_money: {
      amount: totalAmount,
      currency,
    },
    location_id: env.SQUARE_LOCATION_ID,
    autocomplete: true,
    note: `Pack Mule House web · ${itemName} × ${quantity}`,
  };

  if (buyerEmail) {
    paymentBody.buyer_email_address = buyerEmail;
  }
  if (verificationToken) {
    paymentBody.verification_token = verificationToken;
  }

  try {
    const result = await squareFetch(env, "/v2/payments", {
      method: "POST",
      body: paymentBody,
    });

    const payment = result.payment;
    return json({
      ok: true,
      paymentId: payment?.id,
      status: payment?.status,
      receiptUrl: payment?.receipt_url || null,
      amount: totalAmount,
      currency,
      amountLabel: formatMoney(totalAmount, currency),
      itemName,
      quantity,
    });
  } catch (e) {
    return error(e.message || "Payment failed", e.status || 502, e.details);
  }
}

function isHtmlOrScript(pathname) {
  return (
    pathname === "/" ||
    pathname.endsWith(".html") ||
    pathname.endsWith(".js") ||
    pathname.endsWith(".css")
  );
}

async function serveAsset(request, env) {
  if (!env.ASSETS) {
    return error("Not found", 404);
  }

  const res = await env.ASSETS.fetch(request);
  const url = new URL(request.url);

  // During sandbox polish, avoid sticky HTML/JS edge caches after deploys
  if (isHtmlOrScript(url.pathname) && res.status === 200) {
    const headers = new Headers(res.headers);
    headers.set("Cache-Control", "no-cache, must-revalidate");
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }

  return res;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/config") {
        return handleConfig(env);
      }
      if (url.pathname === "/api/catalog") {
        return handleCatalog(env);
      }
      if (url.pathname === "/api/pay") {
        return handlePay(request, env);
      }

      return serveAsset(request, env);
    } catch (e) {
      console.error(e);
      return error(e.message || "Server error", 500);
    }
  },
};
