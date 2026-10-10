/**
 * Shipping address checks. US only: state code + ZIP or ZIP+4.
 * Kept pure so checkout rules can be unit-tested without Square.
 */

export const US_STATE_CODES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID",
  "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO",
  "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA",
  "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "PR", "VI", "GU", "AS", "MP",
];

const US_STATES = new Set(US_STATE_CODES);
const ZIP_RE = /^\d{5}(-\d{4})?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(value, max) {
  const s = String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
  if (s.length > max) return { error: "too_long", value: s };
  return { value: s };
}

export function parseAddress(body) {
  const a = body?.shippingAddress || body?.address || {};
  const firstName = clean(a.firstName || a.first_name || body?.firstName || "", 80).value;
  const lastName = clean(a.lastName || a.last_name || body?.lastName || "", 80).value;
  const displayNameRaw =
    clean(a.displayName || a.name || "", 120).value ||
    [firstName, lastName].filter(Boolean).join(" ").trim();
  const displayName = displayNameRaw.slice(0, 120);
  const email = clean(a.email || body?.buyerEmail || body?.email || "", 200).value;
  const phone = clean(a.phone || a.phoneNumber || body?.phone || "", 30).value;
  const addressLine1 = clean(a.addressLine1 || a.line1 || a.address1 || "", 120).value;
  const addressLine2 = clean(a.addressLine2 || a.line2 || a.address2 || "", 120).value;
  const city = clean(a.city || a.locality || "", 80).value;
  const state = clean(
    a.state || a.administrativeDistrictLevel1 || a.region || "",
    40
  ).value.toUpperCase();
  const postalCode = clean(a.postalCode || a.postal || a.zip || "", 20).value;
  const country = clean(a.country || "US", 10).value.toUpperCase() || "US";

  const missing = [];
  if (!displayName) missing.push("name");
  if (!email || !EMAIL_RE.test(email)) missing.push("email");
  if (!addressLine1) missing.push("address");
  if (!city) missing.push("city");
  if (!state || !US_STATES.has(state)) missing.push("state");
  if (!postalCode || !ZIP_RE.test(postalCode)) missing.push("postal code");
  if (country !== "US") missing.push("country");

  if (missing.length) {
    const hints = [];
    if (missing.includes("country")) hints.push("we only ship to US addresses");
    if (missing.includes("state")) hints.push("use a 2-letter US state code");
    if (missing.includes("postal code")) hints.push("use a 5-digit ZIP or ZIP+4");
    const extra = hints.length ? ` (${hints.join("; ")})` : "";
    return {
      error: `Missing or invalid shipping fields: ${missing.join(", ")}${extra}`,
    };
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
      country: "US",
    },
  };
}
