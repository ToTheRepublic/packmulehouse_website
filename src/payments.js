/**
 * Customer-facing payment errors. Square's code and detail stay in the
 * server log. The browser only receives one of these sentences.
 */

export const PAYMENT_RETRY = "Payment could not be completed. Please try again.";

const CARD_DECLINED = "Your card was declined. Try another card or payment method.";

const MESSAGES = {
  GENERIC_DECLINE: CARD_DECLINED,
  CARD_DECLINED: CARD_DECLINED,
  CARD_DECLINED_CALL_ISSUER:
    "Your card was declined. Contact your card issuer, or try another payment method.",
  CARD_DECLINED_VERIFICATION_REQUIRED:
    "Your card needs an extra check that didn't finish. Try again, or use another card.",
  CVV_FAILURE: "The security code was declined. Check the CVV and try again, or use another card.",
  VERIFY_CVV_FAILURE:
    "The security code was declined. Check the CVV and try again, or use another card.",
  INSUFFICIENT_FUNDS:
    "There aren't enough funds for this payment. Try another card or payment method.",
  ADDRESS_VERIFICATION_FAILURE:
    "The billing ZIP didn't match this card. Check it and try again, or use another card.",
  INVALID_POSTAL_CODE:
    "The billing ZIP didn't match this card. Check it and try again, or use another card.",
  VERIFY_AVS_FAILURE:
    "The billing ZIP didn't match this card. Check it and try again, or use another card.",
  INVALID_EXPIRATION:
    "The expiration date was declined. Check the date and try again, or use another card.",
  EXPIRATION_FAILURE:
    "The expiration date was declined. Check the date and try again, or use another card.",
  BAD_EXPIRATION:
    "The expiration date was declined. Check the date and try again, or use another card.",
  CARD_EXPIRED: "This card is expired. Try another card or payment method.",
  INVALID_CARD: "Those card details didn't work. Check them and try again, or use another payment method.",
  INVALID_CARD_DATA:
    "Those card details didn't work. Check them and try again, or use another payment method.",
  PAN_FAILURE: "The card number was declined. Check it and try again, or use another card.",
  TRANSACTION_LIMIT: "This charge is over the card's limit. Try another card or payment method.",
  PAYMENT_LIMIT_EXCEEDED: "This charge is over the card's limit. Try another card or payment method.",
  VOICE_FAILURE: "Your card was declined. Contact your card issuer, or try another payment method.",
  CARD_TOKEN_EXPIRED: "The payment form expired. Refresh the page and try again.",
  CARD_TOKEN_USED: "That payment was already submitted. Check your cart before trying again.",
};

const PRIORITY = [
  "CVV_FAILURE",
  "VERIFY_CVV_FAILURE",
  "ADDRESS_VERIFICATION_FAILURE",
  "INVALID_POSTAL_CODE",
  "VERIFY_AVS_FAILURE",
  "INVALID_EXPIRATION",
  "EXPIRATION_FAILURE",
  "BAD_EXPIRATION",
  "CARD_EXPIRED",
  "INSUFFICIENT_FUNDS",
  "GENERIC_DECLINE",
  "CARD_DECLINED",
  "CARD_DECLINED_CALL_ISSUER",
  "CARD_DECLINED_VERIFICATION_REQUIRED",
  "INVALID_CARD",
  "INVALID_CARD_DATA",
  "PAN_FAILURE",
  "TRANSACTION_LIMIT",
  "PAYMENT_LIMIT_EXCEEDED",
  "VOICE_FAILURE",
  "CARD_TOKEN_EXPIRED",
  "CARD_TOKEN_USED",
];

/**
 * Map a Square `errors` array to a sentence, or null when the failure is not
 * a payment-method decline (the caller uses a generic retry sentence).
 */
export function paymentErrorMessage(errors) {
  const list = Array.isArray(errors) ? errors : [];
  const codes = new Set(list.map((e) => e?.code).filter(Boolean));
  if (codes.has("INSUFFICIENT_FUNDS") && codes.has("GIFT_CARD_AVAILABLE_AMOUNT")) {
    return "This gift card doesn't cover the order. Try another payment method.";
  }
  for (const code of PRIORITY) {
    if (codes.has(code) && MESSAGES[code]) return MESSAGES[code];
  }
  if (list.some((e) => e?.category === "PAYMENT_METHOD_ERROR")) return CARD_DECLINED;
  return null;
}

/** "1 item is made to order." / "2 items are made to order." plus an optional lead time. */
export function mtoConfirmationLine(count, lead) {
  const n = Math.max(0, Math.round(Number(count) || 0));
  const sentence = n === 1 ? "1 item is made to order." : `${n} items are made to order.`;
  const extra = String(lead || "").trim();
  return extra ? `${sentence} ${extra}` : sentence;
}
