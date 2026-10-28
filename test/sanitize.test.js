import test from "node:test";
import assert from "node:assert/strict";
import { discordSafe, headerSafe, telegramSafe } from "../src/sanitize.js";
import { idempotencyKey, parseAttemptId } from "../src/idempotency.js";
import { passwordsMatch } from "../src/mto.js";

test("discord text neutralizes mentions and markdown", () => {
  const out = discordSafe("Hi @everyone <@123> **Ada** [click](http://evil)");
  assert.equal(out.includes("@everyone"), false);
  assert.match(out, /@\u200beveryone/);
  assert.match(out, /<@\u200b123>/);
  assert.match(out, /\\\*/);
  assert.match(out, /\]\\\(/);
});

test("headers cannot be split by newlines", () => {
  assert.equal(headerSafe("Order\r\nX-Injected: yes"), "Order X-Injected: yes");
});

test("telegram breaks @ mentions including emails", () => {
  const out = telegramSafe("ada@example.com @everyone");
  assert.equal(out.includes("@e"), false);
  assert.match(out, /ada@\u200bexample/);
});

test("idempotency keys are stable and purpose-specific", async () => {
  const attempt = "11111111-2222-4333-8444-555555555555";
  const a = await idempotencyKey(attempt, "order");
  const b = await idempotencyKey(attempt, "order");
  const c = await idempotencyKey(attempt, "payment");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 32);
  assert.equal(parseAttemptId(attempt), attempt);
  assert.equal(parseAttemptId("short"), null);
  assert.equal(parseAttemptId("has spaces in it!!!!"), null);
});

test("password compare is equal only for the same string", async () => {
  assert.equal(await passwordsMatch("correct horse", "correct horse"), true);
  assert.equal(await passwordsMatch("correct horse", "correct horses"), false);
  assert.equal(await passwordsMatch("a", "aaaaaaaaaaaaaaaa"), false);
});
