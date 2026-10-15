# Clowder / Oniru site

Static single-page site. The deployed files live in `public/` (`index.html` + Cloudflare `_headers`).

Deployed to Cloudflare Pages. Build command: none. Output directory: `public/`.

## Deploy

Hosted on Cloudflare (Workers static assets, created via `wrangler pages project create`).
Live URLs: https://onirudesign.com, https://www.onirudesign.com, https://clowder-site.lordcoder1990.workers.dev

To redeploy after changes:

    npx wrangler deploy

## Quote form

The Contact page form posts to `POST /api/quote`, handled by `src/worker.js`.
Static files in `public/` are served directly; only `/api/*` runs the Worker.

- Every request is saved to the D1 database `clowder-quotes` before any email is attempted.
- Spam protection: same-site Origin check, hidden honeypot field, and a minimum fill time.
- Rate limits: 3 per minute and 10 per day per visitor, and 100 per day site-wide.
- Notification email goes to justin.barnes@onirudesign.com, through Cloudflare Email Service
  (`send_email` binding named `EMAIL`) or Resend (`RESEND_API_KEY` secret), whichever is set.

List recent requests:

    npx wrangler d1 execute clowder-quotes --remote --command "SELECT id, created_at, name, email, division, email_status FROM quotes ORDER BY id DESC LIMIT 20"

Schema changes go in `migrations/`, applied with `npx wrangler d1 migrations apply clowder-quotes --remote`.
