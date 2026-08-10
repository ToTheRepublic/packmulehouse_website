/**
 * Pack Mule House — Cloudflare Worker
 * Catalog, cart checkout, Square Orders + Payments, inventory, MTO, admin.
 */

import {
  allocateUnits,
  consumeMto,
  createAdminToken,
  extractBearer,
  getMtoState,
  isAdminHost,
  lowStockThreshold,
  maxOrderable,
  mtoPromise,
  resetMto,
  setMtoState,
  verifyAdminToken,
} from "./mto.js";

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

function notifyEmail(env) {
  return (env.MERCHANT_NOTIFY_EMAIL || MERCHANT_NOTIFY_EMAIL).trim();
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
    const qty = Number(c.quantity || 0);
    map.set(id, (map.get(id) || 0) + qty);
  }
  return map;
}

function mapCatalogToProducts(objects, inventoryMap) {
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

      const tracks = !!vd.track_inventory;
      const stock = tracks
        ? inventoryMap.has(v.id)
          ? inventoryMap.get(v.id)
          : 0
        : null;

      variations.push({
        id: v.id,
        name: vd.name || "Standard",
        amount: money.amount,
        currency: money.currency || "USD",
        priceLabel: formatMoney(money.amount, money.currency || "USD"),
        trackInventory: tracks,
        stock,
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
      stock: primary.stock,
    });
  }

  products.sort((a, b) => a.name.localeCompare(b.name));
  return products;
}

async function handleConfig(env) {
  const ship = shippingCents(env);
  const mto = await getMtoState(env);
  return json({
    applicationId: env.SQUARE_APPLICATION_ID,
    locationId: env.SQUARE_LOCATION_ID,
    environment: env.SQUARE_ENVIRONMENT || "sandbox",
    shippingCents: ship,
    shippingLabel: formatMoney(ship, "USD"),
    lowStockThreshold: lowStockThreshold(env),
    mto: {
      enabled: mto.enabled,
      remaining: mto.remaining,
      max: mto.max,
      open: mto.open,
      promise: mto.promise,
    },
  });
}

async function handleCatalog(env) {
  const objects = await listCatalog(env);
  const variationIds = [];
  for (const o of objects) {
    if (o.type !== "ITEM") continue;
    for (const v of o.item_data?.variations || []) {
      if (v.item_variation_data?.track_inventory) {
        variationIds.push(v.id);
      }
    }
  }

  let inventoryMap = new Map();
  try {
    inventoryMap = await batchInventoryCounts(env, variationIds);
  } catch (e) {
    console.warn("inventory lookup failed", e.message);
  }

  const mto = await getMtoState(env);
  const threshold = lowStockThreshold(env);
  const products = mapCatalogToProducts(objects, inventoryMap).map((p) => {
    const stock = p.stock;
    const tracked = p.trackInventory;
    let stockDisplay = null; // hide by default
    let stockTone = null; // "fomo" | "mto" | "out"
    let availability = "in_stock";

    if (tracked && stock != null) {
      if (stock <= 0) {
        if (mto.open) {
          stockDisplay = "Made to order";
          stockTone = "mto";
          availability = "mto";
        } else {
          stockDisplay = "Currently unavailable";
          stockTone = "out";
          availability = "unavailable";
        }
      } else if (stock < threshold) {
        stockDisplay = `Only ${stock} left`;
        stockTone = "fomo";
        availability = "low";
      }
    }

    const maxQty = maxOrderable(
      tracked ? stock : null,
      mto
    );

    return {
      ...p,
      stockDisplay,
      stockTone,
      availability,
      maxQty,
      mtoOpen: mto.open,
    };
  });

  return json(
    {
      products,
      count: products.length,
      shippingCents: shippingCents(env),
      shippingLabel: formatMoney(shippingCents(env), "USD"),
      lowStockThreshold: threshold,
      mto: {
        enabled: mto.enabled,
        remaining: mto.remaining,
        max: mto.max,
        open: mto.open,
        promise: mto.promise,
      },
    },
    200,
    { "Cache-Control": "public, max-age=10" }
  );
}

async function resolveVariationLine(env, variationId, quantity) {
  const qty = Math.max(1, Math.min(20, Number(quantity) || 1));
  const catalog = await squareFetch(
    env,
    `/v2/catalog/object/${encodeURIComponent(variationId)}`
  );

  const obj = catalog.object;
  if (!obj || obj.type !== "ITEM_VARIATION") {
    const err = new Error("Invalid product variation");
    err.status = 400;
    throw err;
  }

  const vd = obj.item_variation_data || {};
  const money = vd.price_money;
  if (!money?.amount) {
    const err = new Error("This product has no fixed price in Square");
    err.status = 400;
    throw err;
  }

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

  return {
    variationId,
    quantity: qty,
    unitAmount: money.amount,
    currency: money.currency || "USD",
    lineTotal: money.amount * qty,
    itemName,
    trackInventory: !!vd.track_inventory,
  };
}

function parseAddress(body) {
  const a = body.shippingAddress || body.address || {};
  const firstName = String(a.firstName || a.first_name || body.firstName || "").trim();
  const lastName = String(a.lastName || a.last_name || body.lastName || "").trim();
  const displayName =
    String(a.displayName || a.name || "").trim() ||
    [firstName, lastName].filter(Boolean).join(" ").trim();
  const email = String(
    a.email || body.buyerEmail || body.email || ""
  ).trim();
  const phone = String(a.phone || a.phoneNumber || body.phone || "").trim();
  const addressLine1 = String(a.addressLine1 || a.line1 || a.address1 || "").trim();
  const addressLine2 = String(a.addressLine2 || a.line2 || a.address2 || "").trim();
  const city = String(a.city || a.locality || "").trim();
  const state = String(
    a.state || a.administrativeDistrictLevel1 || a.region || ""
  ).trim();
  const postalCode = String(a.postalCode || a.postal || a.zip || "").trim();
  const country = String(a.country || "US").trim().toUpperCase() || "US";

  const missing = [];
  if (!displayName) missing.push("name");
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) missing.push("email");
  if (!addressLine1) missing.push("address");
  if (!city) missing.push("city");
  if (!state) missing.push("state");
  if (!postalCode) missing.push("postal code");
  if (!country) missing.push("country");

  if (missing.length) {
    return { error: `Missing or invalid shipping fields: ${missing.join(", ")}` };
  }

  return {
    displayName,
    email,
    phone: phone || undefined,
    address: {
      address_line_1: addressLine1,
      ...(addressLine2 ? { address_line_2: addressLine2 } : {}),
      locality: city,
      administrative_district_level_1: state,
      postal_code: postalCode,
      country,
    },
  };
}

/**
 * Allocate each line into in-stock vs MTO. Throws if not fulfillable.
 * Mutates lines with .inStockQty, .mtoQty.
 */
async function allocateOrderLines(env, lines) {
  const mto = await getMtoState(env);
  const trackedIds = lines
    .filter((l) => l.trackInventory)
    .map((l) => l.variationId);
  let counts = new Map();
  if (trackedIds.length) {
    counts = await batchInventoryCounts(env, trackedIds);
  }

  let totalMto = 0;
  const problems = [];

  for (const line of lines) {
    const stock = line.trackInventory
      ? counts.has(line.variationId)
        ? counts.get(line.variationId)
        : 0
      : null;
    const alloc = allocateUnits(stock, line.quantity, mto);
    if (!alloc.ok) {
      problems.push(`${line.itemName}: ${alloc.error}`);
      continue;
    }
    line.inStockQty = alloc.inStock;
    line.mtoQty = alloc.mto;
    line.stockAtOrder = stock;
    totalMto += alloc.mto;
  }

  if (problems.length) {
    const err = new Error(problems.join(" "));
    err.status = 409;
    throw err;
  }

  // Capacity for sum of MTO across cart
  if (totalMto > 0) {
    if (!mto.open) {
      const err = new Error(
        "Made-to-order is on standby. Reduce quantities to what is in stock."
      );
      err.status = 409;
      throw err;
    }
    if (totalMto > mto.remaining) {
      const err = new Error(
        `Not enough made-to-order capacity for this cart (need ${totalMto}, ${mto.remaining} left).`
      );
      err.status = 409;
      throw err;
    }
  }

  return { totalMto, mto };
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

  console.log("ORDER_NOTIFY", { subject, text });

  // --- 1) ntfy push (phone / desktop) ---
  const ntfyTopic =
    env.NTFY_TOPIC || "packmulehouse-orders-pmh7k2x9";
  const ntfyBase = (env.NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, "");
  try {
    const headers = {
      Title: subject.slice(0, 120),
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
      body: text,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`ntfy ${res.status}: ${body.slice(0, 200)}`);
    }
    results.push({ channel: "ntfy", ok: true, topic: ntfyTopic });
  } catch (e) {
    console.error("ntfy failed", e);
    errors.push(`ntfy: ${e.message}`);
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
            text: `${subject}\n\n${text}`.slice(0, 4000),
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
      const from =
        env.EMAIL_FROM || "Pack Mule House <onboarding@resend.dev>";
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
          subject,
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
      const siteOrigin =
        env.SITE_ORIGIN ||
        "https://packmulehouse-website.philip-michael-howard.workers.dev";
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
            _subject: subject,
            _template: "table",
            _captcha: "false",
            message: text,
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
    `Subtotal: ${formatMoney(subtotal ?? total - shipping, cur)}`,
    `Shipping: ${formatMoney(shipping, cur)} (flat rate)`,
    `Total charged: ${formatMoney(total, cur)}`,
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

  const itemsField = lines
    .map((l) => {
      const parts = [];
      if (l.inStockQty) parts.push(`${l.inStockQty} stock`);
      if (l.mtoQty) parts.push(`${l.mtoQty} MTO`);
      const tag = parts.length ? ` · ${parts.join(" + ")}` : "";
      return `**${l.itemName}** × ${l.quantity}${tag}\n${formatMoney(l.unitAmount, cur)} each → **${formatMoney(l.lineTotal, cur)}**`;
    })
    .join("\n\n")
    .slice(0, 1024);

  const shipToField = [...addressLines, ...contactLines]
    .join("\n")
    .slice(0, 1024);

  const envLabel = environment === "production" ? "LIVE" : "SANDBOX";
  const totalLabel = formatMoney(total, cur);

  const fields = [
    { name: "Items", value: itemsField || "—", inline: false },
    {
      name: "Subtotal",
      value: formatMoney(subtotal ?? total - shipping, cur),
      inline: true,
    },
    {
      name: "Shipping",
      value: `${formatMoney(shipping, cur)} flat`,
      inline: true,
    },
    { name: "Total paid", value: `**${totalLabel}**`, inline: true },
  ];

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
      value: shippingInfo.email || "—",
      inline: true,
    },
    { name: "Phone", value: shippingInfo.phone || "—", inline: true },
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
    subject: `[PMH]${hasMto ? " MTO" : ""} New order ${totalLabel} — ${shippingInfo.displayName}`,
    text,
    replyTo: shippingInfo.email,
    discordEmbed,
    discordContent: hasMto
      ? `**🛠 MTO order ${totalLabel}** from **${shippingInfo.displayName}** — ship all within 1 week`
      : `**🛒 New order ${totalLabel}** from **${shippingInfo.displayName}**`,
  };
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

  if (!sourceId) return error("Missing sourceId (card token)");
  if (!rawItems?.length) return error("Cart is empty");
  if (rawItems.length > 25) return error("Too many line items");

  const shippingInfo = parseAddress(body);
  if (shippingInfo.error) return error(shippingInfo.error);

  // Resolve catalog prices (never trust client)
  const lines = [];
  try {
    for (const line of rawItems) {
      const variationId = line.variationId || line.variation_id;
      if (!variationId) return error("Each cart line needs a variationId");
      lines.push(await resolveVariationLine(env, variationId, line.quantity));
    }
  } catch (e) {
    return error(
      e.message || "Product not found in Square catalog",
      e.status || 404,
      e.details
    );
  }

  const currency = lines[0].currency;
  for (const line of lines) {
    if (line.currency !== currency) {
      return error("All cart items must share the same currency");
    }
  }

  let allocation;
  try {
    allocation = await allocateOrderLines(env, lines);
  } catch (e) {
    return error(e.message, e.status || 409, e.details);
  }

  const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  const shipping = shippingCents(env);
  if (subtotal <= 0) return error("Invalid cart total");

  // 1) Create Square Order with catalog line items + shipping + shipment fulfillment
  let order;
  try {
    const orderBody = {
      idempotency_key: crypto.randomUUID(),
      order: {
        location_id: env.SQUARE_LOCATION_ID,
        reference_id: `web-${Date.now()}`,
        customer_id: undefined,
        line_items: lines.map((l) => ({
          quantity: String(l.quantity),
          catalog_object_id: l.variationId,
        })),
        service_charges: [
          {
            name: "Flat rate shipping",
            amount_money: { amount: shipping, currency },
            calculation_phase: "TOTAL_PHASE",
            taxable: false,
          },
        ],
        fulfillments: [
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
                allocation.totalMto > 0
                  ? `MADE TO ORDER: ${allocation.totalMto} unit(s). Ship ALL items together within 1 week.`
                  : "Ship all items together.",
            },
          },
        ],
        metadata: {
          source: "packmulehouse-website",
          channel: "custom_web",
          mto_units: String(allocation.totalMto || 0),
          ship_together: "true",
        },
      },
    };

    // Remove undefined customer_id
    delete orderBody.order.customer_id;

    const created = await squareFetch(env, "/v2/orders", {
      method: "POST",
      body: orderBody,
    });
    order = created.order;
  } catch (e) {
    console.error("CreateOrder failed", e.details || e.message);
    return error(
      e.message || "Could not create Square order",
      e.status || 502,
      e.details
    );
  }

  const orderTotal = order.total_money?.amount;
  if (orderTotal == null) {
    return error("Square order missing total", 502);
  }

  // 2) Pay the order
  let payment;
  try {
    const paymentBody = {
      source_id: sourceId,
      idempotency_key: crypto.randomUUID(),
      amount_money: {
        amount: orderTotal,
        currency: order.total_money.currency || currency,
      },
      order_id: order.id,
      location_id: env.SQUARE_LOCATION_ID,
      autocomplete: true,
      buyer_email_address: shippingInfo.email,
      note: `Pack Mule House web order ${order.id}`,
    };
    if (verificationToken) {
      paymentBody.verification_token = verificationToken;
    }

    const paid = await squareFetch(env, "/v2/payments", {
      method: "POST",
      body: paymentBody,
    });
    payment = paid.payment;
  } catch (e) {
    console.error("Pay order failed", e.details || e.message);
    // Best-effort: cancel open order so it doesn't hang unpaid
    try {
      await squareFetch(env, `/v2/orders/${order.id}`, {
        method: "PUT",
        body: {
          order: {
            version: order.version,
            state: "CANCELED",
            location_id: env.SQUARE_LOCATION_ID,
          },
          idempotency_key: crypto.randomUUID(),
        },
      });
    } catch (cancelErr) {
      console.warn("Could not cancel unpaid order", cancelErr.message);
    }
    return error(e.message || "Payment failed", e.status || 502, e.details);
  }

  // 2b) Consume MTO capacity only after successful payment
  let mtoAfter = allocation.mto;
  try {
    if (allocation.totalMto > 0) {
      mtoAfter = await consumeMto(env, allocation.totalMto);
    }
  } catch (e) {
    // Payment already succeeded — log loudly; do not fail the customer
    console.error("MTO capacity consume failed after payment", e);
  }

  // 3) Merchant notifications (non-fatal if a channel fails)
  let notifyResult = null;
  let notifyError = null;
  try {
    const mail = buildOrderEmail({
      lines,
      shipping,
      subtotal,
      total: orderTotal,
      currency: order.total_money.currency || currency,
      shippingInfo,
      orderId: order.id,
      paymentId: payment?.id,
      environment: env.SQUARE_ENVIRONMENT || "sandbox",
      totalMto: allocation.totalMto,
      mtoRemainingAfter: mtoAfter?.remaining ?? allocation.mto?.remaining,
      mtoPromiseText: mtoPromise(env),
    });
    notifyResult = await notifyMerchant(env, mail);
  } catch (e) {
    notifyError = e.message;
    console.error("Merchant notify failed", e);
  }

  const channelsOk = (notifyResult?.results || []).map((r) => r.channel);

  return json({
    ok: true,
    orderId: order.id,
    paymentId: payment?.id,
    status: payment?.status,
    receiptUrl: payment?.receipt_url || null,
    subtotal,
    shipping,
    amount: orderTotal,
    currency: order.total_money.currency || currency,
    amountLabel: formatMoney(
      orderTotal,
      order.total_money.currency || currency
    ),
    shippingLabel: formatMoney(shipping, currency),
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
    mtoRemaining: mtoAfter?.remaining,
    shipTogether: true,
    notified: channelsOk.length > 0,
    notifyChannels: channelsOk,
    notifyError: notifyError || undefined,
    emailSent: channelsOk.includes("resend") || channelsOk.includes("formsubmit"),
    emailError: notifyError || undefined,
  });
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
    return error("ADMIN_PASSWORD is not configured on the server", 500);
  }
  if (!body.password || body.password !== env.ADMIN_PASSWORD) {
    return error("Invalid password", 401);
  }
  const token = await createAdminToken(env);
  return json({ ok: true, token, expiresInHours: 12 });
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
    const assetRequest = new Request(u.toString(), request);
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
          const r2 = await env.ASSETS.fetch(new Request(u2.toString(), request));
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
    headers.set("Cache-Control", "no-cache, must-revalidate");
    // Ensure HTML content-type even if assets omits it
    if (usedPath.endsWith(".html") || usedPath === "/" || usedPath === "/admin") {
      headers.set("Content-Type", "text/html; charset=utf-8");
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
    return json({
      ok: true,
      channels: result.results.map((r) => r.channel),
      errors: result.errors,
    });
  } catch (e) {
    return error(e.message || "Notify test failed", 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const adminHost = isAdminHost(url.hostname);

    try {
      // --- Admin API ---
      if (url.pathname === "/api/admin/login" && request.method === "POST") {
        return handleAdminLogin(request, env);
      }
      if (url.pathname === "/api/admin/status" && request.method === "POST") {
        return handleAdminStatus(request, env);
      }
      if (url.pathname === "/api/admin/mto" && request.method === "POST") {
        return handleAdminMto(request, env);
      }

      // --- Public API ---
      if (url.pathname === "/api/config") {
        return handleConfig(env);
      }
      if (url.pathname === "/api/catalog") {
        return handleCatalog(env);
      }
      if (url.pathname === "/api/pay") {
        return handlePay(request, env);
      }
      if (url.pathname === "/api/notify-test" && request.method === "POST") {
        return handleNotifyTest(env);
      }

      // Admin host: serve admin app for all non-API paths
      // Asset filename avoids Workers Assets "clean URL" redirects on /admin
      if (adminHost) {
        return serveAsset(request, env, "/pmh-console.html");
      }

      // Path-based admin (works on workers.dev today)
      if (
        url.pathname === "/admin" ||
        url.pathname === "/admin/" ||
        url.pathname === "/admin.html" ||
        url.pathname === "/pmh-console.html"
      ) {
        return serveAsset(request, env, "/pmh-console.html");
      }

      return serveAsset(request, env);
    } catch (e) {
      console.error(e);
      return error(e.message || "Server error", 500);
    }
  },
};
