import test from "node:test";
import assert from "node:assert/strict";
import { htmlBlocks, checkoutEnabled } from "../src/worker.js";
import { contentSecurityPolicy } from "../src/headers.js";

const page = `<a>Shop</a><!--@checkout--><button id="cart-open"></button><div id="checkout-modal"><!--@sandbox--><p id="sandbox-card-hint"></p><!--/@sandbox--></div><!--/@checkout--><!--@nocheckout--><p>opens soon</p><!--/@nocheckout--><!--@sandbox--><span id="env-badge"></span><!--/@sandbox-->`;

test("checkout off drops cart, modal and sandbox markup", () => {
  const out = htmlBlocks(page, { CHECKOUT_ENABLED: "false" });
  assert.equal(out, "<a>Shop</a><p>opens soon</p>");
  assert.equal(checkoutEnabled({}), false);
});

test("checkout on keeps the modal; sandbox bits only in sandbox", () => {
  const sb = htmlBlocks(page, { CHECKOUT_ENABLED: "true" });
  assert.match(sb, /sandbox-card-hint/);
  assert.match(sb, /env-badge/);
  assert.doesNotMatch(sb, /opens soon/);
  const prod = htmlBlocks(page, { CHECKOUT_ENABLED: "true", SQUARE_ENVIRONMENT: "production" });
  assert.match(prod, /checkout-modal/);
  assert.doesNotMatch(prod, /sandbox-card-hint|env-badge/);
});

test("production CSP has no sandbox hosts and allows Cloudflare analytics", () => {
  const prod = contentSecurityPolicy({ SQUARE_ENVIRONMENT: "production" });
  assert.doesNotMatch(prod, /sandbox|squareupsandbox|songbirdstag|gateway-cert/);
  assert.match(prod, /https:\/\/web\.squarecdn\.com/);
  assert.match(prod, /script-src [^;]*https:\/\/static\.cloudflareinsights\.com/);
  assert.match(prod, /connect-src [^;]*https:\/\/cloudflareinsights\.com/);
  assert.match(contentSecurityPolicy({}), /sandbox\.web\.squarecdn\.com/);
});
