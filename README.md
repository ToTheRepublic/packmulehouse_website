# Pack Mule House Website

Marketing + shop site for **X-Frame** by Pack Mule House. Hosted on **Cloudflare Workers** with embedded **Square** checkout (sandbox for now).

Live temp URL: https://packmulehouse-website.philip-michael-howard.workers.dev

## Features

- Static storefront (`public/`)
- Products & prices loaded live from **Square Catalog** (`GET /api/catalog`)
- On-page checkout with **Square Web Payments SDK** (no redirect)
- Charges via Worker → Square Payments API (`POST /api/pay`) — server looks up price so clients can't spoof amounts

## Local development

```bash
npm install
# Local secrets (gitignored). See the secrets table below.
# printf '%s\n' 'SQUARE_ACCESS_TOKEN=...' 'ADMIN_PASSWORD=...' 'ADMIN_SESSION_SECRET=...' > .dev.vars
npm test
npm run dev
```

Opens a local preview (usually `http://localhost:8787`).

## Deploy to Cloudflare

```bash
export CLOUDFLARE_API_TOKEN=...   # or use token file + shell hook
# First time only — secret for Square API
printf '%s' "$SQUARE_ACCESS_TOKEN" | npx wrangler secret put SQUARE_ACCESS_TOKEN
npm run deploy
```

Public Square settings live in `wrangler.jsonc` → `vars` (`SQUARE_APPLICATION_ID`, `SQUARE_LOCATION_ID`, `SQUARE_ENVIRONMENT`).

See `docs/GO_LIVE.md` before switching the shop to production.

## Secrets

Set these with `npx wrangler secret put <NAME>` (or `.dev.vars` locally). Do not put them in `wrangler.jsonc`.

| Secret | Required | Purpose |
|--------|----------|---------|
| `SQUARE_ACCESS_TOKEN` | yes | Square Catalog, Orders, and Payments API |
| `ADMIN_PASSWORD` | yes | Admin console password |
| `ADMIN_SESSION_SECRET` | yes | Signs admin session tokens. Rotate this to sign every admin out without changing the password. |
| `NTFY_TOPIC` | for phone alerts | Private ntfy topic. There is no default. The old public topic was removed because order alerts include customer name, address, email, and phone. Create a new topic; the previous one is in git history and should be treated as compromised. |
| `NTFY_TOKEN` | no | Bearer token if the ntfy topic is access-protected |
| `DISCORD_WEBHOOK_URL` | no | Discord order alert |
| `RESEND_API_KEY` | no | Email order alert. Also set `EMAIL_FROM` in `wrangler.jsonc`. |
| `TELEGRAM_BOT_TOKEN` | no | Telegram alert (with `TELEGRAM_CHAT_ID`) |
| `TELEGRAM_CHAT_ID` | no | Telegram chat id |

`NTFY_SERVER` defaults to `https://ntfy.sh` and can be overridden with a var. `SITE_ORIGIN` and `EMAIL_FROM` are vars, not secrets.

## Day-to-day workflow (this server)

1. Edit files under `public/` (or `src/worker.js` for API)
2. Preview: `npm run dev`
3. Commit / push: `git add -A && git commit -m "..." && git push`
4. Deploy: `npm run deploy`

## Sandbox test card

While `SQUARE_ENVIRONMENT` is `sandbox`:

| Field | Value |
|-------|--------|
| Card | `4111 1111 1111 1111` |
| Exp | Any future date |
| CVV | `111` |
| Postal | `12345` |

No real money is charged in sandbox.

## Updating products / prices

Edit items in the **Square Sandbox** seller dashboard / Catalog. The site reloads prices from the Catalog API (short cache). When you go live, switch `vars` to production Application ID + Location ID, set a production access token secret, and set `SQUARE_ENVIRONMENT` to `production`.

## Project layout

| Path | Purpose |
|------|---------|
| `public/index.html` | Storefront UI |
| `public/checkout.js` | Catalog UI + Square card form |
| `brand/logo-source.png` | Original logo (not served) |
| `public/logo-*.webp` | Display logos |
| `docs/GO_LIVE.md` | Production switch checklist |
| `src/worker.js` | Catalog + payment API |
| `wrangler.jsonc` | Cloudflare + Square public config |
| `.dev.vars` | Local secrets only (not committed) |
