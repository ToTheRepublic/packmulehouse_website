import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CONTENT_SECURITY_POLICY } from "../src/headers.js";
import { mtoConfirmationLine, paymentErrorMessage, PAYMENT_RETRY } from "../src/payments.js";

test("decline codes become customer sentences and hide Square details", () => {
  assert.equal(
    paymentErrorMessage([{ code: "GENERIC_DECLINE", detail: "Authorization error: 'GENERIC_DECLINE'" }]),
    "Your card was declined. Try another card or payment method."
  );
  assert.match(paymentErrorMessage([{ code: "CVV_FAILURE", detail: "CVV_FAILURE" }]), /security code/i);
  assert.match(paymentErrorMessage([{ code: "INSUFFICIENT_FUNDS", detail: "INSUFFICIENT_FUNDS" }]), /enough funds/i);
  assert.match(
    paymentErrorMessage([{ code: "ADDRESS_VERIFICATION_FAILURE", detail: "postal code is invalid" }]),
    /ZIP/i
  );
  assert.match(paymentErrorMessage([{ code: "INVALID_EXPIRATION", detail: "INVALID_EXPIRATION" }]), /expiration/i);
  const gift = paymentErrorMessage([
    { code: "INSUFFICIENT_FUNDS", detail: "Gift card does not have sufficient balance.", category: "PAYMENT_METHOD_ERROR" },
    { code: "GIFT_CARD_AVAILABLE_AMOUNT", detail: "4494", category: "PAYMENT_METHOD_ERROR" },
  ]);
  assert.match(gift, /gift card/i);
  assert.doesNotMatch(gift, /4494/);
  assert.equal(paymentErrorMessage([{ code: "NOT_FOUND", detail: "secret internal detail" }]), null);
  assert.doesNotMatch(PAYMENT_RETRY, /GENERIC_DECLINE|CVV_FAILURE/);
});

test("made-to-order confirmation pluralizes", () => {
  assert.equal(mtoConfirmationLine(1), "1 item is made to order.");
  assert.equal(mtoConfirmationLine(2), "2 items are made to order.");
  assert.equal(
    mtoConfirmationLine(1, "Made to order: ships in about 1 week"),
    "1 item is made to order. Made to order: ships in about 1 week"
  );
  const checkout = fs.readFileSync(new URL("../public/checkout.js", import.meta.url), "utf8");
  assert.match(checkout, /mtoConfirmationLine/);
  assert.doesNotMatch(checkout, /unit\(s\) are made to order/);
});

test("content security policy allows Cash App Pay kit and fonts", () => {
  const script = CONTENT_SECURITY_POLICY.split("; ").find((d) => d.startsWith("script-src"));
  const font = CONTENT_SECURITY_POLICY.split("; ").find((d) => d.startsWith("font-src"));
  const connect = CONTENT_SECURITY_POLICY.split("; ").find((d) => d.startsWith("connect-src"));
  const frame = CONTENT_SECURITY_POLICY.split("; ").find((d) => d.startsWith("frame-src"));
  const style = CONTENT_SECURITY_POLICY.split("; ").find((d) => d.startsWith("style-src"));
  for (const host of ["https://sandbox.kit.cash.app", "https://kit.cash.app"]) {
    assert.match(script, new RegExp(host.replaceAll(".", "\\.")));
    assert.match(frame, new RegExp(host.replaceAll(".", "\\.")));
    assert.match(style, new RegExp(host.replaceAll(".", "\\.")));
  }
  assert.match(font, /https:\/\/cash-f\.squarecdn\.com/);
  assert.match(connect, /https:\/\/sandbox\.pay\.cash\.app/);
  assert.match(connect, /https:\/\/pay\.cash\.app/);
  assert.match(connect, /https:\/\/sandbox\.api\.cash\.app/);
  assert.match(connect, /https:\/\/api\.cash\.app/);
  assert.match(script, /https:\/\/pay\.google\.com/);
  assert.match(script, /https:\/\/www\.gstatic\.com/);
});
