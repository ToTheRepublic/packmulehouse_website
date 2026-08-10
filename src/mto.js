/**
 * Made-to-order capacity + admin session helpers (Cloudflare KV).
 */

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export function mtoMax(env) {
  const n = Number(env.MTO_MAX);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 50;
}

export function mtoPromise(env) {
  return (
    env.MTO_PROMISE ||
    "Ships within 1 week (all items together)"
  );
}

export function lowStockThreshold(env) {
  const n = Number(env.LOW_STOCK_THRESHOLD);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 10;
}

export async function getMtoState(env) {
  const max = mtoMax(env);
  if (!env.MTO_STATE) {
    return {
      enabled: true,
      remaining: max,
      max,
      promise: mtoPromise(env),
      open: true,
    };
  }

  let enabled = await env.MTO_STATE.get("enabled");
  let remaining = await env.MTO_STATE.get("remaining");

  if (enabled == null) {
    enabled = "true";
    await env.MTO_STATE.put("enabled", enabled);
  }
  if (remaining == null) {
    remaining = String(max);
    await env.MTO_STATE.put("remaining", remaining);
  }

  const rem = Math.max(0, Number(remaining) || 0);
  const isEnabled = enabled === "true" || enabled === "1";
  return {
    enabled: isEnabled,
    remaining: rem,
    max,
    promise: mtoPromise(env),
    open: isEnabled && rem > 0,
  };
}

export async function setMtoState(env, { enabled, remaining }) {
  const max = mtoMax(env);
  if (!env.MTO_STATE) {
    throw new Error("MTO_STATE KV binding is not configured");
  }
  if (typeof enabled === "boolean") {
    await env.MTO_STATE.put("enabled", enabled ? "true" : "false");
  }
  if (remaining != null) {
    const r = Math.max(0, Math.min(500, Math.round(Number(remaining) || 0)));
    await env.MTO_STATE.put("remaining", String(r));
  }
  return getMtoState(env);
}

export async function resetMto(env) {
  const max = mtoMax(env);
  await env.MTO_STATE.put("enabled", "true");
  await env.MTO_STATE.put("remaining", String(max));
  return getMtoState(env);
}

/** Atomically consume MTO units. Returns new state or throws. */
export async function consumeMto(env, units) {
  if (units <= 0) return getMtoState(env);
  const state = await getMtoState(env);
  if (!state.enabled) {
    const err = new Error(
      "Made-to-order is on standby. Only in-stock quantities are available."
    );
    err.status = 409;
    throw err;
  }
  if (state.remaining < units) {
    const err = new Error(
      `Not enough made-to-order capacity (need ${units}, ${state.remaining} left). Reduce quantity or try again later.`
    );
    err.status = 409;
    throw err;
  }
  const next = state.remaining - units;
  await env.MTO_STATE.put("remaining", String(next));
  // Auto-standby when drained
  if (next <= 0) {
    await env.MTO_STATE.put("enabled", "false");
  }
  return getMtoState(env);
}

/**
 * Split requested qty into in-stock vs MTO.
 * stock null = untracked (treat as fully in-stock).
 */
export function allocateUnits(stock, qty, mtoState) {
  const q = Math.max(0, Math.round(qty));
  if (q <= 0) return { inStock: 0, mto: 0, ok: true };

  if (stock == null) {
    return { inStock: q, mto: 0, ok: true };
  }

  const available = Math.max(0, Math.floor(stock));
  const inStock = Math.min(q, available);
  const mto = q - inStock;

  if (mto <= 0) {
    return { inStock, mto: 0, ok: true };
  }

  if (!mtoState.open) {
    if (inStock > 0) {
      return {
        inStock,
        mto: 0,
        ok: false,
        error: `Only ${inStock} in stock (made-to-order is on standby).`,
        maxAllowed: inStock,
      };
    }
    return {
      inStock: 0,
      mto: 0,
      ok: false,
      error: "This item is unavailable (made-to-order is on standby).",
      maxAllowed: 0,
    };
  }

  if (mto > mtoState.remaining) {
    const maxAllowed = inStock + mtoState.remaining;
    return {
      inStock,
      mto: mtoState.remaining,
      ok: false,
      error: `Only ${maxAllowed} can be ordered right now (${inStock} in stock + ${mtoState.remaining} made-to-order).`,
      maxAllowed,
    };
  }

  return { inStock, mto, ok: true };
}

export function maxOrderable(stock, mtoState) {
  if (stock == null) return 20;
  const inStock = Math.max(0, Math.floor(stock));
  const mto = mtoState.open ? mtoState.remaining : 0;
  return Math.min(20, inStock + mto);
}

// --- Admin session (HMAC over ADMIN_PASSWORD) ---

function b64url(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlToBytes(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function createAdminToken(env) {
  const secret = env.ADMIN_PASSWORD;
  if (!secret) throw new Error("ADMIN_PASSWORD is not configured");
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = String(exp);
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload)
  );
  return `${payload}.${b64url(sig)}`;
}

export async function verifyAdminToken(env, token) {
  if (!token || !env.ADMIN_PASSWORD) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const exp = Number(payload);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  try {
    const key = await hmacKey(env.ADMIN_PASSWORD);
    return crypto.subtle.verify(
      "HMAC",
      key,
      b64urlToBytes(sig),
      new TextEncoder().encode(payload)
    );
  } catch {
    return false;
  }
}

export function extractBearer(request) {
  const h = request.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

export function isAdminHost(hostname) {
  return hostname.startsWith("admin.");
}
