# Going live

Sandbox stays the default until every line below is done. Do not change `TAX_PERCENT` or the tax calculation as part of the switch.

## Square

1. Create a **production** Square application and copy its application id into `SQUARE_APPLICATION_ID`.
2. Copy the production location id into `SQUARE_LOCATION_ID`.
3. Set `SQUARE_ENVIRONMENT` to `production`.
4. Replace the access token secret with the production token:

   ```bash
   printf '%s' "$SQUARE_ACCESS_TOKEN" | npx wrangler secret put SQUARE_ACCESS_TOKEN
   ```

5. In the Square Dashboard, confirm the items you sell on the site are in one category (or note their item ids).

## Catalog filter

Production Square has items that are not X-Frame kits. With the filter unset, the site lists the whole catalog.

Set one of these vars (comma-separated). Leave both unset only in sandbox.

- `SQUARE_CATEGORY_ID` — category id from the catalog (matches `category_id`, `categories[].id`, or reporting category)
- `SQUARE_ITEM_IDS` — catalog item ids to allow

An item is shown when it matches either list. Checkout rejects anything outside the filter, not only the storefront.

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

## After the switch

- `SQUARE_ENVIRONMENT=production` on the custom domain is what removes `X-Robots-Tag: noindex` and the `robots.txt` disallow. `*.workers.dev` stays noindex even in production.
- Place a sandbox order before cutting over, then a small live order, and confirm the ntfy / Discord / email alert no longer uses the old topic.
- Card checkout needs the Content-Security-Policy already on the worker (Square Web Payments SDK, Google Fonts, YouTube). If the card form is blank, check the browser console for a CSP report before relaxing the policy.
