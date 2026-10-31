import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { notifyFetch, notifyMerchant, NOTIFY_TIMEOUT_MS } from "../src/worker.js";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("notification fetches carry a timeout signal", async () => {
  const real = globalThis.fetch;
  let seen;
  globalThis.fetch = async (_u, init) => { seen = init; return new Response("{}"); };
  try {
    await notifyFetch("https://x.example", { method: "POST" });
    assert.ok(seen.signal instanceof AbortSignal);
    assert.ok(NOTIFY_TIMEOUT_MS > 0 && NOTIFY_TIMEOUT_MS <= 10000);
  } finally { globalThis.fetch = real; }
});

test("a hanging channel that aborts does not stop the others", async () => {
  const real = globalThis.fetch;
  const quiet = [console.error, console.warn, console.log];
  console.error = console.warn = console.log = () => {};
  globalThis.fetch = async (url) => {
    if (String(url).includes("ntfy")) {
      const e = new Error("timed out"); e.name = "TimeoutError"; throw e;
    }
    return new Response("{}");
  };
  try {
    const r = await notifyMerchant(
      { NTFY_TOPIC: "t", DISCORD_WEBHOOK_URL: "https://discord.example/h" },
      { subject: "[PMH] x", text: "y" }
    );
    assert.deepEqual(r.results.map((x) => x.channel), ["discord"]);
  } finally {
    globalThis.fetch = real;
    [console.error, console.warn, console.log] = quiet;
  }
});

test("/api/pay sends merchant alerts and receipt after the response", () => {
  const w = read("../src/worker.js");
  assert.match(w, /ctx\.waitUntil\(runNotifications\(\)\)/);
  assert.match(w, /return handlePay\(request, env, ctx\)/);
  assert.match(w, /route\(request, env, url, ctx\)/);
});

test("checkout shows processing at once and confirmation before teardown", () => {
  const js = read("../public/checkout.js");
  const html = read("../public/index.html");
  assert.match(html, /id="pay-processing"[\s\S]*Processing your payment…/);
  assert.match(js, /if \(busy\) showProcessing\(/);
  const confirmAt = js.indexOf("showConfirmation(data, mtoLabels);\n      hideProcessing();");
  const resetAt = js.indexOf("resetPaymentMethods().catch(");
  assert.ok(confirmAt > 0 && resetAt > confirmAt, "confirmation renders before payment teardown");
  assert.ok(!/await resetPaymentMethods\(\);\s*\n\s*showConfirmation/.test(js));
  assert.match(js, /PAY_TIMEOUT_MS/);
  assert.match(js, /You will not be charged twice/);
});

test("cart toast moves to the top while the checkout sheet is open", () => {
  const js = read("../public/checkout.js");
  const html = read("../public/index.html");
  assert.match(js, /toastEl\.classList\.toggle\("at-top", !!\(modal && !modal\.hidden\)\)/);
  assert.match(html, /\.cart-toast\.at-top \{[\s\S]*?top: 0.5rem;[\s\S]*?bottom: auto;/);
});

test("cart and pay summary name the chosen size/pack", () => {
  const js = read("../public/checkout.js");
  assert.match(js, /name\.textContent = v\.lineName \|\| v\.productName/);
  assert.match(js, /`\$\{p\.name\} — \$\{v\.name\}`/);
});

test("on phones the cart toast is dismissed when the sheet opens and never shown over it", () => {
  const js = read("../public/checkout.js");
  const html = read("../public/index.html");
  assert.match(js, /NARROW_MQ = "\(max-width: 899px\)"/);
  assert.match(js, /function openModal\(step\) \{[\s\S]*?if \(isNarrow\(\)\) hideToastNow\(\);/);
  assert.match(js, /modal && !modal\.hidden && isNarrow\(\)\) \{\s*hideToastNow\(\);/);
  assert.match(html, /\.cart-toast\.hush \{[\s\S]*?visibility: hidden;/);
  assert.match(html, /checkout\.js\?v=26/);
});
