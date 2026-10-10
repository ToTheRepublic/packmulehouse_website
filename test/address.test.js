import test from "node:test";
import assert from "node:assert/strict";
import { parseAddress } from "../src/address.js";

function body(overrides = {}) {
  return {
    shippingAddress: {
      displayName: "Ada Lovelace",
      email: "ada@example.com",
      phone: "307-555-0100",
      addressLine1: "123 Main St",
      city: "Thermopolis",
      state: "wy",
      postalCode: "82443",
      country: "US",
      ...overrides,
    },
  };
}

test("accepts a US address and normalizes the state code", () => {
  const parsed = parseAddress(body());
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.address.administrative_district_level_1, "WY");
  assert.equal(parsed.address.country, "US");
  assert.equal(parsed.address.postal_code, "82443");
});

test("accepts ZIP+4", () => {
  const parsed = parseAddress(body({ postalCode: "82443-1234" }));
  assert.equal(parsed.address.postal_code, "82443-1234");
});

test("rejects non-US countries, full state names, and short ZIPs", () => {
  assert.match(parseAddress(body({ country: "CA" })).error, /country/);
  assert.match(parseAddress(body({ state: "Wyoming" })).error, /state/);
  assert.match(parseAddress(body({ postalCode: "8244" })).error, /postal code/);
  assert.match(parseAddress(body({ postalCode: "824433" })).error, /postal code/);
  assert.match(parseAddress(body({ email: "not-an-email" })).error, /email/);
});
