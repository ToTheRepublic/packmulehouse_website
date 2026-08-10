/**
 * Pack Mule House — Cloudflare Worker
 * Catalog, cart checkout, Square Orders + Payments, inventory, merchant email.
 */

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
  return json({
    applicationId: env.SQUARE_APPLICATION_ID,
    locationId: env.SQUARE_LOCATION_ID,
    environment: env.SQUARE_ENVIRONMENT || "sandbox",
    shippingCents: ship,
    shippingLabel: formatMoney(ship, "USD"),
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

  const products = mapCatalogToProducts(objects, inventoryMap);
  return json(
    {
      products,
      count: products.length,
      shippingCents: shippingCents(env),
      shippingLabel: formatMoney(shippingCents(env), "USD"),
    },
    200,
    { "Cache-Control": "public, max-age=15" }
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

async function assertInventory(env, lines) {
  const tracked = lines.filter((l) => l.trackInventory);
  if (!tracked.length) return;

  const counts = await batchInventoryCounts(
    env,
    tracked.map((l) => l.variationId)
  );

  const problems = [];
  for (const line of tracked) {
    const available = counts.has(line.variationId)
      ? counts.get(line.variationId)
      : 0;
    if (available < line.quantity) {
      problems.push(
        `${line.itemName}: need ${line.quantity}, only ${available} in stock`
      );
    }
  }

  if (problems.length) {
    const err = new Error(`Insufficient inventory — ${problems.join("; ")}`);
    err.status = 409;
    throw err;
  }
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

  // --- 2) Discord webhook ---
  if (env.DISCORD_WEBHOOK_URL) {
    try {
      const res = await fetch(env.DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: null,
          embeds: [
            {
              title: subject.slice(0, 250),
              description: text.slice(0, 4000),
              color: 0xc4a574,
            },
          ],
        }),
      });
      if (!res.ok) {
        throw new Error(`Discord ${res.status}`);
      }
      results.push({ channel: "discord", ok: true });
    } catch (e) {
      console.error("Discord failed", e);
      errors.push(`discord: ${e.message}`);
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

function buildOrderEmail({ lines, shipping, total, currency, shippingInfo, orderId, paymentId, environment }) {
  const itemLines = lines
    .map(
      (l) =>
        `  • ${l.itemName} × ${l.quantity} — ${formatMoney(l.lineTotal, currency)}`
    )
    .join("\n");

  const addr = shippingInfo.address;
  const addressBlock = [
    shippingInfo.displayName,
    addr.address_line_1,
    addr.address_line_2,
    `${addr.locality}, ${addr.administrative_district_level_1} ${addr.postal_code}`,
    addr.country,
    shippingInfo.email,
    shippingInfo.phone,
  ]
    .filter(Boolean)
    .join("\n");

  const text = [
    `New Pack Mule House web order (${environment || "sandbox"})`,
    "",
    `Order ID: ${orderId || "—"}`,
    `Payment ID: ${paymentId || "—"}`,
    "",
    "Items:",
    itemLines,
    "",
    `Shipping: ${formatMoney(shipping, currency)} (flat rate)`,
    `Total charged: ${formatMoney(total, currency)}`,
    "",
    "Ship to:",
    addressBlock,
    "",
    "Fulfill this order in Square Dashboard → Orders.",
  ].join("\n");

  return {
    subject: `[PMH] New order ${formatMoney(total, currency)} — ${shippingInfo.displayName}`,
    text,
    replyTo: shippingInfo.email,
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

  try {
    await assertInventory(env, lines);
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
            },
          },
        ],
        metadata: {
          source: "packmulehouse-website",
          channel: "custom_web",
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

  // 3) Merchant notifications (non-fatal if a channel fails)
  let notifyResult = null;
  let notifyError = null;
  try {
    const mail = buildOrderEmail({
      lines,
      shipping,
      total: orderTotal,
      currency: order.total_money.currency || currency,
      shippingInfo,
      orderId: order.id,
      paymentId: payment?.id,
      environment: env.SQUARE_ENVIRONMENT || "sandbox",
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
      lineTotal: l.lineTotal,
      lineTotalLabel: formatMoney(l.lineTotal, l.currency),
    })),
    itemCount: lines.reduce((n, l) => n + l.quantity, 0),
    notified: channelsOk.length > 0,
    notifyChannels: channelsOk,
    notifyError: notifyError || undefined,
    // back-compat for older frontend
    emailSent: channelsOk.includes("resend") || channelsOk.includes("formsubmit"),
    emailError: notifyError || undefined,
  });
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
