// Handles POST /api/quote from the Contact page. Every other path is served
// straight from ./public by the assets layer (see run_worker_first in
// wrangler.jsonc), so this Worker only ever sees /api/* requests.
//
// Flow: origin check -> parse + validate -> honeypot/timing -> rate limits
// -> save to D1 -> notify by email -> respond.
// The request is saved before the email is attempted, so a delivery failure
// never loses a lead.

const NOTIFY_TO = 'justin.barnes@onirudesign.com';
const NOTIFY_FROM_EMAIL = 'quotes@onirudesign.com';
const NOTIFY_FROM_NAME = 'Oniru website';

const ALLOWED_ORIGINS = new Set([
  'https://onirudesign.com',
  'https://www.onirudesign.com',
  'https://clowder-site.lordcoder1990.workers.dev',
]);

const DIVISIONS = new Set(['Apps', '3D Printing', 'PCB Boards', 'Other']);

const MAX_BODY_BYTES = 16 * 1024;
const MIN_FILL_MS = 3000;          // faster than this is a script, not a person
const PER_IP_PER_MINUTE = 3;
const PER_IP_PER_DAY = 10;
const SITE_WIDE_PER_DAY = 100;     // protects the email quota if many IPs flood us

const FALLBACK_ERROR =
  'We could not send your request. Please email justin.barnes@onirudesign.com or call (717) 459-7843.';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/quote') {
      if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405, { Allow: 'POST' });
      try {
        return await handleQuote(request, env);
      } catch (err) {
        console.error('quote handler crashed', err && err.stack ? err.stack : err);
        return json({ ok: false, error: FALLBACK_ERROR }, 500);
      }
    }
    if (url.pathname.startsWith('/api/')) return json({ ok: false, error: 'Not found.' }, 404);
    return env.ASSETS.fetch(request);
  },
};

async function handleQuote(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return json({ ok: false, error: 'Forbidden.' }, 403);

  if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) {
    return json({ ok: false, error: 'Unsupported content type.' }, 415);
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ ok: false, error: 'Your message is too long.' }, 413);

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: 'Invalid request.' }, 400);
  }
  if (!body || typeof body !== 'object') return json({ ok: false, error: 'Invalid request.' }, 400);

  // Bots fill every field and submit instantly. Pretend success so they learn nothing.
  const website = str(body.website);
  const elapsed = Number(body.elapsedMs);
  if (website || !Number.isFinite(elapsed) || elapsed < MIN_FILL_MS) {
    console.log('quote dropped as spam', { website: !!website, elapsed });
    return json({ ok: true });
  }

  const name = oneLine(str(body.name));
  const email = str(body.email).toLowerCase();
  const division = str(body.division);
  const details = str(body.details).replace(/\r\n?/g, '\n');

  if (name.length < 1 || name.length > 100) return json({ ok: false, error: 'Please enter your name (100 characters max).' }, 400);
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ ok: false, error: 'Please enter a valid email address.' }, 400);
  if (!DIVISIONS.has(division)) return json({ ok: false, error: 'Please choose what this is about.' }, 400);
  if (details.length < 10 || details.length > 5000) return json({ ok: false, error: 'Please describe your project in 10 to 5,000 characters.' }, 400);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipHash = await sha256(`${env.IP_HASH_SALT || 'oniru-quotes'}:${ip}`);

  // Fast first line: Workers Rate Limiting binding. Its counters are kept per
  // Cloudflare location and are only approximate, so the exact checks below
  // are the real enforcement.
  if (env.QUOTE_BURST) {
    const { success } = await env.QUOTE_BURST.limit({ key: ipHash });
    if (!success) return tooMany('Too many requests. Please wait a minute and try again.');
  }

  // Exact limits counted from the saved requests themselves.
  const counts = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN ip_hash = ?1 AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 seconds') THEN 1 ELSE 0 END) AS mine_minute,
       SUM(CASE WHEN ip_hash = ?1 THEN 1 ELSE 0 END) AS mine,
       COUNT(*) AS everyone
     FROM quotes
     WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')`,
  ).bind(ipHash).first();
  if ((counts?.mine_minute || 0) >= PER_IP_PER_MINUTE) return tooMany('Too many requests. Please wait a minute and try again.');
  if ((counts?.mine || 0) >= PER_IP_PER_DAY) return tooMany('You have sent several requests today. Please email us directly instead.', 3600);
  if ((counts?.everyone || 0) >= SITE_WIDE_PER_DAY) return tooMany(FALLBACK_ERROR, 3600);

  const userAgent = (request.headers.get('User-Agent') || '').slice(0, 300);
  const saved = await env.DB.prepare(
    `INSERT INTO quotes (name, email, division, details, ip_hash, user_agent) VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id, created_at`,
  ).bind(name, email, division, details, ipHash, userAgent).first();

  const quote = { id: saved.id, createdAt: saved.created_at, name, email, division, details };
  const result = await notify(env, quote);

  await env.DB.prepare(`UPDATE quotes SET email_status = ?1, email_error = ?2 WHERE id = ?3`)
    .bind(result.status, result.error || null, quote.id).run();

  if (result.status === 'sent') return json({ ok: true });

  console.error('quote saved but not emailed', { id: quote.id, status: result.status, error: result.error });
  return json({ ok: false, error: FALLBACK_ERROR }, 502);
}

// Sends the notification with whichever provider is configured:
// 1. Cloudflare Email Service, via the send_email binding named EMAIL, or
// 2. Resend, via the RESEND_API_KEY secret.
async function notify(env, q) {
  const subject = `New quote request: ${q.division} from ${q.name}`.slice(0, 200);
  const text = [
    `Quote request #${q.id}`,
    `Received: ${q.createdAt}`,
    '',
    `Name:     ${q.name}`,
    `Email:    ${q.email}`,
    `About:    ${q.division}`,
    '',
    'Project details:',
    q.details,
    '',
    '--',
    'Sent from the contact form on onirudesign.com. Reply to this email to answer the customer directly.',
  ].join('\n');

  try {
    if (env.EMAIL) {
      await env.EMAIL.send({
        to: NOTIFY_TO,
        from: { email: NOTIFY_FROM_EMAIL, name: NOTIFY_FROM_NAME },
        replyTo: q.email,
        subject,
        text,
      });
      return { status: 'sent' };
    }
    if (env.RESEND_API_KEY) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: `${NOTIFY_FROM_NAME} <${NOTIFY_FROM_EMAIL}>`,
          to: [NOTIFY_TO],
          reply_to: q.email,
          subject,
          text,
        }),
      });
      if (!res.ok) return { status: 'failed', error: `Resend ${res.status}: ${(await res.text()).slice(0, 300)}` };
      return { status: 'sent' };
    }
    return { status: 'not_configured', error: 'No email provider is configured.' };
  } catch (err) {
    return { status: 'failed', error: String((err && (err.code || err.message)) || err).slice(0, 300) };
  }
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// Collapses whitespace so a name can never inject extra lines into a subject.
function oneLine(s) {
  return s.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ');
}

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function tooMany(message, retryAfter = 60) {
  return json({ ok: false, error: message }, 429, { 'Retry-After': String(retryAfter) });
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });
}
