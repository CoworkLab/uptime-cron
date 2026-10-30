import { db, isoNow } from './db.js';
import { config } from './config.js';
import { computeNextRun } from './cron.js';
import { runCheck } from './checks.js';
import { assertSafeUrl } from './ssrf.js';
import { isMaintenanceActive } from './maintenance.js';
import { sendJobAlert } from './notifier.js';
import { recordTick, rollupTick, purgeOld } from './rollup.js';
import { genId } from './ids.js';

let ticking = false;
let inflight = 0;
let timer = null;
let tickCount = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STORE_BODY_BYTES = 4096; // history stores first 4 KB even when keyword reads 256 KB

function rowToJob(row) {
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
    enabled: !!Number(row.enabled),
    expires_at: row.expires_at != null ? Number(row.expires_at) : null,
    next_run_at: row.next_run_at != null ? Number(row.next_run_at) : null,
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

export function startScheduler() {
  timer = setInterval(() => tick(), config.tickSeconds * 1000);
  // Fire an initial tick shortly after boot
  setTimeout(() => tick(), 2000);
  console.log(`[scheduler] started (tick=${config.tickSeconds}s, concurrency=${config.maxConcurrency})`);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    tickCount++;
    await recordTick();
    if (tickCount % 30 === 0) await rollupTick();   // every ~5 min
    if (tickCount % 360 === 5) await purgeOld();    // ~hourly

    const slots = config.maxConcurrency - inflight;
    if (slots > 0) {
      const now = Date.now();
      const res = await db.execute({
        sql: `SELECT * FROM jobs
              WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
              ORDER BY next_run_at ASC
              LIMIT ?`,
        args: [now, slots],
      });
      for (const row of res.rows) {
        await claimAndDispatch(rowToJob(row));
      }
    }
    await heartbeatScan();
  } catch (e) {
    console.error('[scheduler] tick error:', e.message);
  } finally {
    ticking = false;
  }
}

async function claimAndDispatch(job) {
  const now = new Date();
  const newNext = computeNextRun(
    { kind: job.schedule_kind, cron: job.schedule_cron, interval_seconds: job.interval_seconds, timezone: job.timezone },
    now
  );

  // Job expired -> auto-disable
  if (job.expires_at && newNext.getTime() > job.expires_at) {
    await db.execute({
      sql: `UPDATE jobs SET enabled = 0, next_run_at = NULL, disabled_reason = 'expired', state = 'paused', state_changed_at = ?, updated_at = ? WHERE id = ?`,
      args: [isoNow(), isoNow(), job.id],
    });
    console.log(`[scheduler] job ${job.id} expired -> disabled`);
    return;
  }

  // Optimistic claim: only dispatch if next_run_at is still the one we saw
  const claimed = await db.execute({
    sql: `UPDATE jobs SET next_run_at = ?, last_run_at = ?, updated_at = ? WHERE id = ? AND next_run_at = ?`,
    args: [newNext.getTime(), Date.now(), isoNow(), job.id, job.next_run_at],
  });
  if (claimed.rowsAffected === 0) return;

  inflight++;
  runJobWithRetries(job).finally(() => {
    inflight--;
  });
}

async function runJobWithRetries(job) {
  const maxAttempts = job.max_retries + 1;
  let lastResult = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastResult = await runCheck(job);
    await logExecution(job, lastResult, attempt, maxAttempts);

    if (lastResult.status === 'success') break;
    if (attempt < maxAttempts) await sleep(job.retry_interval * 1000);
  }

  await finalizeRun(job, lastResult, maxAttempts);
}

async function getOngoingIncident(jobId) {
  const r = await db.execute({
    sql: 'SELECT * FROM incidents WHERE job_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
    args: [jobId],
  });
  return r.rows[0] || null;
}

async function setJobState(jobId, state, { errorCode = undefined, lastStatus = undefined } = {}) {
  const sets = ['state = ?', 'state_changed_at = ?', 'updated_at = ?'];
  const args = [state, isoNow(), isoNow()];
  if (errorCode !== undefined) { sets.push('last_error_code = ?'); args.push(errorCode); }
  if (lastStatus !== undefined) { sets.push('last_status = ?'); args.push(lastStatus); }
  args.push(jobId);
  await db.execute({ sql: `UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`, args });
}

/**
 * Post-run side effects shared by scheduled and manual runs:
 * v1.1.0 webhooks + auto-disable (unchanged behavior), plus v1.2.0
 * state machine, incidents and contact alerts.
 */
async function finalizeRun(job, result, attemptsUsed) {
  if (!result) return;
  const prevFails = Number(job.consecutive_fails || 0);
  const success = result.status === 'success';
  const maintenance = await isMaintenanceActive(job.id, job.owner_telegram_id);

  // ---------- v1.1.0 behavior: success/recovery webhooks + auto-disable ----------
  if (success) {
    if (!maintenance && job.success_webhook) {
      await fireWebhook(job.success_webhook, {
        event: 'success',
        job_id: job.id,
        status_code: result.status_code,
        duration_ms: result.duration_ms,
      });
    }
    if (!maintenance && job.recovery_webhook && prevFails > 0) {
      await fireWebhook(job.recovery_webhook, {
        event: 'recovered',
        job_id: job.id,
        title: job.title || '',
        downtime_runs: prevFails,
        at: new Date().toISOString(),
      });
    }
  }

  let autoDisabled = false;
  if (!success) {
    const newFails = prevFails + 1;
    const autoAfter = Number(job.auto_disable_after || 0);
    if (autoAfter > 0 && newFails >= autoAfter) {
      autoDisabled = true;
      await db.execute({
        sql: `UPDATE jobs SET enabled = 0, next_run_at = NULL, disabled_reason = 'auto_disabled_after_failures', updated_at = ? WHERE id = ?`,
        args: [isoNow(), job.id],
      });
      console.log(`[scheduler] job ${job.id} auto-disabled after ${newFails} consecutive fails`);
      if (!maintenance && job.failure_webhook) {
        await fireWebhook(job.failure_webhook, {
          event: 'auto_disabled',
          occurred_at: new Date().toISOString(),
          job: { id: job.id, title: job.title || '', telegram_id: job.owner_telegram_id },
          auto_disable_after: autoAfter,
          consecutive_fails: newFails,
          last_error: result.error,
        });
      }
    } else if (!maintenance && job.failure_webhook) {
      await fireWebhook(job.failure_webhook, {
        event: 'failed',
        occurred_at: new Date().toISOString(),
        job: {
          id: job.id,
          title: job.title || '',
          telegram_id: job.owner_telegram_id,
          url: job.url,
          method: job.method,
          schedule: job.schedule_input,
        },
        execution: {
          status: result.status,
          status_code: result.status_code,
          duration_ms: result.duration_ms,
          error: result.error,
          attempts_used: attemptsUsed,
        },
      });
    }
  }

  // ---------- v1.2.0: state machine + incidents + contact alerts ----------
  const freshR = await db.execute({ sql: 'SELECT state, state_changed_at FROM jobs WHERE id = ?', args: [job.id] });
  const prevState = freshR.rows[0]?.state || 'pending';
  const prevStateChangedAt = freshR.rows[0]?.state_changed_at || null;

  let newState = prevState;
  if (autoDisabled) {
    newState = 'paused';
  } else if (success && prevState !== 'up') {
    newState = 'up';
  } else if (!success && (prevState === 'up' || prevState === 'pending')) {
    newState = 'down';
  }

  const errorCode = success ? null : (result.error_code || null);
  if (newState !== prevState) {
    await setJobState(job.id, newState, { errorCode, lastStatus: result.status });
  } else {
    await db.execute({
      sql: `UPDATE jobs SET last_error_code = ?, updated_at = ? WHERE id = ?`,
      args: [errorCode, isoNow(), job.id],
    });
  }

  const nowIso = isoNow();
  let incident = await getOngoingIncident(job.id);
  let closedIncident = null;

  if (!success && newState === 'down') {
    if (!incident && !maintenance) {
      // open a new incident; backdate when we were already down without one (e.g. maintenance before)
      const startedAt = (prevState === 'down' && prevStateChangedAt) ? prevStateChangedAt : nowIso;
      const id = genId('inc_');
      await db.execute({
        sql: `INSERT INTO incidents (id, job_id, telegram_id, started_at, ended_at, duration_seconds, error_code, error_text, status_code, created_at)
              VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
        args: [id, job.id, job.owner_telegram_id, startedAt, errorCode, (result.error || '').slice(0, 500), result.status_code ?? null, nowIso],
      });
      incident = { id, started_at: startedAt, down_alerted_at: null, up_alerted_at: null, last_alert_at: null };
    }
    if (incident && !maintenance && job.alert_on_down) {
      await maybeAlertDown(job, incident, result);
    }
  }

  if (success && incident) {
    const durationSeconds = Math.max(0, Math.round((Date.now() - Date.parse(incident.started_at)) / 1000));
    await db.execute({
      sql: `UPDATE incidents SET ended_at = ?, duration_seconds = ? WHERE id = ?`,
      args: [nowIso, durationSeconds, incident.id],
    });
    closedIncident = { ...incident, ended_at: nowIso, duration_seconds: durationSeconds };
    incident = null;
    if (!maintenance && job.alert_on_up) {
      await maybeAlertUp(job, closedIncident);
    }
  }
}

/** DOWN alert with alert_after_minutes delay + repeat_alert_minutes repeats. */
async function maybeAlertDown(job, incident, result) {
  const now = Date.now();
  const ageSeconds = (now - Date.parse(incident.started_at)) / 1000;
  const afterSeconds = Number(job.alert_after_minutes || 0) * 60;
  if (ageSeconds < afterSeconds) return; // not yet due; a later failed run will retry

  const repeatSeconds = Number(job.repeat_alert_minutes || 0) * 60;
  const alreadyAlerted = !!incident.down_alerted_at;
  if (alreadyAlerted && repeatSeconds <= 0) return; // one alert per incident
  if (alreadyAlerted && incident.last_alert_at) {
    const sinceLast = (now - Date.parse(incident.last_alert_at)) / 1000;
    if (sinceLast < repeatSeconds) return;
  }

  const event = incident.error_code === 'SSL_EXPIRING' || result?.error_code === 'SSL_EXPIRING'
    ? 'ssl_expiring'
    : (incident.error_code === 'HEARTBEAT_MISSED' ? 'heartbeat_missed' : 'down');

  const r = await sendJobAlert(job, {
    event,
    errorCode: incident.error_code || result?.error_code || null,
    statusCode: result?.status_code ?? incident.status_code ?? null,
    incident,
  });
  await db.execute({
    sql: `UPDATE incidents SET down_alerted_at = COALESCE(down_alerted_at, ?), last_alert_at = ? WHERE id = ?`,
    args: [isoNow(), isoNow(), incident.id],
  });
  if (r.sent === 0) console.error(`[alerts] down alert not delivered for ${job.id}:`, r.details?.[0]?.error);
}

/** UP alert: once per incident, only if a DOWN alert was sent (or none was required). */
async function maybeAlertUp(job, incident) {
  const wasAlerted = !!incident.down_alerted_at;
  const needed = Number(job.alert_after_minutes || 0) === 0 || wasAlerted;
  if (!needed || incident.up_alerted_at) return;
  await sendJobAlert(job, {
    event: 'up',
    incident,
  });
}

// ---------- heartbeat ----------

/** Scan enabled heartbeat jobs; mark DOWN when no ping within interval + grace. */
async function heartbeatScan() {
  try {
    const rows = await db.execute({ sql: `SELECT * FROM jobs WHERE type = 'heartbeat' AND enabled = 1`, args: [] });
    for (const row of rows.rows) {
      const job = rowToJob(row);
      if (!job.interval_seconds) continue; // misconfigured; validation prevents this
      const last = job.last_ping_at || Date.parse(job.created_at || new Date().toISOString()) || Date.now();
      const deadline = last + (job.interval_seconds + job.heartbeat_grace_seconds) * 1000;
      if (Date.now() < deadline) continue;
      if (job.state === 'down') continue; // incident already open

      const result = {
        status: 'failed',
        status_code: null,
        duration_ms: 0,
        error: `No heartbeat received within ${job.interval_seconds + job.heartbeat_grace_seconds}s`,
        error_code: 'HEARTBEAT_MISSED',
        response_body: null,
        response_headers: null,
        timing: null,
      };
      await logExecution(job, result, 1, 1);
      await finalizeRun(job, result, 1);
      console.log(`[heartbeat] job ${job.id} missed -> down`);
    }
  } catch (e) {
    console.error('[heartbeat] scan error:', e.message);
  }
}

/** Register an incoming heartbeat ping (public /v1/heartbeat/:token route). */
export async function heartbeatPing(jobRow) {
  const job = rowToJob(jobRow);
  const now = Date.now();
  const nowIso = isoNow();

  const prevR = await db.execute({ sql: 'SELECT state FROM jobs WHERE id = ?', args: [job.id] });
  const prevState = prevR.rows[0]?.state || 'pending';

  await db.execute({
    sql: `UPDATE jobs SET last_ping_at = ?, last_run_at = ?, last_status = 'success', last_error_code = NULL, state = 'up', state_changed_at = ?, updated_at = ?,
            run_count = run_count + 1
          WHERE id = ?`,
    args: [now, now, prevState === 'up' ? (jobRow.state_changed_at || nowIso) : nowIso, nowIso, job.id],
  });

  const result = { status: 'success', status_code: null, duration_ms: 0, error: null, error_code: null, response_body: null, response_headers: null, timing: null };
  await logExecution(job, result, 1, 1);

  if (prevState === 'down') {
    // recovery: close incident + UP alert
    const incident = await getOngoingIncident(job.id);
    if (incident) {
      const durationSeconds = Math.max(0, Math.round((now - Date.parse(incident.started_at)) / 1000));
      await db.execute({
        sql: `UPDATE incidents SET ended_at = ?, duration_seconds = ? WHERE id = ?`,
        args: [nowIso, durationSeconds, incident.id],
      });
      if (!await isMaintenanceActive(job.id, job.owner_telegram_id) && job.alert_on_up) {
        await maybeAlertUp(job, { ...incident, ended_at: nowIso, duration_seconds: durationSeconds });
      }
    }
  }
  return { state: 'up', recovered: prevState === 'down' };
}

async function logExecution(job, result, attempt, maxAttempts, execId = null) {
  const finalExecId = execId || genId('exe_');
  const nowIso = new Date().toISOString();
  // history stores the first 4 KB of the body even when keyword checks read 256 KB
  let storedBody = result.response_body ?? null;
  if (storedBody && storedBody.length > STORE_BODY_BYTES) {
    storedBody = storedBody.slice(0, STORE_BODY_BYTES) + '…[truncated]';
  }
  try {
    await db.execute({
      sql: `INSERT INTO executions (id, job_id, attempt, status, status_code, duration_ms, started_at, finished_at, error, response_body, response_headers, timing, error_code, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        finalExecId,
        job.id,
        attempt,
        result.status,
        result.status_code,
        result.duration_ms,
        nowIso,
        nowIso,
        result.error,
        storedBody,
        result.response_headers ?? null,
        result.timing ? JSON.stringify(result.timing) : null,
        result.error_code ?? null,
        nowIso,
      ],
    });

    await db.execute({
      sql: `UPDATE jobs SET
              run_count = run_count + 1,
              fail_count = fail_count + (CASE WHEN ? = 'success' THEN 0 ELSE 1 END),
              consecutive_fails = (CASE WHEN ? = 'success' THEN 0 ELSE consecutive_fails + 1 END),
              last_status = ?,
              last_status_code = ?,
              last_duration_ms = ?,
              updated_at = ?
            WHERE id = ?`,
      args: [result.status, result.status, result.status, result.status_code, result.duration_ms, isoNow(), job.id],
    });

    // Trim history to HISTORY_LIMIT per job
    await db.execute({
      sql: `DELETE FROM executions WHERE job_id = ? AND id NOT IN (
              SELECT id FROM executions WHERE job_id = ? ORDER BY started_at DESC, created_at DESC LIMIT ?
            )`,
      args: [job.id, job.id, config.historyLimit],
    });
  } catch (e) {
    console.error(`[scheduler] log error for job ${job.id}:`, e.message);
  }
}

async function fireWebhook(url, payload) {
  try {
    await assertSafeUrl(url);
  } catch {
    console.error(`[webhook] blocked by SSRF protection: ${url}`);
    return;
  }
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'uptime-cron/1.2' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    console.error(`[webhook] failed for ${payload?.job_id || '?'}:`, e.message);
  }
}

/** Fire a single manual execution (no retries). Returns execution id. */
export function dispatchManual(job) {
  const execId = genId('exe_');
  (async () => {
    inflight++;
    try {
      const result = await runCheck(job);
      await logExecution(job, result, 1, 1, execId);
      await finalizeRun(job, result, 1);
    } catch (e) {
      console.error(`[manual] job ${job.id}:`, e.message);
    } finally {
      inflight--;
    }
  })();
  return execId;
}
