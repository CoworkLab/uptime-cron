import express from 'express';
import { config } from './config.js';
import { initSchema, db } from './db.js';
import { ok, fail } from './errors.js';
import { auth, devOnly } from './auth.js';
import { startScheduler, stopScheduler, heartbeatPing } from './scheduler.js';
import jobsRouter from './routes/jobs.js';
import usersRouter from './routes/users.js';
import metaRouter from './routes/meta.js';
import contactsRouter from './routes/contacts.js';
import maintenanceRouter from './routes/maintenance.js';
import statusPagesRouter, { statusPageData, renderStatusHtml } from './routes/statuspages.js';
import { incidentView } from './views.js';
import { jobUptime } from './uptime.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// minimal request log
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    if (req.path === '/healthz') return;
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - t0}ms)`);
  });
  next();
});

// ---------- open routes ----------

app.get('/healthz', (req, res) => {
  ok(res, { ok: true });
});

app.get('/', (req, res) => {
  ok(res, {
    name: 'uptime-cron',
    description: 'cron-job.org style scheduling API with Telegram-scoped multi-user jobs',
    version: config.version,
    docs: 'https://github.com (see README.md in the uptime-cron repo)',
    health: '/healthz',
    api_base: '/v1',
    auth: 'Authorization: Bearer <api_key>',
  });
});

// ---------- authed routes ----------

app.get('/v1/me', auth, async (req, res, next) => {
  try {
    if (req.auth.mode === 'dev') {
      const r = await db.execute({ sql: 'SELECT COUNT(*) AS c FROM jobs', args: [] });
      return ok(res, { key_type: 'dev', telegram_id: null, jobs: { total: Number(r.rows[0].c) } });
    }
    const r = await db.execute({
      sql: 'SELECT COUNT(*) AS c FROM jobs WHERE owner_telegram_id = ?',
      args: [req.auth.user.telegram_id],
    });
    ok(res, {
      key_type: 'user',
      telegram_id: req.auth.user.telegram_id,
      username: req.auth.user.username,
      jobs: { used: Number(r.rows[0].c), limit: config.userJobLimit },
    });
  } catch (e) { next(e); }
});

app.get('/v1/stats', auth, devOnly, async (req, res, next) => {
  try {
    const one = async (sql, args = []) => Number((await db.execute({ sql, args })).rows[0].c || 0);
    const users_total = await one('SELECT COUNT(*) AS c FROM users');
    const jobs_total = await one('SELECT COUNT(*) AS c FROM jobs');
    const jobs_enabled = await one('SELECT COUNT(*) AS c FROM jobs WHERE enabled = 1');
    const runs_total = await one('SELECT COUNT(*) AS c FROM executions');
    const dayAgo = new Date(Date.now() - 86400000).toISOString();
    const runs_24h = await one('SELECT COUNT(*) AS c FROM executions WHERE started_at >= ?', [dayAgo]);
    const failures_24h = await one(`SELECT COUNT(*) AS c FROM executions WHERE started_at >= ? AND status != 'success'`, [dayAgo]);
    ok(res, {
      users_total,
      jobs_total,
      jobs_enabled,
      executions_total: runs_total,
      last_24h: { runs: runs_24h, failures: failures_24h, success_rate: runs_24h ? Math.round(((runs_24h - failures_24h) / runs_24h) * 1000) / 10 : null },
      process_uptime_s: Math.round(process.uptime()),
    });
  } catch (e) { next(e); }
});

app.use('/v1/users', auth, devOnly, usersRouter);
app.use('/v1/jobs', auth, jobsRouter);
app.use('/v1/meta', auth, metaRouter);
app.use('/v1/contacts', auth, contactsRouter);
app.use('/v1/maintenance', auth, maintenanceRouter);
app.use('/v1/status-pages', auth, statusPagesRouter);

// ---------- v1.2.0: public heartbeat endpoint (no auth, rate limited per token) ----------
const hbBuckets = new Map();
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [k, v] of hbBuckets) if (v.resetAt < cutoff) hbBuckets.delete(k);
}, 300000).unref();

app.all('/v1/heartbeat/:token', async (req, res, next) => {
  try {
    const token = String(req.params.token || '');
    const now = Date.now();
    let b = hbBuckets.get(token);
    if (!b || now > b.resetAt) {
      b = { count: 1, resetAt: now + 60000 };
      hbBuckets.set(token, b);
    } else {
      b.count++;
    }
    if (b.count > 60) {
      res.set('Retry-After', '30');
      return fail(res, 429, 'RATE_LIMITED', 'Heartbeat rate limit exceeded (60 pings/minute per token)');
    }
    const r = await db.execute({ sql: `SELECT * FROM jobs WHERE heartbeat_token = ? AND type = 'heartbeat'`, args: [token] });
    if (!r.rows.length) return fail(res, 404, 'NOT_FOUND', 'Unknown heartbeat token');
    const result = await heartbeatPing(r.rows[0]);
    ok(res, { received: true, state: result.state, recovered: result.recovered });
  } catch (e) { next(e); }
});

// ---------- v1.2.0: incidents across the caller's jobs ----------
app.get('/v1/incidents', auth, async (req, res, next) => {
  try {
    const q = req.query || {};
    const where = [];
    const args = [];
    if (req.auth.mode === 'user') {
      where.push('telegram_id = ?');
      args.push(req.auth.user.telegram_id);
    } else if (q.telegram_id) {
      where.push('telegram_id = ?');
      args.push(String(q.telegram_id));
    }
    if (q.job_id) { where.push('job_id = ?'); args.push(String(q.job_id)); }
    if (q.ongoing === 'true') where.push('ended_at IS NULL');
    if (q.ongoing === 'false') where.push('ended_at IS NOT NULL');
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 20, 1), 100);
    const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const totalR = await db.execute({ sql: `SELECT COUNT(*) AS c FROM incidents ${whereSql}`, args });
    const rows = await db.execute({
      sql: `SELECT * FROM incidents ${whereSql} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
      args: [...args, limit, offset],
    });
    ok(res, { incidents: rows.rows.map(incidentView), pagination: { total: Number(totalR.rows[0].c), limit, offset } });
  } catch (e) { next(e); }
});

// ---------- v1.2.0: dashboard ----------
app.get('/v1/dashboard', auth, async (req, res, next) => {
  try {
    const q = req.query || {};
    let whereSql = '';
    const args = [];
    if (req.auth.mode === 'user') {
      whereSql = 'WHERE owner_telegram_id = ?';
      args.push(req.auth.user.telegram_id);
    } else if (q.telegram_id) {
      whereSql = 'WHERE owner_telegram_id = ?';
      args.push(String(q.telegram_id));
    }
    const jobs = (await db.execute({ sql: `SELECT * FROM jobs ${whereSql} LIMIT 100`, args })).rows;
    const counts = { total: jobs.length, up: 0, down: 0, paused: 0, pending: 0 };
    for (const j of jobs) {
      if (!Number(j.enabled)) counts.paused++;
      else counts[j.state || 'pending'] = (counts[j.state || 'pending'] || 0) + 1;
    }
    const incArgs = req.auth.mode === 'user' ? [req.auth.user.telegram_id] : (q.telegram_id ? [String(q.telegram_id)] : null);
    const ongoing = incArgs
      ? Number((await db.execute({ sql: 'SELECT COUNT(*) AS c FROM incidents WHERE telegram_id = ? AND ended_at IS NULL', args: incArgs })).rows[0].c)
      : Number((await db.execute({ sql: 'SELECT COUNT(*) AS c FROM incidents WHERE ended_at IS NULL', args: [] })).rows[0].c);

    let upSum = 0;
    let upN = 0;
    let durSum = 0;
    let durN = 0;
    const dayAgo = new Date(Date.now() - 86400000).toISOString();
    for (const j of jobs) {
      if (!Number(j.enabled)) continue;
      const u = await jobUptime(j, 86400);
      if (u.uptime_percent != null) { upSum += u.uptime_percent; upN++; }
      const d = await db.execute({ sql: 'SELECT duration_ms FROM executions WHERE job_id = ? AND started_at >= ? AND duration_ms IS NOT NULL LIMIT 200', args: [j.id, dayAgo] });
      for (const r of d.rows) { durSum += Number(r.duration_ms); durN++; }
    }
    ok(res, {
      jobs: counts,
      ongoing_incidents: ongoing,
      uptime_24h_percent: upN ? Math.round((upSum / upN) * 10) / 10 : null,
      avg_response_ms: durN ? Math.round(durSum / durN) : null,
    });
  } catch (e) { next(e); }
});

// ---------- v1.2.0: public status pages ----------
app.get('/status/:slug/json', async (req, res, next) => {
  try {
    const r = await db.execute({ sql: 'SELECT * FROM status_pages WHERE slug = ? AND enabled = 1', args: [String(req.params.slug || '').toLowerCase()] });
    if (!r.rows.length) return fail(res, 404, 'STATUS_PAGE_NOT_FOUND', 'Status page not found');
    const data = await statusPageData(r.rows[0]);
    res.set('Cache-Control', 'public, max-age=30');
    ok(res, data);
  } catch (e) { next(e); }
});

app.get('/status/:slug', async (req, res, next) => {
  try {
    const r = await db.execute({ sql: 'SELECT * FROM status_pages WHERE slug = ? AND enabled = 1', args: [String(req.params.slug || '').toLowerCase()] });
    if (!r.rows.length) {
      res.status(404).set('Content-Type', 'text/html; charset=utf-8');
      return res.send('<!doctype html><meta charset="utf-8"><title>Not found</title><body style="font-family:sans-serif;background:#0d1117;color:#e6edf3;display:grid;place-items:center;height:100vh;margin:0"><div><h1>404</h1><p>Status page not found.</p></div>');
    }
    const data = await statusPageData(r.rows[0]);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=30');
    res.send(renderStatusHtml(data));
  } catch (e) { next(e); }
});

// folders across the caller's jobs (dev: all, or ?telegram_id= filter)
app.get('/v1/folders', auth, async (req, res, next) => {
  try {
    const q = req.query || {};
    const where = ["folder IS NOT NULL", "folder != ''"];
    const args = [];
    if (req.auth.mode === 'user') {
      where.push('owner_telegram_id = ?');
      args.push(req.auth.user.telegram_id);
    } else if (q.telegram_id) {
      where.push('owner_telegram_id = ?');
      args.push(String(q.telegram_id));
    }
    const r = await db.execute({
      sql: `SELECT folder AS name, COUNT(*) AS job_count FROM jobs WHERE ${where.join(' AND ')} GROUP BY folder ORDER BY name ASC`,
      args,
    });
    ok(res, { folders: r.rows.map((row) => ({ name: row.name, job_count: Number(row.job_count) })) });
  } catch (e) { next(e); }
});

// ---------- clean 404 + error handling ----------

app.use((req, res) => {
  fail(res, 404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`);
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.code && err.status) {
    return fail(res, err.status, err.code, err.message);
  }
  if (err?.type === 'entity.too.large') {
    return fail(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body too large (max 256 KB)');
  }
  if (err?.type === 'entity.parse.failed') {
    return fail(res, 400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
  console.error('[error]', err);
  fail(res, 500, 'INTERNAL_ERROR', 'Something went wrong on our side');
});

// ---------- boot ----------

async function boot() {
  if (!config.tursoUrl) {
    console.error('FATAL: TURSO_DATABASE_URL is not set');
    process.exit(1);
  }
  if (!config.devKey) {
    console.error('FATAL: DEV_API_KEY is not set');
    process.exit(1);
  }
  await initSchema();
  console.log(`[db] connected to Turso (${config.tursoUrl.split('@')[1] || config.tursoUrl})`);
  startScheduler();

  const server = app.listen(config.port, () => {
    console.log(`[uptime-cron] v${config.version} listening on port ${config.port}`);
  });

  const shutdown = async () => {
    console.log('[uptime-cron] shutting down...');
    stopScheduler();
    try { server.close(); } catch {}
    try { db.close(); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

boot().catch((e) => {
  console.error('FATAL boot error:', e);
  process.exit(1);
});
