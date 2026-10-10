import test from "node:test";
import assert from "node:assert/strict";
import {
  applePayAssociation,
  flatRateShippingPhrase,
  leadTimeLabel,
  leadTimePolicySentence,
  leadTimeRulesFromEnv,
  leadTimeWeeks,
} from "../src/shipping.js";

test("flat-rate phrase follows the configured cents", () => {
  assert.equal(flatRateShippingPhrase(1000), "$10 flat-rate shipping");
  assert.equal(flatRateShippingPhrase("1050"), "$10.50 flat-rate shipping");
  assert.equal(flatRateShippingPhrase(0), "$0 flat-rate shipping");
});

test("lead times default to 1 week and match category name or id", () => {
  const rules = leadTimeRulesFromEnv({});
  assert.equal(rules.defaultWeeks, 1);
  assert.equal(leadTimeWeeks({ name: "Something else" }, rules), 1);
  assert.equal(
    leadTimeWeeks({ name: "Brass tag", categoryNames: ["Keychains"] }, rules),
    1
  );
  assert.equal(leadTimeWeeks({ name: "X-Frame Drop-In Kit" }, rules), 1);
  assert.equal(leadTimeWeeks({ name: "Wind River Canyon Overlook" }, rules), 2);
  assert.equal(
    leadTimeWeeks({ name: "Kit", categoryIds: ["CAT_WIND"], categoryNames: [] }, {
      defaultWeeks: 1,
      rules: [
        { key: "X-Frame", weeks: 1 },
        { key: "CAT_WIND", weeks: 2 },
      ],
    }),
    2
  );
  assert.equal(
    leadTimeLabel(1),
    "Made to order: ships in about 1 week"
  );
  assert.equal(
    leadTimeLabel(2),
    "Made to order: ships in about 2 weeks"
  );
});

test("a longer lead-time key wins when both match", () => {
  const rules = {
    defaultWeeks: 1,
    rules: [
      { key: "Canyon", weeks: 3 },
      { key: "Wind River Canyon", weeks: 2 },
    ],
  };
  assert.equal(leadTimeWeeks({ name: "Wind River Canyon model" }, rules), 2);
});

test("JSON lead-time map is accepted", () => {
  const rules = leadTimeRulesFromEnv({
    LEAD_TIME_WEEKS_DEFAULT: "1",
    LEAD_TIME_WEEKS: '{"Wind River Canyon":2,"ABC123":4}',
  });
  assert.equal(leadTimeWeeks({ categoryIds: ["ABC123"] }, rules), 4);
  assert.match(leadTimePolicySentence(rules), /Wind River Canyon ships in about 2 weeks/);
});

test("Apple Pay association file follows the Square environment", () => {
  const env = {
    SQUARE_ENVIRONMENT: "sandbox",
    APPLE_PAY_DOMAIN_ASSOCIATION_SANDBOX: "sandbox-file",
    APPLE_PAY_DOMAIN_ASSOCIATION_PRODUCTION: "prod-file",
    APPLE_PAY_DOMAIN_ASSOCIATION: "fallback",
  };
  assert.equal(applePayAssociation(env), "sandbox-file");
  assert.equal(
    applePayAssociation({ ...env, SQUARE_ENVIRONMENT: "production" }),
    "prod-file"
  );
  assert.equal(
    applePayAssociation({ SQUARE_ENVIRONMENT: "sandbox", APPLE_PAY_DOMAIN_ASSOCIATION: "fallback" }),
    "fallback"
  );
  assert.equal(applePayAssociation({}), "");
});
