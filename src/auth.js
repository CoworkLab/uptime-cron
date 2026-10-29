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

export async function auth(req, res, next) {
  try {
    const key = extractKey(req);
    if (!key) throw err.unauthorized();

    if (!rateLimit(key)) {
      res.set('Retry-After', '30');
      return fail(res, 429, 'RATE_LIMITED', `Rate limit exceeded (${config.rateLimitPerMin} requests/minute). Retry shortly`);
    }

    if (config.devKey && key === config.devKey) {
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
    return fail(res, 403, 'FORBIDDEN', 'This endpoint requires the dev API key');
  }
  next();
}
