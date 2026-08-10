# Pack Mule House Website

Static marketing site for **X-Frame** by Pack Mule House. Hosted on **Cloudflare Workers** (static assets).

## Local development

```bash
npm install
npm run dev
```

Opens a local preview (usually `http://localhost:8787`).

## Deploy to Cloudflare

```bash
# One-time: log in (opens browser / prints auth URL)
npx wrangler login

# Deploy
npm run deploy
```

Your site will be available at something like:

`https://packmulehouse-website.<your-subdomain>.workers.dev`

You can later attach a custom domain in the [Cloudflare dashboard](https://dash.cloudflare.com/) under **Workers & Pages** → this project → **Settings** → **Domains & Routes**.

## Day-to-day workflow (this server)

1. Edit files in this folder (e.g. `index.html`)
2. Preview: `npm run dev`
3. Commit: `git add -A && git commit -m "your message"`
4. Push: `git push`
5. Deploy: `npm run deploy`

If you connect the GitHub repo to Cloudflare Builds, push alone can trigger deploys automatically.

## Project layout

| Path | Purpose |
|------|---------|
| `public/index.html` | Full site (HTML + CSS + JS) |
| `public/logo.png` | Brand logo |
| `wrangler.jsonc` | Cloudflare Workers deploy config |
| `package.json` | Scripts + wrangler dependency |

Edit files under `public/`. Deploy only publishes that folder.
