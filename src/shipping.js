/**
 * Flat-rate shipping phrase and made-to-order lead times.
 * The phrase is built from SHIPPING_CENTS so the words match the charge.
 */

export function flatRateShippingPhrase(cents) {
  const n = Number(cents);
  const amount = Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
  const dollars = amount / 100;
  const text = Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
  return `${text} flat-rate shipping`;
}

function positiveWeeks(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** "X-Frame:1, Wind River Canyon:2" or a JSON object. Keys are category ids or names. */
export function leadTimeRulesFromEnv(env) {
  const defaultWeeks = positiveWeeks(env?.LEAD_TIME_WEEKS_DEFAULT, 1);
  const raw = String(env?.LEAD_TIME_WEEKS ?? "X-Frame:1, Wind River Canyon:2").trim();
  const rules = [];
  if (!raw) return { defaultWeeks, rules };

  if (raw.startsWith("{")) {
    try {
      const obj = JSON.parse(raw);
      for (const [key, weeks] of Object.entries(obj || {})) {
        const name = String(key || "").trim();
        const n = positiveWeeks(weeks, 0);
        if (name && n) rules.push({ key: name, weeks: n });
      }
    } catch {
      /* ignore a broken JSON var and fall through to the default weeks */
    }
    return { defaultWeeks, rules };
  }

  for (const part of raw.split(",")) {
    const idx = part.lastIndexOf(":");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const weeks = positiveWeeks(part.slice(idx + 1), 0);
    if (key && weeks) rules.push({ key, weeks });
  }
  return { defaultWeeks, rules };
}

/**
 * Match a category id, category name, or item name. The longest key wins
 * so "Wind River Canyon" beats a shorter "X-Frame" mention on the same item.
 */
export function leadTimeWeeks({ name = "", categoryIds = [], categoryNames = [] } = {}, rules) {
  const parsed = rules?.rules ? rules : { defaultWeeks: 1, rules: [] };
  const hay = [name, ...categoryIds, ...categoryNames]
    .map((s) => String(s || "").trim().toLowerCase())
    .filter(Boolean);
  let best = null;
  for (const rule of parsed.rules) {
    const key = String(rule.key || "").trim().toLowerCase();
    if (!key) continue;
    const hit = hay.some((h) => h === key || h.includes(key));
    if (!hit) continue;
    if (!best || key.length > best.key.length) best = { key, weeks: rule.weeks };
  }
  return best ? best.weeks : parsed.defaultWeeks;
}

export function leadTimeLabel(weeks) {
  const n = positiveWeeks(weeks, 1);
  const unit = n === 1 ? "week" : "weeks";
  return `Made to order: ships in about ${n} ${unit}`;
}

export function leadTimePolicySentence(rules) {
  const parsed = rules?.rules ? rules : leadTimeRulesFromEnv(rules);
  const named = parsed.rules.map(
    (r) => `${r.key} ships in about ${r.weeks} ${r.weeks === 1 ? "week" : "weeks"}`
  );
  const rest = `Other made-to-order items ship in about ${parsed.defaultWeeks} ${
    parsed.defaultWeeks === 1 ? "week" : "weeks"
  }.`;
  return named.length ? `${named.join(". ")}. ${rest}` : rest;
}

/** Square's Apple Pay domain file. Sandbox and production files differ. */
export function applePayAssociation(env) {
  const production = (env?.SQUARE_ENVIRONMENT || "sandbox") === "production";
  const specific = production
    ? env?.APPLE_PAY_DOMAIN_ASSOCIATION_PRODUCTION
    : env?.APPLE_PAY_DOMAIN_ASSOCIATION_SANDBOX;
  return String(specific || env?.APPLE_PAY_DOMAIN_ASSOCIATION || "");
}
