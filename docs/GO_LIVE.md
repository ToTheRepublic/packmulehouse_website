# Going live

Sandbox stays the default until every line below is done. Leave `TAX_MODE` as `included` unless you decide to add tax on top of shelf prices. Do not change `TAX_PERCENT` as part of the switch.

## Square

1. Create a **production** Square application and copy its application id into `SQUARE_APPLICATION_ID`.
2. Copy the production location id into `SQUARE_LOCATION_ID`.
3. Set `SQUARE_ENVIRONMENT` to `production`.
4. Replace the access token secret with the production token:

   ```bash
   printf '%s' "$SQUARE_ACCESS_TOKEN" | npx wrangler secret put SQUARE_ACCESS_TOKEN
   ```

5. In the Square Dashboard, put each product you sell on the site into one of the shop categories below.

## Shop categories

`SHOP_CATEGORIES` is the ordered list of Square categories the shop sells. The default is `X-Frame, Wind River Canyon, Keychains`. Each entry is a category name or a category id. Names match without regard to case, so the same list works in sandbox and production. An item can sit in more than one category: Square’s `categories` array and the older `category_id` both count, and the item is listed under every matching section.

The storefront renders one section per category, in that order, with the category name as the heading. A category with no items is skipped. If `SHOP_CATEGORIES` is unset, the site lists the whole catalog in one grid, the same as before. `SQUARE_CATEGORY_ID` and `SQUARE_ITEM_IDS` are still optional id allowlists.

In the Square Dashboard, create those categories and assign each product. A new item appears on the site after the next catalog load. You do not edit the website to add it. `/api/quote` and `/api/pay` reject any variation whose item is outside the allowed categories.

Lead times stay on `LEAD_TIME_WEEKS` (`X-Frame:1, Wind River Canyon:2`). Keychains are not in that map, so they use `LEAD_TIME_WEEKS_DEFAULT` (1 week).

The live sandbox catalog, with the filter unset, currently lists four items: Peel & Stick, X-Frame 4×6, X-Frame 5×7, and X-Frame 8×10. The public catalog response does not include category assignment, and this repo does not have the sandbox access token, so it was not possible to confirm those items are in a category named X-Frame. With `SHOP_CATEGORIES` set, an item with no matching category is left off the shop and cannot be checked out. If the sandbox shop is empty after deploy, open the sandbox Square Dashboard, create a category named X-Frame, and assign those four items to it. Wind River Canyon and Keychains stay hidden until those categories have at least one item.

## Domain and email

1. Attach the custom domain / route in the Cloudflare dashboard (Workers route or custom domain). Do not rely on `*.workers.dev` for the public shop.
2. Set `SITE_ORIGIN` to that origin, including `https://` and no trailing path. This is the canonical URL. The workers.dev hostname stays `noindex`.
3. Verify the sending domain in Resend and set `EMAIL_FROM` to an address on that domain, for example `Pack Mule House <orders@yourdomain>`. `onboarding@resend.dev` only delivers to the Resend account owner.
4. Put `RESEND_API_KEY` in a secret if you want email alerts.

## Secrets to set before the next deploy

These are new or newly required. The next deploy will not boot admin login or private ntfy until they exist.

```bash
npx wrangler secret put ADMIN_SESSION_SECRET   # long random string; rotate to revoke sessions
npx wrangler secret put NTFY_TOPIC             # new private topic — do not reuse the old public one
npx wrangler secret put NTFY_TOKEN             # optional, if the topic requires auth
npx wrangler secret put ADMIN_PASSWORD         # already required
npx wrangler secret put SQUARE_ACCESS_TOKEN    # production token when you cut over
```

`ADMIN_SESSION_SECRET` must be different from the password. Changing it signs every admin out.

## Made-to-order counter

`wrangler.jsonc` adds a Durable Object (`MtoCounter`). The first request copies `enabled` and `remaining` out of the existing `MTO_STATE` KV namespace, then the counter lives in the Durable Object so two checkouts cannot oversell it. Confirm the admin console at `/admin` after deploy and reset the pool if the numbers look wrong.

## Prices and tax

Website prices match in-person market prices. `TAX_MODE` defaults to `included`: the quote, cart, checkout, and Square order have no sales-tax line. The total is subtotal − Square discounts + shipping. The shop shows “Prices include tax” next to prices and the cart and checkout totals.

`TAX_PERCENT` stays `6` so the rate is ready if you switch later. Set `TAX_MODE` to `added` to charge that percent on top of merchandise, and on shipping when `TAX_APPLIES_TO_SHIPPING` is `true`. Included mode tells Square not to apply location tax rules (`auto_apply_taxes: false`) and still applies catalog discounts (`auto_apply_discounts: true`). `/api/config` returns `tax.mode`, `tax.included`, `tax.chargesTax`, and `tax.note`.

## Apple Pay, Google Pay, Cash App Pay, and gift cards

Checkout already shows a card form. Apple Pay, Google Pay, Cash App Pay, and Square gift card are added with the same Web Payments SDK. Each extra button is created only when the SDK says that method is available, so a browser that cannot use it does not show a dead button. All of them use the same `/api/quote` total, checkout attempt id, stock and made-to-order allocation, and `/api/pay` order as the card.

Apple Pay will not appear until the domain is registered with Square for the same environment you are charging in (sandbox and production are separate).

1. In the [Square Developer Console](https://developer.squareup.com/apps), open the application, switch to Sandbox or Production, and open Apple Pay.
2. Download the domain association file for that environment. The two files are not interchangeable.
3. Put the file body in `APPLE_PAY_DOMAIN_ASSOCIATION_SANDBOX` or `APPLE_PAY_DOMAIN_ASSOCIATION_PRODUCTION` in `wrangler.jsonc` (or `APPLE_PAY_DOMAIN_ASSOCIATION` as a single-environment fallback). The worker serves it, with no redirect, at `/.well-known/apple-developer-merchantid-domain-association`.
4. Register the exact hostname. In the dashboard, add the domain and follow the prompt. Or call RegisterDomain:

   ```bash
   # Sandbox. Use connect.squareup.com and the production token for the live domain.
   curl -X POST https://connect.squareupsandbox.com/v2/apple-pay/domains \
     -H "Authorization: Bearer $SQUARE_ACCESS_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"domain_name":"packmulehouse-website.philip-michael-howard.workers.dev"}'
   ```

   Register the workers.dev hostname and, later, the production hostname. Apple checks that the well-known URL returns the file.

What does not work until that is done, or at all in some places:

- Until the file is configured and the hostname is registered, the SDK rejects Apple Pay and the button stays hidden.
- Apple Pay does not work on `http://localhost` or `http://127.0.0.1`. workers.dev is HTTPS, so the transport is fine once the domain is registered.
- Sandbox Apple Pay does not accept Square’s test card numbers. The Apple Wallet has to contain a real card. Square does not charge that card for a sandbox payment.
- Google Pay and Cash App Pay also stay hidden when the browser or device cannot use them. Cash App Pay’s phone redirect must return to the public HTTPS site. It cannot finish a phone handoff back to `wrangler dev` on `http://127.0.0.1`. A desktop browser can still show the Cash App QR code when the SDK enables it.
- Card and Square gift card sandbox test values still work without any of the wallet setup.
- Cash App Pay loads `https://sandbox.kit.cash.app/v1/pay.js` in sandbox and `https://kit.cash.app/v1/pay.js` in production. The worker Content-Security-Policy allows those script, style, and frame hosts, plus `api.cash.app`, `sandbox.api.cash.app`, `pay.cash.app`, `sandbox.pay.cash.app`, the `cash-f.squarecdn.com` font host, and Cash App’s Amplitude hosts (`api.lab.amplitude.com`, `api.amplitude.com`, `api2.amplitude.com`). Google Pay’s script is `https://pay.google.com/gp/p/js/pay.js`, with button assets from `https://www.gstatic.com`. The policy is only the response header. Pages do not include a meta CSP. HTML is `Cache-Control: no-store` and is not served as 304, so an older policy cannot stay attached to a cached document.
- A declined card comes back as a short sentence (for example “Your card was declined. Try another card or payment method.”). Square’s decline code stays in the worker log.
- Sandbox `receipt_url` values look like `https://squareupsandbox.com/receipt/preview/...` and Square’s own docs say receipts are not generated in sandbox, so that link shows their page-not-found. The site still shows the link. Production stores the `receipt_url` Square returns on the payment, which is the live receipt.

## Policies and lead times

`/shipping`, `/returns`, `/privacy`, `/terms`, and `/contact` are linked from the footer. They are generic small-shop templates with an effective date (`POLICY_EFFECTIVE_DATE`). The pages themselves do not say that. An HTML comment on each page, and this checklist, are the reminder to review them before you treat them as final.

`LEAD_TIME_WEEKS` maps a Square category id or name (or part of the item name) to a number of weeks. The default is `LEAD_TIME_WEEKS_DEFAULT` (1). The shop copy starts as `X-Frame:1, Wind River Canyon:2`. Made-to-order product cards and checkout say “Made to order: ships in about N week(s).” In-stock items are described as shipping within a few business days. Shipping pages and the cart use `__SHIPPING_PHRASE__`, built from `SHIPPING_CENTS`, so the words stay on the charge.

## After the switch

- `SQUARE_ENVIRONMENT=production` on the custom domain is what removes `X-Robots-Tag: noindex` and the `robots.txt` disallow. `*.workers.dev` stays noindex even in production.
- Place a sandbox order before cutting over, then a small live order, and confirm the ntfy / Discord / email alert no longer uses the old topic.
- Card checkout needs the Content-Security-Policy already on the worker (Square Web Payments SDK, Google Fonts, YouTube). If the card form is blank, check the browser console for a CSP report before relaxing the policy.
