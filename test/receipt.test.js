import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildCustomerReceipt, ntfyMessage, sendCustomerReceipt } from "../src/worker.js";

const order = {
  lines: [{ itemName: "X-Frame Complete Kit (4x6 Drop In Complete Kit)", quantity: 1, lineTotal: 2200 }],
  shipping: 1000,
  subtotal: 2200,
  discount: 0,
  tax: 0,
  taxIncluded: true,
  taxNote: "Prices include tax",
  total: 3200,
  currency: "USD",
  shippingInfo: {
    displayName: "Jane <b>Doe</b>",
    email: "jane@example.com",
    address: { address_line_1: "123 Main St", locality: "Thermopolis", administrative_district_level_1: "WY", postal_code: "82443" },
  },
  orderId: "ORDER123456",
  promise: "Ships within 1 week (all items together)",
  contactEmail: "packmulehouse@gmail.com",
};

async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return handler(String(url));
  };
  const quiet = [console.error, console.warn];
  console.error = console.warn = () => {};
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = real;
    [console.error, console.warn] = quiet;
  }
}

test("receipt has items with size, totals, address and ship promise; HTML escaped", () => {
  const r = buildCustomerReceipt(order);
  assert.equal(r.to, "jane@example.com");
  assert.equal(r.replyTo, "packmulehouse@gmail.com");
  assert.match(r.subject, /Your Pack Mule House order #123456 \(\$32\.00\)/);
  for (const s of ["4x6 Drop In", "$22.00", "Shipping: $10.00", "Total paid: $32.00", "Ships within 1 week", "123 Main St", "Thermopolis, WY 82443"]) {
    assert.ok(r.text.includes(s), s);
  }
  assert.match(r.html, /Jane &lt;b&gt;Doe&lt;\/b&gt;/);
  assert.doesNotMatch(r.html, /<b>Doe/);
});

test("receipt goes to the buyer through Resend from EMAIL_FROM", async () => {
  await withFetch(() => new Response(JSON.stringify({ id: "re_1" }), { status: 200 }), async (calls) => {
    const out = await sendCustomerReceipt(
      { RESEND_API_KEY: "k", EMAIL_FROM: "Pack Mule House <orders@packmulehouse.com>" },
      buildCustomerReceipt(order)
    );
    assert.deepEqual(out, { ok: true, id: "re_1" });
    assert.equal(calls[0].url, "https://api.resend.com/emails");
    assert.deepEqual(calls[0].body.to, ["jane@example.com"]);
    assert.equal(calls[0].body.from, "Pack Mule House <orders@packmulehouse.com>");
  });
});

test("receipt is best-effort: no key, bad email, or Resend error never throws", async () => {
  assert.equal((await sendCustomerReceipt({}, buildCustomerReceipt(order))).skipped, true);
  const noEmail = buildCustomerReceipt({ ...order, shippingInfo: { ...order.shippingInfo, email: "" } });
  assert.equal((await sendCustomerReceipt({ RESEND_API_KEY: "k", EMAIL_FROM: "a@b.co" }, noEmail)).skipped, true);
  await withFetch(
    () => new Response(JSON.stringify({ name: "validation_error", message: "The packmulehouse.com domain is not verified." }), { status: 403 }),
    async () => {
      const out = await sendCustomerReceipt({ RESEND_API_KEY: "k", EMAIL_FROM: "a@b.co" }, buildCustomerReceipt(order));
      assert.equal(out.ok, false);
      assert.match(out.error, /Resend 403 validation_error: The packmulehouse\.com domain is not verified/);
    }
  );
});

test("ntfy publishes JSON so a non-ASCII title isn't sent as a header", () => {
  const m = ntfyMessage("topic", "[PMH] New order $32.00 — Jane", "body");
  assert.equal(m.topic, "topic");
  assert.equal(m.title, "[PMH] New order $32.00 — Jane");
  const src = fs.readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /Title: headerSafe/);
});

test("no 'Only N left' on cards; mobile checkout doesn't zoom or re-centre", () => {
  const js = fs.readFileSync(new URL("../public/checkout.js", import.meta.url), "utf8");
  assert.match(js, /p\.stockTone !== "fomo"/);
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /\.field select \{[^}]*font-size: 16px;/);
  assert.match(html, /@media \(max-width: 600px\) \{\s*\.modal-overlay \{[^}]*align-items: stretch;/);
  assert.match(html, /#card-container \{\s*min-height: 143px;/);
  assert.match(js, /!isTouchScreen\(\)\) nameField\.focus/);
});
