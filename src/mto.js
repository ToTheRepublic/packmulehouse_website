/**
 * Made-to-order capacity (Durable Object) and admin session helpers.
 * The counter lives in one DO so two checkouts cannot oversell the pool.
 */

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

export function mtoMax(env) {
  const n = Number(env.MTO_MAX);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 50;
}

export function mtoPromise(env) {
  return env.MTO_PROMISE || "Ships within 1 week (all items together)";
}

export function lowStockThreshold(env) {
  const n = Number(env.LOW_STOCK_THRESHOLD);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 10;
}

function publicError(message, status) {
  const err = new Error(message);
  err.status = status;
  err.public = true;
  return err;
}

function shapeState(enabledRaw, remainingRaw, env) {
  const max = mtoMax(env);
  const rem = Math.max(0, Number(remainingRaw) || 0);
  const isEnabled = enabledRaw === true || enabledRaw === "true" || enabledRaw === "1";
  return {
    enabled: isEnabled,
    remaining: rem,
    max,
    promise: mtoPromise(env),
    open: isEnabled && rem > 0,
  };
}

export class MtoCounter {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    let body = {};
    if (request.method !== "GET") {
      try {
        body = await request.json();
      } catch {
        body = {};
      }
    }
    try {
      const data = await this.route(url.pathname, body);
      return Response.json(data);
    } catch (e) {
      const status = e.status || 500;
      return Response.json(
        { error: e.public ? e.message : "MTO counter error", public: !!e.public },
        { status }
      );
    }
  }

  async route(pathname, body) {
    switch (pathname) {
      case "/state":
        return this.getState();
      case "/set":
        return this.setState(body);
      case "/reset":
        return this.reset();
      case "/release":
        return this.release(body.units);
      case "/login/status":
        return this.loginStatus(body.ip);
      case "/login/fail":
        return this.loginFail(body.ip);
      case "/login/clear":
        return this.loginClear(body.ip);
      case "/attempt/reserve":
        return this.reserveAttempt(body.attemptId, body.units);
      case "/attempt/complete":
        return this.completeAttempt(body.attemptId, body.token, body.result);
      case "/attempt/abort":
        return this.abortAttempt(body.attemptId, body.token);
      default:
        throw publicError("Unknown MTO route", 404);
    }
  }

  async ensureSeed(txn) {
    const enabled = await txn.get("enabled");
    const remaining = await txn.get("remaining");
    if (enabled != null && remaining != null) return;
    const max = mtoMax(this.env);
    let seedEnabled = "true";
    let seedRemaining = max;
    if (this.env.MTO_STATE) {
      try {
        const e = await this.env.MTO_STATE.get("enabled");
        const r = await this.env.MTO_STATE.get("remaining");
        if (e != null) seedEnabled = e;
        if (r != null && r !== "") seedRemaining = Math.max(0, Number(r) || 0);
      } catch (err) {
        console.warn("MTO KV seed failed", err?.message);
      }
    }
    if (enabled == null) await txn.put("enabled", seedEnabled);
    if (remaining == null) await txn.put("remaining", seedRemaining);
  }

  async getState() {
    return this.ctx.storage.transaction(async (txn) => {
      await this.ensureSeed(txn);
      return shapeState(await txn.get("enabled"), await txn.get("remaining"), this.env);
    });
  }

  async setState({ enabled, remaining }) {
    return this.ctx.storage.transaction(async (txn) => {
      await this.ensureSeed(txn);
      if (typeof enabled === "boolean") {
        await txn.put("enabled", enabled ? "true" : "false");
      }
      if (remaining != null) {
        const r = Math.max(0, Math.min(500, Math.round(Number(remaining) || 0)));
        await txn.put("remaining", r);
      }
      return shapeState(await txn.get("enabled"), await txn.get("remaining"), this.env);
    });
  }

  async reset() {
    const max = mtoMax(this.env);
    return this.ctx.storage.transaction(async (txn) => {
      await txn.put("enabled", "true");
      await txn.put("remaining", max);
      return shapeState("true", max, this.env);
    });
  }

  async release(units) {
    const n = Math.max(0, Math.round(Number(units) || 0));
    if (n <= 0) return this.getState();
    return this.ctx.storage.transaction(async (txn) => {
      await this.ensureSeed(txn);
      const state = shapeState(
        await txn.get("enabled"),
        await txn.get("remaining"),
        this.env
      );
      const next = Math.min(state.max, state.remaining + n);
      await txn.put("remaining", next);
      if (next > 0 && !state.enabled) await txn.put("enabled", "true");
      return shapeState(await txn.get("enabled"), await txn.get("remaining"), this.env);
    });
  }

  async consumeInTxn(txn, units) {
    const n = Math.max(0, Math.round(Number(units) || 0));
    if (n <= 0) {
      return shapeState(await txn.get("enabled"), await txn.get("remaining"), this.env);
    }
    const state = shapeState(
      await txn.get("enabled"),
      await txn.get("remaining"),
      this.env
    );
    if (!state.enabled) {
      throw publicError(
        "Made-to-order is on standby. Only in-stock quantities are available.",
        409
      );
    }
    if (state.remaining < n) {
      throw publicError(
        `Not enough made-to-order capacity (need ${n}, ${state.remaining} left). Reduce quantity or try again later.`,
        409
      );
    }
    const next = state.remaining - n;
    await txn.put("remaining", next);
    if (next <= 0) await txn.put("enabled", "false");
    return shapeState(await txn.get("enabled"), next, this.env);
  }

  loginKey(ip) {
    return `login:${String(ip || "unknown").slice(0, 80)}`;
  }

  async loginStatus(ip) {
    const cur = (await this.ctx.storage.get(this.loginKey(ip))) || {
      fails: 0,
      lockUntil: 0,
    };
    const now = Date.now();
    if (cur.lockUntil > now) {
      return { locked: true, retryAfterMs: cur.lockUntil - now };
    }
    return { locked: false, fails: cur.fails || 0 };
  }

  async loginFail(ip) {
    const key = this.loginKey(ip);
    return this.ctx.storage.transaction(async (txn) => {
      const now = Date.now();
      const cur = (await txn.get(key)) || { fails: 0, lockUntil: 0 };
      if (cur.lockUntil > now) {
        return { locked: true, retryAfterMs: cur.lockUntil - now };
      }
      const fails = (cur.fails || 0) + 1;
      if (fails >= LOGIN_MAX_FAILS) {
        const lockUntil = now + LOGIN_LOCK_MS;
        await txn.put(key, { fails: 0, lockUntil });
        return { locked: true, retryAfterMs: LOGIN_LOCK_MS };
      }
      await txn.put(key, { fails, lockUntil: 0 });
      return { locked: false, fails };
    });
  }

  async loginClear(ip) {
    await this.ctx.storage.delete(this.loginKey(ip));
    return { ok: true };
  }

  async reserveAttempt(attemptId, units) {
    if (!attemptId) throw publicError("Missing checkout attempt", 400);
    const n = Math.max(0, Math.round(Number(units) || 0));
    return this.ctx.storage.transaction(async (txn) => {
      await this.ensureSeed(txn);
      const key = `attempt:${attemptId}`;
      const rec = await txn.get(key);
      if (rec?.phase === "done" && rec.result) {
        return { replay: true, result: rec.result };
      }
      const now = Date.now();
      if (rec?.phase === "reserved" && now - (rec.at || 0) < 25000) {
        return { busy: true };
      }
      let state;
      if (rec?.phase === "reserved") {
        state = shapeState(await txn.get("enabled"), await txn.get("remaining"), this.env);
      } else {
        state = await this.consumeInTxn(txn, n);
      }
      const token = crypto.randomUUID();
      await txn.put(key, {
        phase: "reserved",
        units: rec?.phase === "reserved" ? rec.units || 0 : n,
        token,
        at: now,
      });
      return { replay: false, busy: false, token, state, units: n };
    });
  }

  async completeAttempt(attemptId, token, result) {
    const key = `attempt:${attemptId}`;
    return this.ctx.storage.transaction(async (txn) => {
      const rec = await txn.get(key);
      if (!rec || rec.token !== token) return { first: false, owned: false };
      if (rec.phase === "done") return { first: false, owned: true, result: rec.result };
      await txn.put(key, {
        phase: "done",
        units: rec.units || 0,
        token,
        result,
        at: Date.now(),
      });
      return { first: true, owned: true, result };
    });
  }

  async abortAttempt(attemptId, token) {
    const key = `attempt:${attemptId}`;
    return this.ctx.storage.transaction(async (txn) => {
      const rec = await txn.get(key);
      if (!rec || rec.phase !== "reserved" || rec.token !== token) {
        return { released: 0, owned: false };
      }
      const units = Math.max(0, Number(rec.units) || 0);
      if (units > 0) {
        await this.ensureSeed(txn);
        const state = shapeState(
          await txn.get("enabled"),
          await txn.get("remaining"),
          this.env
        );
        const next = Math.min(state.max, state.remaining + units);
        await txn.put("remaining", next);
        if (next > 0 && !state.enabled) await txn.put("enabled", "true");
      }
      await txn.delete(key);
      return { released: units, owned: true };
    });
  }
}

function stub(env) {
  if (!env.MTO_COUNTER) return null;
  return env.MTO_COUNTER.get(env.MTO_COUNTER.idFromName("shop"));
}

async function mtoFetch(env, pathname, body) {
  const id = stub(env);
  if (!id) {
    const err = new Error("MTO counter is not configured");
    err.status = 500;
    throw err;
  }
  const res = await id.fetch(
    new Request(`https://mto.internal${pathname}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "MTO counter error");
    err.status = res.status;
    if (data.public) err.publicMessage = data.error;
    throw err;
  }
  return data;
}

export async function getMtoState(env) {
  if (!env.MTO_COUNTER) {
    const max = mtoMax(env);
    return {
      enabled: true,
      remaining: max,
      max,
      promise: mtoPromise(env),
      open: max > 0,
    };
  }
  return mtoFetch(env, "/state");
}

export async function setMtoState(env, patch) {
  return mtoFetch(env, "/set", patch);
}

export async function resetMto(env) {
  return mtoFetch(env, "/reset", {});
}

export async function releaseMto(env, units) {
  if (!env.MTO_COUNTER) return getMtoState(env);
  return mtoFetch(env, "/release", { units });
}

export async function reserveCheckout(env, attemptId, units) {
  return mtoFetch(env, "/attempt/reserve", { attemptId, units });
}

export async function completeCheckout(env, attemptId, token, result) {
  return mtoFetch(env, "/attempt/complete", { attemptId, token, result });
}

export async function abortCheckout(env, attemptId, token) {
  if (!env.MTO_COUNTER) return { released: 0 };
  return mtoFetch(env, "/attempt/abort", { attemptId, token });
}

export async function loginStatus(env, ip) {
  if (!env.MTO_COUNTER) return { locked: false, fails: 0, unavailable: true };
  return mtoFetch(env, "/login/status", { ip });
}

export async function loginFail(env, ip) {
  if (!env.MTO_COUNTER) return { locked: false, fails: 0, unavailable: true };
  return mtoFetch(env, "/login/fail", { ip });
}

export async function loginClear(env, ip) {
  if (!env.MTO_COUNTER) return { ok: false };
  return mtoFetch(env, "/login/clear", { ip });
}

/**
 * Split requested qty into in-stock vs MTO.
 * stock null = untracked (treat as fully in-stock).
 * quantity must already be an integer; non-integers are rejected.
 */
export function allocateUnits(stock, qty, mtoState) {
  if (!Number.isInteger(qty) || qty < 0) {
    return {
      inStock: 0,
      mto: 0,
      ok: false,
      error: "Quantity must be a whole number from 1 to 20",
    };
  }
  if (qty <= 0) return { inStock: 0, mto: 0, ok: true };

  if (stock == null) {
    return { inStock: qty, mto: 0, ok: true };
  }

  const available = Math.max(0, Math.floor(stock));
  const inStock = Math.min(qty, available);
  const mto = qty - inStock;

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
  const mto = mtoState?.open ? mtoState.remaining : 0;
  return Math.min(20, inStock + mto);
}

// --- Admin session (HMAC over ADMIN_SESSION_SECRET, not the password) ---

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

function timingSafeEqualBytes(a, b) {
  const left = a instanceof Uint8Array ? a : new Uint8Array(a);
  const right = b instanceof Uint8Array ? b : new Uint8Array(b);
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(left, right);
  }
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

export async function passwordsMatch(provided, expected) {
  const enc = new TextEncoder();
  const key = await hmacKey("pmh-password-compare-v1");
  const [a, b] = await Promise.all([
    crypto.subtle.sign("HMAC", key, enc.encode(String(provided ?? ""))),
    crypto.subtle.sign("HMAC", key, enc.encode(String(expected ?? ""))),
  ]);
  return timingSafeEqualBytes(new Uint8Array(a), new Uint8Array(b));
}

export async function createAdminToken(env) {
  const secret = env.ADMIN_SESSION_SECRET;
  if (!secret) throw new Error("ADMIN_SESSION_SECRET is not configured");
  const exp = Date.now() + SESSION_TTL_MS;
  const nonce = crypto.randomUUID();
  const payload = `${exp}.${nonce}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${b64url(sig)}`;
}

export async function verifyAdminToken(env, token) {
  if (!token || !env.ADMIN_SESSION_SECRET) return false;
  const parts = String(token).split(".");
  if (parts.length !== 3) return false;
  const [expRaw, nonce, sig] = parts;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  if (!nonce) return false;
  const payload = `${expRaw}.${nonce}`;
  try {
    const key = await hmacKey(env.ADMIN_SESSION_SECRET);
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

export function clientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}
