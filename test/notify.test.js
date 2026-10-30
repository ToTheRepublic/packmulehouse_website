import test from "node:test";
import assert from "node:assert/strict";
import { notifyMerchant } from "../src/worker.js";

const payload = { subject: "[PMH] Order", text: "1x X-Frame" };

async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const hits = [];
  globalThis.fetch = async (url, init) => {
    hits.push(String(url));
    return handler(String(url), init);
  };
  const quiet = [console.error, console.warn, console.log];
  console.error = console.warn = console.log = () => {};
  try {
    return await fn(hits);
  } finally {
    globalThis.fetch = real;
    [console.error, console.warn, console.log] = quiet;
  }
}

const env = {
  NTFY_TOPIC: "t",
  DISCORD_WEBHOOK_URL: "https://discord.example/hook",
  EMAIL_FROM: "Pack Mule House <onboarding@resend.dev>",
};

test("no RESEND_API_KEY: email is skipped, ntfy and Discord still notified", async () => {
  await withFetch(() => new Response("{}", { status: 200 }), async (hits) => {
    const r = await notifyMerchant(env, payload);
    assert.deepEqual(r.results.map((x) => x.channel), ["ntfy", "discord"]);
    assert.ok(!hits.some((u) => u.includes("resend")));
  });
});

test("Resend failing does not stop ntfy/Discord or throw", async () => {
  await withFetch(
    (url) =>
      url.includes("resend")
        ? new Response(JSON.stringify({ message: "invalid key" }), { status: 401 })
        : new Response("{}", { status: 200 }),
    async () => {
      const r = await notifyMerchant({ ...env, RESEND_API_KEY: "bad" }, payload);
      assert.deepEqual(r.results.map((x) => x.channel), ["ntfy", "discord"]);
      assert.match(r.errors.join(), /resend: invalid key/);
    }
  );
});

test("Resend throwing (network) is caught too", async () => {
  await withFetch(
    (url) => {
      if (url.includes("resend")) throw new Error("network down");
      return new Response("{}", { status: 200 });
    },
    async () => {
      const r = await notifyMerchant({ ...env, RESEND_API_KEY: "k" }, payload);
      assert.equal(r.results.length, 2);
    }
  );
});
