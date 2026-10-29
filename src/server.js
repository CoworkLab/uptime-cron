import express from 'express';
import { config } from './config.js';
import { initSchema, db } from './db.js';
import { ok, fail } from './errors.js';
import { auth, devOnly } from './auth.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import jobsRouter from './routes/jobs.js';
import usersRouter from './routes/users.js';
import metaRouter from './routes/meta.js';

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
