import { db, isoNow } from './db.js';
import { config } from './config.js';
import { computeNextRun } from './cron.js';
import { executeJob } from './executor.js';
import { genId } from './ids.js';

let ticking = false;
let inflight = 0;
let timer = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    save_responses: !!Number(row.save_responses),
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
    const slots = config.maxConcurrency - inflight;
    if (slots <= 0) return;
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
      sql: `UPDATE jobs SET enabled = 0, next_run_at = NULL, updated_at = ? WHERE id = ?`,
      args: [isoNow(), job.id],
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
    lastResult = await executeJob(job);
    await logExecution(job, lastResult, attempt, maxAttempts);

    if (lastResult.status === 'success') break;
    if (attempt < maxAttempts) await sleep(job.retry_interval * 1000);
  }

  if (lastResult && lastResult.status !== 'success') {
    await fireFailureWebhook(job, lastResult, maxAttempts);
  }
}

async function logExecution(job, result, attempt, maxAttempts, execId = null) {
  const finalExecId = execId || genId('exe_');
  const nowIso = new Date().toISOString();
  try {
    await db.execute({
      sql: `INSERT INTO executions (id, job_id, attempt, status, status_code, duration_ms, started_at, finished_at, error, response_body, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        result.response_body ?? null,
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

async function fireFailureWebhook(job, result, maxAttempts) {
  if (!job.failure_webhook) return;
  const payload = {
    event: 'job.failed',
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
      attempts_used: maxAttempts,
    },
  };
  try {
    await fetch(job.failure_webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'uptime-cron/1.0' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    console.error(`[webhook] failed for job ${job.id}:`, e.message);
  }
}

/** Fire a single manual execution (no retries). Returns execution id. */
export function dispatchManual(job) {
  const execId = genId('exe_');
  (async () => {
    inflight++;
    try {
      const result = await executeJob(job);
      await logExecution(job, result, 1, 1, execId);
    } catch (e) {
      console.error(`[manual] job ${job.id}:`, e.message);
    } finally {
      inflight--;
    }
  })();
  return execId;
}
