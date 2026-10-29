import { Router } from 'express';
import { db, isoNow } from '../db.js';
import { config } from '../config.js';
import { err, ok, asyncH } from '../errors.js';
import { genId, genApiKey } from '../ids.js';
import { parseSchedule, computeNextRun, nextRuns, isValidTimezone } from '../cron.js';
import {
  vString, vUrl, vOptionalUrl, vMethod, vInt, vBool, vHeaders, vBody, vTags, vExpiresAt, vTelegramId,
} from '../validate.js';
import { parseCurlCommand } from '../curl.js';
import { jobView, executionView, lastExecutionSummary } from '../views.js';
import { dispatchManual } from '../scheduler.js';

const router = Router();

const SORTABLE = {
  next_run_at: 'next_run_at',
  created_at: 'created_at',
  last_run_at: 'last_run_at',
  run_count: 'run_count',
  title: 'title',
};

// ---------- helpers ----------

async function ensureUser(telegram_id, username) {
  const found = await db.execute({ sql: 'SELECT * FROM users WHERE telegram_id = ?', args: [telegram_id] });
  if (found.rows.length) return found.rows[0];
  const now = isoNow();
  await db.execute({
    sql: `INSERT INTO users (telegram_id, username, api_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    args: [telegram_id, username || null, genApiKey(), now, now],
  });
  const created = await db.execute({ sql: 'SELECT * FROM users WHERE telegram_id = ?', args: [telegram_id] });
  return created.rows[0];
}

async function getJobScoped(req, id) {
  const r = await db.execute({ sql: 'SELECT * FROM jobs WHERE id = ?', args: [id] });
  if (!r.rows.length) throw err.jobNotFound();
  const job = r.rows[0];
  if (req.auth.mode === 'user' && job.owner_telegram_id !== req.auth.user.telegram_id) {
    throw err.jobNotFound(); // do not reveal existence
  }
  return job;
}

function buildJobFields(body) {
  const url = vUrl(body.url);
  const method = vMethod(body.method);
  const headers = vHeaders(body.headers);
  const b = vBody(body.body, method);
  const timeout = vInt(body.timeout, 'timeout', { min: 5, max: 60, def: 30 });
  const maxRetries = vInt(body.max_retries, 'max_retries', { min: 0, max: 3, def: 0 });
  const retryInterval = vInt(body.retry_interval, 'retry_interval', { min: 30, max: 3600, def: 60 });
  const failureWebhook = vOptionalUrl(body.failure_webhook, 'failure_webhook');
  const saveResponses = vBool(body.save_responses, true);
  const tags = vTags(body.tags);
  const title = vString(body.title, 'title', { max: 120 });
  const expiresAt = vExpiresAt(body.expires_at);
  const schedule = parseSchedule(body.schedule, config.defaultTimezone);
  const enabled = vBool(body.enabled, true);

  return { url, method, headers, body: b, timeout, maxRetries, retryInterval, failureWebhook, saveResponses, tags, title, expiresAt, schedule, enabled };
}

// ---------- create ----------

async function createJobCore(req, res, body) {
  let telegram_id;
  if (req.auth.mode === 'dev') {
    telegram_id = vTelegramId(body.telegram_id);
  } else {
    if (body.telegram_id && body.telegram_id !== req.auth.user.telegram_id) {
      throw err.forbidden('You cannot create jobs for another user');
    }
    telegram_id = req.auth.user.telegram_id;
  }

  await ensureUser(telegram_id, body.username);

  const countR = await db.execute({ sql: 'SELECT COUNT(*) AS c FROM jobs WHERE owner_telegram_id = ?', args: [telegram_id] });
  const used = Number(countR.rows[0].c);
  if (req.auth.mode !== 'dev' && used >= config.userJobLimit) throw err.quotaExceeded(config.userJobLimit);

  const f = buildJobFields(body);
  const id = genId('job_');
  const now = isoNow();
  const nextRun = f.enabled ? computeNextRun(f.schedule).getTime() : null;

  await db.execute({
    sql: `INSERT INTO jobs (id, owner_telegram_id, title, url, method, headers, body, timeout,
            schedule_kind, schedule_cron, schedule_input, interval_seconds, timezone,
            enabled, expires_at, next_run_at, max_retries, retry_interval, failure_webhook, save_responses, tags, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id, telegram_id, f.title, f.url, f.method, JSON.stringify(f.headers), f.body, f.timeout,
      f.schedule.kind, f.schedule.cron, f.schedule.input, f.schedule.interval_seconds, f.schedule.timezone,
      f.enabled ? 1 : 0, f.expiresAt, nextRun, f.maxRetries, f.retryInterval, f.failureWebhook,
      f.saveResponses ? 1 : 0, JSON.stringify(f.tags), now, now,
    ],
  });

  const row = await db.execute({ sql: 'SELECT * FROM jobs WHERE id = ?', args: [id] });
  ok(res, { job: jobView(row.rows[0]) }, 201);
}

router.post('/', asyncH(async (req, res) => createJobCore(req, res, req.body || {})));

// ---------- curl import ----------

router.post('/import/curl', asyncH(async (req, res) => {
  const body = req.body || {};
  const parsed = parseCurlCommand(body.curl);

  const draft = {
    title: vString(body.title, 'title', { max: 120 }) || 'Imported from curl',
    url: parsed.url,
    method: vMethod(parsed.method),
    headers: vHeaders(parsed.headers),
    body: vBody(parsed.body, ['POST', 'PUT', 'PATCH', 'DELETE'].includes(parsed.method) ? parsed.method : 'POST'),
  };
  if (draft.method === 'GET' && draft.body) draft.method = 'POST';

  if (!body.create) {
    return ok(res, { parsed: draft, note: 'Set "create": true and provide "schedule" to create the job directly' });
  }

  // create mode — reuse the create pipeline
  return createJobCore(req, res, { ...body, ...draft, schedule: body.schedule });
}));

// ---------- bulk ----------

router.post('/bulk', asyncH(async (req, res) => {
  const body = req.body || {};
  const action = body.action;
  if (!['pause', 'resume', 'delete', 'run'].includes(action)) {
    throw err.validation('action must be one of: pause, resume, delete, run');
  }
  if (!Array.isArray(body.job_ids) || !body.job_ids.length) {
    throw err.validation('job_ids must be a non-empty array of job ids');
  }
  if (body.job_ids.length > 100) throw err.validation('job_ids supports at most 100 entries');

  let affected = 0;
  let skipped = 0;
  for (const rawId of body.job_ids) {
    const id = String(rawId || '');
    const found = await db.execute({ sql: 'SELECT * FROM jobs WHERE id = ?', args: [id] });
    if (!found.rows.length) { skipped++; continue; }
    const job = found.rows[0];
    if (req.auth.mode === 'user' && job.owner_telegram_id !== req.auth.user.telegram_id) { skipped++; continue; }
    const j = rowToJobLite(job);

    if (action === 'pause') {
      await db.execute({ sql: `UPDATE jobs SET enabled = 0, next_run_at = NULL, updated_at = ? WHERE id = ?`, args: [isoNow(), id] });
    } else if (action === 'resume') {
      const next = computeNextRun({ kind: j.schedule_kind, cron: j.schedule_cron, interval_seconds: j.interval_seconds, timezone: j.timezone });
      await db.execute({ sql: `UPDATE jobs SET enabled = 1, next_run_at = ?, updated_at = ? WHERE id = ?`, args: [next.getTime(), isoNow(), id] });
    } else if (action === 'delete') {
      await db.execute({ sql: `DELETE FROM executions WHERE job_id = ?`, args: [id] });
      await db.execute({ sql: `DELETE FROM jobs WHERE id = ?`, args: [id] });
    } else if (action === 'run') {
      dispatchManual(j);
    }
    affected++;
  }
  ok(res, { action, requested: body.job_ids.length, affected, skipped });
}));

// ---------- list ----------

router.get('/', asyncH(async (req, res) => {
  const q = req.query || {};
  const where = [];
  const args = [];

  if (req.auth.mode === 'user') {
    where.push('owner_telegram_id = ?');
    args.push(req.auth.user.telegram_id);
  } else if (q.telegram_id) {
    where.push('owner_telegram_id = ?');
    args.push(String(q.telegram_id));
  }

  if (q.search) {
    where.push('(title LIKE ? OR url LIKE ?)');
    const like = `%${String(q.search)}%`;
    args.push(like, like);
  }
  if (q.enabled === 'true' || q.enabled === 'false') {
    where.push('enabled = ?');
    args.push(q.enabled === 'true' ? 1 : 0);
  }
  if (q.status) {
    where.push('last_status = ?');
    args.push(String(q.status));
  }
  if (q.tag) {
    where.push('tags LIKE ?');
    args.push(`%"${String(q.tag)}"%`);
  }

  const sortCol = SORTABLE[q.sort] || 'created_at';
  const order = String(q.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(Math.max(vInt(q.limit, 'limit', { min: 1, max: 100, def: 20 }), 1), 100);
  const offset = Math.max(vInt(q.offset, 'offset', { min: 0, max: 100000, def: 0 }), 0);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const totalR = await db.execute({ sql: `SELECT COUNT(*) AS c FROM jobs ${whereSql}`, args });
  const rows = await db.execute({
    sql: `SELECT * FROM jobs ${whereSql} ORDER BY ${sortCol} ${order} LIMIT ? OFFSET ?`,
    args: [...args, limit, offset],
  });

  ok(res, {
    jobs: rows.rows.map(jobView),
    pagination: { total: Number(totalR.rows[0].c), limit, offset },
  });
}));

// ---------- single job ----------

router.get('/:id', asyncH(async (req, res) => {
  const job = await getJobScoped(req, req.params.id);
  const last = await db.execute({
    sql: 'SELECT * FROM executions WHERE job_id = ? ORDER BY started_at DESC, created_at DESC LIMIT 1',
    args: [job.id],
  });
  ok(res, { job: jobView(job), last_execution: lastExecutionSummary(last.rows[0]) });
}));

async function updateJob(req, res, requireCore) {
  const body = req.body || {};
  const job = await getJobScoped(req, req.params.id);

  const patch = {};

  if (body.title !== undefined) patch.title = vString(body.title, 'title', { max: 120 });
  if (body.url !== undefined) patch.url = vUrl(body.url);
  else if (requireCore) throw err.validation('url is required');
  if (body.method !== undefined) patch.method = vMethod(body.method);
  if (body.headers !== undefined) patch.headers = vHeaders(body.headers);
  if (body.body !== undefined) patch.body = vBody(body.body, body.method !== undefined ? vMethod(body.method) : job.method);
  if (body.timeout !== undefined) patch.timeout = vInt(body.timeout, 'timeout', { min: 5, max: 60, def: 30 });
  if (body.max_retries !== undefined) patch.max_retries = vInt(body.max_retries, 'max_retries', { min: 0, max: 3, def: 0 });
  if (body.retry_interval !== undefined) patch.retry_interval = vInt(body.retry_interval, 'retry_interval', { min: 30, max: 3600, def: 60 });
  if (body.failure_webhook !== undefined) patch.failure_webhook = vOptionalUrl(body.failure_webhook, 'failure_webhook');
  if (body.save_responses !== undefined) patch.save_responses = vBool(body.save_responses, true);
  if (body.tags !== undefined) patch.tags = vTags(body.tags);
  if (body.expires_at !== undefined) patch.expires_at = vExpiresAt(body.expires_at);

  // schedule/timezone revalidation
  let schedule = { kind: job.schedule_kind, cron: job.schedule_cron, interval_seconds: job.interval_seconds != null ? Number(job.interval_seconds) : null, timezone: job.timezone, input: job.schedule_input };
  let scheduleChanged = false;

  if (body.timezone !== undefined) {
    if (!isValidTimezone(body.timezone)) throw err.validation(`Unknown timezone: "${body.timezone}" (use an IANA timezone like Asia/Kolkata)`);
  }

  if (body.schedule !== undefined) {
    schedule = parseSchedule(body.schedule, config.defaultTimezone);
    if (body.timezone !== undefined) schedule.timezone = body.timezone;
    scheduleChanged = true;
  } else if (body.timezone !== undefined && body.timezone !== job.timezone) {
    // re-parse the stored schedule input under the new timezone
    let stored = job.schedule_input;
    try { stored = JSON.parse(stored); } catch {}
    schedule = parseSchedule(stored, body.timezone);
    scheduleChanged = true;
  }

  const enabled = body.enabled !== undefined ? vBool(body.enabled, true) : !!Number(job.enabled);
  const method = patch.method || job.method;
  if (patch.body !== undefined && patch.body && !['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    throw err.validation(`body is not allowed for ${method}`);
  }

  const now = isoNow();
  const sets = [];
  const args = [];
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'headers' || k === 'tags') { sets.push(`${k} = ?`); args.push(JSON.stringify(v)); }
    else if (k === 'save_responses') { sets.push(`${k} = ?`); args.push(v ? 1 : 0); }
    else { sets.push(`${k} = ?`); args.push(v); }
  }

  let nextRun = job.next_run_at != null ? Number(job.next_run_at) : null;
  if (!enabled) {
    nextRun = null;
  } else if (scheduleChanged || body.enabled === true || !nextRun) {
    nextRun = computeNextRun(schedule).getTime();
  }

  const finalSets = [...sets, 'enabled = ?', 'next_run_at = ?', 'updated_at = ?'];
  const finalArgs = [...args, enabled ? 1 : 0, nextRun, now, job.id];
  await db.execute({ sql: `UPDATE jobs SET ${finalSets.join(', ')} WHERE id = ?`, args: finalArgs });

  const row = await db.execute({ sql: 'SELECT * FROM jobs WHERE id = ?', args: [job.id] });
  ok(res, { job: jobView(row.rows[0]) });
}

router.patch('/:id', asyncH(async (req, res) => updateJob(req, res, false)));
router.put('/:id', asyncH(async (req, res) => updateJob(req, res, true)));

router.delete('/:id', asyncH(async (req, res) => {
  const job = await getJobScoped(req, req.params.id);
  await db.execute({ sql: 'DELETE FROM executions WHERE job_id = ?', args: [job.id] });
  await db.execute({ sql: 'DELETE FROM jobs WHERE id = ?', args: [job.id] });
  ok(res, { deleted: true, id: job.id });
}));

// ---------- start / stop / run ----------

router.post('/:id/stop', asyncH(async (req, res) => {
  const job = await getJobScoped(req, req.params.id);
  await db.execute({ sql: `UPDATE jobs SET enabled = 0, next_run_at = NULL, updated_at = ? WHERE id = ?`, args: [isoNow(), job.id] });
  const row = await db.execute({ sql: 'SELECT * FROM jobs WHERE id = ?', args: [job.id] });
  ok(res, { job: jobView(row.rows[0]), message: 'Job paused' });
}));

router.post('/:id/start', asyncH(async (req, res) => {
  const job = await getJobScoped(req, req.params.id);
  const schedule = { kind: job.schedule_kind, cron: job.schedule_cron, interval_seconds: job.interval_seconds, timezone: job.timezone };
  const next = computeNextRun(schedule);
  await db.execute({ sql: `UPDATE jobs SET enabled = 1, next_run_at = ?, updated_at = ? WHERE id = ?`, args: [next.getTime(), isoNow(), job.id] });
  const row = await db.execute({ sql: 'SELECT * FROM jobs WHERE id = ?', args: [job.id] });
  ok(res, { job: jobView(row.rows[0]), message: 'Job resumed' });
}));

router.post('/:id/run', asyncH(async (req, res) => {
  const job = await getJobScoped(req, req.params.id);
  const execId = dispatchManual(rowToJobLite(job));
  ok(res, { execution_id: execId, message: 'Execution started' }, 202);
}));

// ---------- history ----------

router.get('/:id/history', asyncH(async (req, res) => {
  const job = await getJobScoped(req, req.params.id);
  const q = req.query || {};
  const limit = Math.min(Math.max(vInt(q.limit, 'limit', { min: 1, max: 100, def: 20 }), 1), 100);
  const offset = Math.max(vInt(q.offset, 'offset', { min: 0, max: 100000, def: 0 }), 0);

  const where = ['job_id = ?'];
  const args = [job.id];
  if (q.status) { where.push('status = ?'); args.push(String(q.status)); }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const totalR = await db.execute({ sql: `SELECT COUNT(*) AS c FROM executions ${whereSql}`, args });
  const rows = await db.execute({
    sql: `SELECT * FROM executions ${whereSql} ORDER BY started_at DESC, created_at DESC LIMIT ? OFFSET ?`,
    args: [...args, limit, offset],
  });
  ok(res, {
    executions: rows.rows.map((r) => executionView(r, { withBody: false })),
    pagination: { total: Number(totalR.rows[0].c), limit, offset },
  });
}));

router.get('/:id/history/:execId', asyncH(async (req, res) => {
  const job = await getJobScoped(req, req.params.id);
  const r = await db.execute({
    sql: 'SELECT * FROM executions WHERE id = ? AND job_id = ?',
    args: [req.params.execId, job.id],
  });
  if (!r.rows.length) throw err.execNotFound();
  ok(res, { execution: executionView(r.rows[0], { withBody: true }) });
}));

router.delete('/:id/history', asyncH(async (req, res) => {
  const job = await getJobScoped(req, req.params.id);
  const r = await db.execute({ sql: 'DELETE FROM executions WHERE job_id = ?', args: [job.id] });
  ok(res, { deleted: true, executions_removed: Number(r.rowsAffected) });
}));

// ---------- per-job stats ----------

router.get('/:id/stats', asyncH(async (req, res) => {
  const job = await getJobScoped(req, req.params.id);
  const agg = await db.execute({
    sql: `SELECT COUNT(*) AS total,
                 SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
                 AVG(duration_ms) AS avg_ms
          FROM executions WHERE job_id = ?`,
    args: [job.id],
  });
  const day = await db.execute({
    sql: `SELECT COUNT(*) AS total,
                 SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS failures
          FROM executions WHERE job_id = ? AND started_at >= ?`,
    args: [job.id, new Date(Date.now() - 86400000).toISOString()],
  });
  const a = agg.rows[0];
  const d = day.rows[0];
  const total = Number(a.total || 0);
  const successes = Number(a.successes || 0);
  ok(res, {
    job_id: job.id,
    total_executions: total,
    total_failures: Number(job.fail_count),
    success_rate: total ? Math.round((successes / total) * 1000) / 10 : null,
    avg_duration_ms: a.avg_ms != null ? Math.round(Number(a.avg_ms)) : null,
    last_24h: { runs: Number(d.total || 0), failures: Number(d.failures || 0) },
    consecutive_fails: Number(job.consecutive_fails),
    next_runs: Number(job.enabled)
      ? nextRuns({ kind: job.schedule_kind, cron: job.schedule_cron, interval_seconds: job.interval_seconds, timezone: job.timezone }, 3)
      : [],
  });
}));

function rowToJobLite(row) {
  return {
    id: row.id,
    owner_telegram_id: row.owner_telegram_id,
    title: row.title,
    url: row.url,
    method: row.method,
    headers: row.headers,
    body: row.body,
    timeout: Number(row.timeout),
    schedule_kind: row.schedule_kind,
    schedule_cron: row.schedule_cron,
    schedule_input: row.schedule_input,
    interval_seconds: row.interval_seconds != null ? Number(row.interval_seconds) : null,
    timezone: row.timezone,
    max_retries: Number(row.max_retries),
    retry_interval: Number(row.retry_interval),
    failure_webhook: row.failure_webhook,
    save_responses: !!Number(row.save_responses),
  };
}

export default router;
