# Clowder / Oniru site

Static single-page site (`index.html` + Cloudflare `_headers`).

Deployed to Cloudflare Pages. Build command: none. Output directory: `/` (repo root).

## Deploy

Hosted on Cloudflare (Workers static assets, created via `wrangler pages project create`).
Live URL: https://clowder-site.lordcoder1990.workers.dev

To redeploy after changes:

    npx wrangler deploy
