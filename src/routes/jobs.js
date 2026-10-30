import { Router } from 'express';
import { db, isoNow } from '../db.js';
import { config } from '../config.js';
import { err, ok, asyncH } from '../errors.js';
import { genId, genApiKey } from '../ids.js';
import { parseSchedule, computeNextRun, nextRuns, isValidTimezone } from '../cron.js';
import {
  vString, vUrl, vOptionalUrl, vMethod, vInt, vBool, vHeaders, vBody, vTags, vExpiresAt, vTelegramId, vAuth,
  vJobType, vExpectedStatus, vKeyword, vKeywordMode, vAlertContactIds, JOB_TYPES,
} from '../validate.js';
import { assertSafeUrl, assertSafeHost } from '../ssrf.js';
import { parseCurlCommand } from '../curl.js';
import { jobView, executionView, lastExecutionSummary, incidentView } from '../views.js';
import { dispatchManual } from '../scheduler.js';
import { RANGES, jobUptime, responseTimes } from '../uptime.js';
import crypto from 'node:crypto';

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

/** Validate a bare host / IP for port checks. Returns the host string. */
function normalizeHostInput(raw) {
  let s = String(raw || '').trim();
  if (!s) throw err.validation('url is required for type "port" (host or IP)');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try { s = new URL(s).hostname.replace(/^\[|\]$/g, ''); } catch { throw err.urlInvalid(); }
  }
  if (!s || s.length > 253) throw err.urlInvalid();
  if (!/^[a-z0-9._-]+$/i.test(s)) throw err.urlInvalid();
  return s.toLowerCase();
}

/** Validate a host for ssl checks -> normalized https URL. */
function normalizeSslInput(raw) {
  let s = String(raw || '').trim();
  if (!s) throw err.validation('url is required for type "ssl" (https URL or host)');
  if (!/^https:\/\//i.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) throw err.validation('ssl checks require an https URL (or a bare hostname)');
    s = 'https://' + s;
  }
  let host;
  try {
    const u = new URL(s);
    host = u.hostname;
    if (u.pathname && u.pathname !== '/' && u.search) {
      // allow paths silently; only the host matters for TLS
    }
  } catch { throw err.urlInvalid(); }
  if (!host || host.length > 253) throw err.urlInvalid();
  if (!/^[a-z0-9._-]+$/i.test(host)) throw err.urlInvalid();
  return 'https://' + host.replace(/^\[|\]$/g, '');
}

/**
 * Validate type-specific combos against the EFFECTIVE values
 * (existing row values overlaid with the request body).
 */
async function resolveTypeFields(body, existing = null, { creating = false } = {}) {
  const pick = (key, def = null) => (body[key] !== undefined ? body[key] : (existing ? existing[key] : def));
  const type = vJobType(body.type !== undefined ? body.type : (creating ? 'http' : (existing?.type || 'http')));

  const eff = {
    url: pick('url'),
    method: pick('method', 'GET'),
    headers: body.headers !== undefined ? body.headers : (existing ? JSON.parse(existing.headers || '{}') || {} : {}),
    body: pick('body'),
    keyword: pick('keyword'),
    port: pick('port'),
    schedule_kind: existing?.schedule_kind || null,
    interval_seconds: existing?.interval_seconds != null ? Number(existing.interval_seconds) : null,
  };
  const isDefaultMethod = body.method === undefined || vMethod(body.method) === 'GET';
  const effHeadersCount = typeof eff.headers === 'object' && eff.headers && !Array.isArray(eff.headers) ? Object.keys(eff.headers).length : 0;

  const out = { type, keyword: null };

  if (type === 'http') {
    out.url = await assertSafeUrl(vUrl(eff.url));
  } else if (type === 'keyword') {
    out.url = await assertSafeUrl(vUrl(eff.url));
    out.keyword = vKeyword(eff.keyword, creating || !existing?.keyword);
    if (!out.keyword) throw err.validation('keyword is required for type "keyword"');
  } else if (type === 'port') {
    const host = normalizeHostInput(eff.url);
    await assertSafeHost(host); // SSRF at create/update too
    out.url = host;
    const port = vInt(eff.port, 'port', { min: 1, max: 65535, def: 0 });
    if (!port) throw err.validation('port is required (1-65535) for type "port"');
    out.port = port;
    if (!isDefaultMethod) throw err.validation('method/body/headers are not allowed for type "port"');
    if (eff.body) throw err.validation('method/body/headers are not allowed for type "port"');
    if (effHeadersCount > 0) throw err.validation('method/body/headers are not allowed for type "port"');
  } else if (type === 'ssl') {
    out.url = normalizeSslInput(eff.url);
    await assertSafeHost(out.url.replace(/^https:\/\//, ''));
    if (!isDefaultMethod) throw err.validation('method/body/headers are not allowed for type "ssl"');
    if (eff.body) throw err.validation('method/body/headers are not allowed for type "ssl"');
    if (effHeadersCount > 0) throw err.validation('method/body/headers are not allowed for type "ssl"');
  } else if (type === 'heartbeat') {
    // url optional; no outgoing request (DB column is NOT NULL -> store empty string)
    out.url = eff.url ? String(eff.url).slice(0, 2048) : '';
    if (!isDefaultMethod) throw err.validation('method/body/headers are not allowed for type "heartbeat"');
    if (eff.body) throw err.validation('method/body/headers are not allowed for type "heartbeat"');
    if (effHeadersCount > 0) throw err.validation('method/body/headers are not allowed for type "heartbeat"');
  }

  // expected_status / keyword extras / max_response_ms only for request-based types
  if (type === 'http' || type === 'keyword') {
    if (body.expected_status !== undefined) out.expected_status = vExpectedStatus(body.expected_status);
    else out.expected_status = existing?.expected_status || null; // keep stored JSON
  } else {
    if (body.expected_status !== undefined) throw err.validation(`expected_status is only valid for types: http, keyword`);
    out.expected_status = null;
  }
  if (type === 'keyword') {
    out.keyword_mode = vKeywordMode(body.keyword_mode !== undefined ? body.keyword_mode : (existing?.keyword_mode || 'exists'));
    out.keyword_case_sensitive = vBool(body.keyword_case_sensitive !== undefined ? body.keyword_case_sensitive : (existing?.keyword_case_sensitive || false), false);
  } else {
    if (body.keyword_mode !== undefined || body.keyword_case_sensitive !== undefined) {
      if (type !== 'keyword') throw err.validation('keyword_mode / keyword_case_sensitive are only valid for type "keyword"');
    }
    out.keyword_mode = type === 'keyword' ? (out.keyword_mode || 'exists') : null;
    out.keyword_case_sensitive = null;
  }
  if (type !== 'heartbeat') {
    out.max_response_ms = vInt(body.max_response_ms !== undefined ? body.max_response_ms : (existing?.max_response_ms ?? null), 'max_response_ms', { min: 100, max: 600000, def: null });
  } else {
    if (body.max_response_ms !== undefined) throw err.validation('max_response_ms is not valid for type "heartbeat"');
    out.max_response_ms = null;
  }
  if (type === 'ssl') {
    out.ssl_expiry_days = vInt(body.ssl_expiry_days !== undefined ? body.ssl_expiry_days : (existing?.ssl_expiry_days ?? null), 'ssl_expiry_days', { min: 1, max: 365, def: 14 });
  } else {
    out.ssl_expiry_days = 14; // NOT NULL column — keep default for non-ssl types
  }
  if (type === 'heartbeat') {
    out.heartbeat_grace_seconds = vInt(body.heartbeat_grace_seconds !== undefined ? body.heartbeat_grace_seconds : (existing?.heartbeat_grace_seconds ?? null), 'heartbeat_grace_seconds', { min: 0, max: 86400, def: 60 });
  } else {
    out.heartbeat_grace_seconds = 60; // NOT NULL column — keep default for non-heartbeat types
  }
  if (type !== 'port') {
    if (body.port !== undefined) throw err.validation('port is only valid for type "port"');
    out.port = null;
  }

  // alerting fields (all types)
  out.alert_contact_ids = vAlertContactIds(body.alert_contact_ids !== undefined ? body.alert_contact_ids : null);
  if (out.alert_contact_ids === null && existing) out.alert_contact_ids = existing.alert_contact_ids || '[]';
  out.alert_on_down = vBool(body.alert_on_down !== undefined ? body.alert_on_down : (existing ? !!Number(existing.alert_on_down) : true), true);
  out.alert_on_up = vBool(body.alert_on_up !== undefined ? body.alert_on_up : (existing ? !!Number(existing.alert_on_up) : true), true);
  out.alert_after_minutes = vInt(body.alert_after_minutes !== undefined ? body.alert_after_minutes : (existing?.alert_after_minutes ?? null), 'alert_after_minutes', { min: 0, max: 1440, def: 0 });
  out.repeat_alert_minutes = vInt(body.repeat_alert_minutes !== undefined ? body.repeat_alert_minutes : (existing?.repeat_alert_minutes ?? null), 'repeat_alert_minutes', { min: 0, max: 1440, def: 0 });

  return out;
}

async function buildJobFields(body, existing = null, { creating = false } = {}) {
  const typeFields = await resolveTypeFields(body, existing, { creating });
  const type = typeFields.type;
  const url = typeFields.url;
  const method = vMethod(body.method);
  const headers = vHeaders(body.headers);
  const b = vBody(body.body, method);
  const timeout = vInt(body.timeout, 'timeout', { min: 5, max: 60, def: 30 });
  const maxRetries = vInt(body.max_retries, 'max_retries', { min: 0, max: 3, def: 0 });
  const retryInterval = vInt(body.retry_interval, 'retry_interval', { min: 30, max: 3600, def: 60 });
  const failureWebhook = vOptionalUrl(body.failure_webhook, 'failure_webhook');
  const recoveryWebhook = vOptionalUrl(body.recovery_webhook, 'recovery_webhook');
  const successWebhook = vOptionalUrl(body.success_webhook, 'success_webhook');
  if (failureWebhook) await assertSafeUrl(failureWebhook);
  if (recoveryWebhook) await assertSafeUrl(recoveryWebhook);
  if (successWebhook) await assertSafeUrl(successWebhook);
  const autoDisableAfter = vInt(body.auto_disable_after, 'auto_disable_after', { min: 0, max: 100, def: 0 });
  const followRedirects = vBool(body.follow_redirects, true);
  const redirectIsSuccess = vBool(body.redirect_is_success, false);
  const auth = vAuth(body.auth);
  const folder = vString(body.folder, 'folder', { max: 60 });
  const saveResponses = vBool(body.save_responses, true);
  const tags = vTags(body.tags);
  const title = vString(body.title, 'title', { max: 120 });
  const expiresAt = vExpiresAt(body.expires_at);
  const schedule = parseSchedule(body.schedule, config.defaultTimezone);
  const enabled = vBool(body.enabled, true);

  if (type === 'heartbeat' && schedule.interval_seconds == null) {
    throw err.validation('heartbeat jobs require an interval schedule ("@every 5m"). The schedule is the expected ping interval.');
  }

  return {
    url, method, headers, body: b, timeout, maxRetries, retryInterval,
    failureWebhook, recoveryWebhook, successWebhook, autoDisableAfter,
    followRedirects, redirectIsSuccess, auth, folder,
    saveResponses, tags, title, expiresAt, schedule, enabled,
    ...typeFields,
  };
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

  const f = await buildJobFields(body, null, { creating: true });
  const id = genId('job_');
  const now = isoNow();
  const isHeartbeat = f.type === 'heartbeat';
  const nextRun = f.enabled && !isHeartbeat ? computeNextRun(f.schedule).getTime() : null;
  const heartbeatToken = isHeartbeat ? 'hb_' + crypto.randomBytes(24).toString('hex') : null;

  // alert_contact_ids ownership check
  let alertIds = [];
  try { alertIds = JSON.parse(f.alert_contact_ids || '[]'); } catch { alertIds = []; }
  if (alertIds.length) {
    const ph = alertIds.map(() => '?').join(',');
    const owned = await db.execute({ sql: `SELECT COUNT(*) AS c FROM alert_contacts WHERE id IN (${ph}) AND telegram_id = ?`, args: [...alertIds, telegram_id] });
    if (Number(owned.rows[0].c) !== alertIds.length) throw err.validation('alert_contact_ids contains a contact that does not exist or belongs to another user');
  }

  await db.execute({
    sql: `INSERT INTO jobs (id, owner_telegram_id, title, url, method, headers, body, timeout,
            schedule_kind, schedule_cron, schedule_input, interval_seconds, timezone,
            enabled, expires_at, next_run_at, max_retries, retry_interval,
            failure_webhook, recovery_webhook, success_webhook, auto_disable_after,
            follow_redirects, redirect_is_success, auth, folder, disabled_reason,
            save_responses, tags,
            type, expected_status, keyword, keyword_mode, keyword_case_sensitive,
            max_response_ms, port, ssl_expiry_days, heartbeat_grace_seconds,
            alert_contact_ids, alert_on_down, alert_on_up, alert_after_minutes, repeat_alert_minutes,
            state, state_changed_at, last_error_code, heartbeat_token, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  'pending', ?, ?, ?, ?, ?)`,
    args: [
      id, telegram_id, f.title, f.url, f.method, JSON.stringify(f.headers), f.body, f.timeout,
      f.schedule.kind, f.schedule.cron, f.schedule.input, f.schedule.interval_seconds, f.schedule.timezone,
      f.enabled ? 1 : 0, f.expiresAt, nextRun, f.maxRetries, f.retryInterval,
      f.failureWebhook, f.recoveryWebhook, f.successWebhook, f.autoDisableAfter,
      f.followRedirects ? 1 : 0, f.redirectIsSuccess ? 1 : 0, f.auth ? JSON.stringify(f.auth) : null,
      f.folder || null, null,
      f.saveResponses ? 1 : 0, JSON.stringify(f.tags),
      f.type, f.expected_status, f.keyword, f.keyword_mode, f.keyword_case_sensitive ? 1 : 0,
      f.max_response_ms, f.port, f.ssl_expiry_days, f.heartbeat_grace_seconds,
      f.alert_contact_ids || '[]', f.alert_on_down ? 1 : 0, f.alert_on_up ? 1 : 0,
      f.alert_after_minutes, f.repeat_alert_minutes,
      null, null, heartbeatToken, now, now,
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
      await db.execute({ sql: `UPDATE jobs SET enabled = 0, next_run_at = NULL, disabled_reason = 'paused_by_user', state = 'paused', state_changed_at = ?, updated_at = ? WHERE id = ?`, args: [isoNow(), isoNow(), id] });
    } else if (action === 'resume') {
      const next = computeNextRun({ kind: j.schedule_kind, cron: j.schedule_cron, interval_seconds: j.interval_seconds, timezone: j.timezone });
      const isHb = j.type === 'heartbeat';
      await db.execute({ sql: `UPDATE jobs SET enabled = 1, next_run_at = ?, disabled_reason = NULL, state = CASE WHEN state = 'paused' THEN 'pending' ELSE state END, state_changed_at = ?, updated_at = ? WHERE id = ?`, args: [isHb ? null : next.getTime(), isoNow(), isoNow(), id] });
    } else if (action === 'delete') {
      await db.execute({ sql: `DELETE FROM executions WHERE job_id = ?`, args: [id] });
      await db.execute({ sql: `DELETE FROM incidents WHERE job_id = ?`, args: [id] });
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
  if (q.folder) {
    where.push('folder = ?');
    args.push(String(q.folder).slice(0, 60));
  }
  if (q.state && ['up', 'down', 'paused', 'pending'].includes(String(q.state))) {
    if (q.state === 'paused') {
      where.push('enabled = 0');
    } else {
      where.push("enabled = 1 AND state = ?");
      args.push(String(q.state));
    }
  }
  if (q.type && JOB_TYPES.includes(String(q.type))) {
    where.push('type = ?');
    args.push(String(q.type));
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
  // type-specific fields (url revalidated through SSRF inside; heartbeat url optional even for PUT)
  const typeFields = await resolveTypeFields(body, job, { creating: false });
  patch.url = typeFields.url;
  patch.type = typeFields.type;
  patch.expected_status = typeFields.expected_status;
  patch.keyword = typeFields.keyword;
  patch.keyword_mode = typeFields.keyword_mode;
  patch.keyword_case_sensitive = typeFields.keyword_case_sensitive;
  patch.max_response_ms = typeFields.max_response_ms;
  patch.port = typeFields.port;
  patch.ssl_expiry_days = typeFields.ssl_expiry_days;
  patch.heartbeat_grace_seconds = typeFields.heartbeat_grace_seconds;
  patch.alert_contact_ids = typeFields.alert_contact_ids;
  patch.alert_on_down = typeFields.alert_on_down;
  patch.alert_on_up = typeFields.alert_on_up;
  patch.alert_after_minutes = typeFields.alert_after_minutes;
  patch.repeat_alert_minutes = typeFields.repeat_alert_minutes;
  if (typeFields.alert_contact_ids && typeFields.alert_contact_ids !== job.alert_contact_ids) {
    let ids = [];
    try { ids = JSON.parse(typeFields.alert_contact_ids || '[]'); } catch { ids = []; }
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      const owned = await db.execute({ sql: `SELECT COUNT(*) AS c FROM alert_contacts WHERE id IN (${ph}) AND telegram_id = ?`, args: [...ids, job.owner_telegram_id] });
      if (Number(owned.rows[0].c) !== ids.length) throw err.validation('alert_contact_ids contains a contact that does not exist or belongs to another user');
    }
  }
  if (typeFields.type === 'heartbeat' && !job.heartbeat_token) {
    patch.heartbeat_token = 'hb_' + crypto.randomBytes(24).toString('hex');
  }
  if (body.method !== undefined) patch.method = vMethod(body.method);
  if (body.headers !== undefined) {
    const incoming = vHeaders(body.headers);
    // masked header values ("***" from a previous GET) keep their stored values
    let stored = {};
    try { stored = JSON.parse(job.headers || '{}') || {}; } catch { stored = {}; }
    const merged = {};
    for (const [k, v] of Object.entries(incoming)) {
      merged[k] = v === '***' && stored[k] !== undefined ? stored[k] : v;
    }
    patch.headers = merged;
  }
  if (body.body !== undefined) patch.body = vBody(body.body, body.method !== undefined ? vMethod(body.method) : job.method);
  if (body.timeout !== undefined) patch.timeout = vInt(body.timeout, 'timeout', { min: 5, max: 60, def: 30 });
  if (body.max_retries !== undefined) patch.max_retries = vInt(body.max_retries, 'max_retries', { min: 0, max: 3, def: 0 });
  if (body.retry_interval !== undefined) patch.retry_interval = vInt(body.retry_interval, 'retry_interval', { min: 30, max: 3600, def: 60 });
  if (body.failure_webhook !== undefined) {
    const fw = vOptionalUrl(body.failure_webhook, 'failure_webhook');
    if (fw) await assertSafeUrl(fw);
    patch.failure_webhook = fw;
  }
  if (body.recovery_webhook !== undefined) {
    const rw = vOptionalUrl(body.recovery_webhook, 'recovery_webhook');
    if (rw) await assertSafeUrl(rw);
    patch.recovery_webhook = rw;
  }
  if (body.success_webhook !== undefined) {
    const sw = vOptionalUrl(body.success_webhook, 'success_webhook');
    if (sw) await assertSafeUrl(sw);
    patch.success_webhook = sw;
  }
  if (body.auto_disable_after !== undefined) patch.auto_disable_after = vInt(body.auto_disable_after, 'auto_disable_after', { min: 0, max: 100, def: 0 });
  if (body.follow_redirects !== undefined) patch.follow_redirects = vBool(body.follow_redirects, true);
  if (body.redirect_is_success !== undefined) patch.redirect_is_success = vBool(body.redirect_is_success, false);
  if (body.auth !== undefined) {
    let a = vAuth(body.auth);
    // Masked password from a previous GET -> keep the stored password
    if (a && a.password === '***') {
      let stored = null;
      try { stored = job.auth ? JSON.parse(job.auth) : null; } catch { stored = null; }
      if (stored && stored.type === 'basic') a = { ...a, password: stored.password };
      else throw err.validation('auth.password is required');
    }
    patch.auth = a ? JSON.stringify(a) : null;
  }
  if (body.folder !== undefined) patch.folder = vString(body.folder, 'folder', { max: 60 }) || null;
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
  if (body.enabled !== undefined) {
    patch.disabled_reason = enabled ? null : 'paused_by_user';
  }
  // heartbeat requires an interval schedule (effective schedule: new or stored)
  const effType = typeFields.type;
  const method = patch.method || job.method;
  if (patch.body !== undefined && patch.body && !['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    throw err.validation(`body is not allowed for ${method}`);
  }

  const now = isoNow();
  const sets = [];
  const args = [];
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'headers' || k === 'tags' || k === 'auth' || k === 'alert_contact_ids') { sets.push(`${k} = ?`); args.push(typeof v === 'string' ? v : JSON.stringify(v)); }
    else if (['save_responses', 'follow_redirects', 'redirect_is_success', 'keyword_case_sensitive', 'alert_on_down', 'alert_on_up'].includes(k)) { sets.push(`${k} = ?`); args.push(v ? 1 : 0); }
    else { sets.push(`${k} = ?`); args.push(v); }
  }

  let nextRun = job.next_run_at != null ? Number(job.next_run_at) : null;
  if (effType === 'heartbeat') {
    nextRun = null; // heartbeat jobs are driven by pings, not the scheduler
  } else if (!enabled) {
    nextRun = null;
  } else if (scheduleChanged || body.enabled === true || !nextRun) {
    nextRun = computeNextRun(schedule).getTime();
  }

  // state transitions for enable/disable
  let stateChanged = null;
  if (!enabled) {
    stateChanged = 'paused';
  } else if (body.enabled === true && (job.state || 'pending') === 'paused') {
    stateChanged = 'pending';
  }

  const finalSets = [...sets, 'enabled = ?', 'next_run_at = ?', 'updated_at = ?'];
  const finalArgs = [...args, enabled ? 1 : 0, nextRun, now];
  if (stateChanged) {
    finalSets.push('state = ?', 'state_changed_at = ?');
    finalArgs.push(stateChanged, now);
  }
  finalArgs.push(job.id);
  await db.execute({ sql: `UPDATE jobs SET ${finalSets.join(', ')} WHERE id = ?`, args: finalArgs });

  const row = await db.execute({ sql: 'SELECT * FROM jobs WHERE id = ?', args: [job.id] });
  ok(res, { job: jobView(row.rows[0]) });
}

router.patch('/:id', asyncH(async (req, res) => updateJob(req, res, false)));
router.put('/:id', asyncH(async (req, res) => updateJob(req, res, true)));

router.delete('/:id', asyncH(async (req, res) => {
  const job = await getJobScoped(req, req.params.id);
  await db.execute({ sql: 'DELETE FROM executions WHERE job_id = ?', args: [job.id] });
  await db.execute({ sql: 'DELETE FROM incidents WHERE job_id = ?', args: [job.id] });
  await db.execute({ sql: 'DELETE FROM job_daily WHERE job_id = ?', args: [job.id] });
  await db.execute({ sql: 'DELETE FROM job_rollup_state WHERE job_id = ?', args: [job.id] });
  await db.execute({ sql: 'DELETE FROM jobs WHERE id = ?', args: [job.id] });
  ok(res, { deleted: true, id: job.id });
}));

// ---------- start / stop / run ----------

router.post('/:id/stop', asyncH(async (req, res) => {
  const job = await getJobScoped(req, req.params.id);
  await db.execute({ sql: `UPDATE jobs SET enabled = 0, next_run_at = NULL, disabled_reason = 'paused_by_user', state = 'paused', state_changed_at = ?, updated_at = ? WHERE id = ?`, args: [isoNow(), isoNow(), job.id] });
  const row = await db.execute({ sql: 'SELECT * FROM jobs WHERE id = ?', args: [job.id] });
  ok(res, { job: jobView(row.rows[0]), message: 'Job paused' });
}));

router.post('/:id/start', asyncH(async (req, res) => {
  const job = await getJobScoped(req, req.params.id);
  const isHb = (job.type || 'http') === 'heartbeat';
  let next = null;
  if (!isHb) next = computeNextRun({ kind: job.schedule_kind, cron: job.schedule_cron, interval_seconds: job.interval_seconds, timezone: job.timezone });
  await db.execute({ sql: `UPDATE jobs SET enabled = 1, next_run_at = ?, disabled_reason = NULL, state = CASE WHEN state = 'paused' THEN 'pending' ELSE state END, state_changed_at = CASE WHEN state = 'paused' THEN ? ELSE state_changed_at END, updated_at = ? WHERE id = ?`, args: [isHb ? null : next.getTime(), isoNow(), isoNow(), job.id] });
  const row = await db.execute({ sql: 'SELECT * FROM jobs WHERE id = ?', args: [job.id] });
  ok(res, { job: jobView(row.rows[0]), message: 'Job resumed' });
}));

router.post('/:id/run', asyncH(async (req, res) => {
  const job = await getJobScoped(req, req.params.id);
  if ((job.type || 'http') === 'heartbeat') {
    throw err.validation('heartbeat jobs cannot be run manually — they go UP/DOWN based on pings to the heartbeat_url');
  }
  const execId = dispatchManual(rowToJobLite(job));
  ok(res, { execution_id: execId, message: 'Execution started' }, 202);
}));

// ---------- incidents ----------

router.get('/:id/incidents', asyncH(async (req, res) => {
  const job = await getJobScoped(req, req.params.id);
  const q = req.query || {};
  const limit = Math.min(Math.max(vInt(q.limit, 'limit', { min: 1, max: 100, def: 20 }), 1), 100);
  const offset = Math.max(vInt(q.offset, 'offset', { min: 0, max: 100000, def: 0 }), 0);
  const where = ['job_id = ?'];
  const args = [job.id];
  if (q.ongoing === 'true') where.push('ended_at IS NULL');
  if (q.ongoing === 'false') where.push('ended_at IS NOT NULL');
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const totalR = await db.execute({ sql: `SELECT COUNT(*) AS c FROM incidents ${whereSql}`, args });
  const rows = await db.execute({
    sql: `SELECT * FROM incidents ${whereSql} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
    args: [...args, limit, offset],
  });
  ok(res, { incidents: rows.rows.map(incidentView), pagination: { total: Number(totalR.rows[0].c), limit, offset } });
}));

// ---------- uptime stats ----------

router.get('/:id/uptime', asyncH(async (req, res) => {
  const job = await getJobScoped(req, req.params.id);
  const q = req.query || {};
  const range = String(q.range || '24h');
  if (!RANGES[range]) throw err.validation('range must be one of: 24h, 7d, 30d, 90d');
  const u = await jobUptime(job, RANGES[range]);
  ok(res, { job_id: job.id, range, ...u });
}));

router.get('/:id/response-times', asyncH(async (req, res) => {
  const job = await getJobScoped(req, req.params.id);
  const q = req.query || {};
  const range = String(q.range || '24h');
  if (!RANGES[range]) throw err.validation('range must be one of: 24h, 7d, 30d, 90d');
  const points = Math.min(Math.max(vInt(q.points, 'points', { min: 10, max: 200, def: 100 }), 10), 200);
  const pts = await responseTimes(job.id, RANGES[range], points);
  ok(res, { job_id: job.id, range, points: pts });
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

// CSV export of history
router.get('/:id/history.csv', asyncH(async (req, res) => {
  const job = await getJobScoped(req, req.params.id);
  const rows = await db.execute({
    sql: `SELECT id, started_at, finished_at, status, error_code, status_code, duration_ms, error
          FROM executions WHERE job_id = ? ORDER BY started_at DESC LIMIT 1000`,
    args: [job.id],
  });
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = ['id,started_at,finished_at,status,error_code,status_code,duration_ms,error'];
  for (const r of rows.rows) {
    lines.push([r.id, r.started_at, r.finished_at, r.status, r.error_code, r.status_code, r.duration_ms, esc(r.error)].join(','));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${job.id}-history.csv"`);
  res.send(lines.join('\n') + '\n');
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
  const up24 = await jobUptime(job, 86400);
  ok(res, {
    job_id: job.id,
    total_executions: total,
    total_failures: Number(job.fail_count),
    success_rate: total ? Math.round((successes / total) * 1000) / 10 : null,
    avg_duration_ms: a.avg_ms != null ? Math.round(Number(a.avg_ms)) : null,
    last_24h: { runs: Number(d.total || 0), failures: Number(d.failures || 0) },
    consecutive_fails: Number(job.consecutive_fails),
    state: job.state || 'pending',
    uptime_24h_percent: up24.uptime_percent,
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
    recovery_webhook: row.recovery_webhook,
    success_webhook: row.success_webhook,
    auto_disable_after: row.auto_disable_after != null ? Number(row.auto_disable_after) : 0,
    follow_redirects: row.follow_redirects != null ? !!Number(row.follow_redirects) : true,
    redirect_is_success: row.redirect_is_success != null ? !!Number(row.redirect_is_success) : false,
    auth: row.auth || null,
    folder: row.folder || null,
    save_responses: !!Number(row.save_responses),
    consecutive_fails: Number(row.consecutive_fails || 0),
    // v1.2.0
    type: row.type || 'http',
    expected_status: row.expected_status || null,
    keyword: row.keyword || null,
    keyword_mode: row.keyword_mode || 'exists',
    keyword_case_sensitive: row.keyword_case_sensitive != null ? !!Number(row.keyword_case_sensitive) : false,
    max_response_ms: row.max_response_ms != null ? Number(row.max_response_ms) : null,
    port: row.port != null ? Number(row.port) : null,
    ssl_expiry_days: row.ssl_expiry_days != null ? Number(row.ssl_expiry_days) : 14,
    heartbeat_grace_seconds: row.heartbeat_grace_seconds != null ? Number(row.heartbeat_grace_seconds) : 60,
    alert_contact_ids: row.alert_contact_ids || '[]',
    alert_on_down: row.alert_on_down != null ? !!Number(row.alert_on_down) : true,
    alert_on_up: row.alert_on_up != null ? !!Number(row.alert_on_up) : true,
    alert_after_minutes: row.alert_after_minutes != null ? Number(row.alert_after_minutes) : 0,
    repeat_alert_minutes: row.repeat_alert_minutes != null ? Number(row.repeat_alert_minutes) : 0,
    state: row.state || 'pending',
    state_changed_at: row.state_changed_at || null,
    last_ping_at: row.last_ping_at != null ? Number(row.last_ping_at) : null,
    created_at: row.created_at,
  };
}

export default router;
