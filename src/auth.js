import crypto from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';
import { err, fail } from './errors.js';

// ---- simple in-memory rate limiter (per API key) ----
const buckets = new Map();

function rateLimit(key) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + 60000 });
    return true;
  }
  b.count++;
  return b.count <= config.rateLimitPerMin;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) {
    if (now > v.resetAt) buckets.delete(k);
  }
}, 300000).unref();

export function extractKey(req) {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  const x = req.headers['x-api-key'];
  return x ? String(x).trim() : null;
}

// constant-time comparison via sha256 digests (length-independent)
function isBotToken(presented) {
  if (!config.telegramBotToken) return false;
  const a = crypto.createHash('sha256').update(String(presented)).digest();
  const b = crypto.createHash('sha256').update(config.telegramBotToken).digest();
  return crypto.timingSafeEqual(a, b);
}

export async function auth(req, res, next) {
  try {
    const key = extractKey(req);
    if (!key) throw err.unauthorized();

    if (!rateLimit(key)) {
      res.set('Retry-After', '30');
      return fail(res, 429, 'RATE_LIMITED', `Rate limit exceeded (${config.rateLimitPerMin} requests/minute). Retry shortly`);
    }

    // Bot token = developer credential (bot owner == bot developer). Since v1.3.0 there is
    // no separate uc_dev_ API key — presenting the server's own TELEGRAM_BOT_TOKEN grants
    // full developer access.
    if (isBotToken(key)) {
      req.auth = { mode: 'dev', key };
      return next();
    }

    const r = await db.execute({ sql: 'SELECT * FROM users WHERE api_key = ?', args: [key] });
    if (!r.rows.length) throw err.unauthorized('Invalid API key');
    const row = r.rows[0];
    req.auth = {
      mode: 'user',
      key,
      user: {
        telegram_id: row.telegram_id,
        username: row.username,
        api_key: row.api_key,
      },
    };
    return next();
  } catch (e) {
    if (e && e.code === 'UNAUTHORIZED') return fail(res, e.status, e.code, e.message);
    next(e);
  }
}

export function devOnly(req, res, next) {
  if (req.auth?.mode !== 'dev') {
    return fail(res, 403, 'FORBIDDEN', 'This endpoint requires the bot token (bot developer only)');
  }
  next();
}
