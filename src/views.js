import { humanSchedule } from './cron.js';

const jparse = (s, def) => {
  try {
    return JSON.parse(s ?? JSON.stringify(def));
  } catch {
    return def;
  }
};

const isoOrNull = (ms) => (ms ? new Date(Number(ms)).toISOString() : null);

export function userView(row, { withKey = false } = {}) {
  const u = {
    telegram_id: row.telegram_id,
    username: row.username || null,
    created_at: row.created_at,
  };
  if (withKey) u.api_key = row.api_key;
  if (row.job_count !== undefined) u.job_count = Number(row.job_count);
  return u;
}

export function jobView(row) {
  const schedule = {
    kind: row.schedule_kind,
    cron: row.schedule_cron || null,
    interval_seconds: row.interval_seconds != null ? Number(row.interval_seconds) : null,
    timezone: row.timezone,
    input: row.schedule_input,
    human: humanSchedule({
      kind: row.schedule_kind,
      cron: row.schedule_cron,
      interval_seconds: row.interval_seconds != null ? Number(row.interval_seconds) : null,
      input: row.schedule_input,
    }),
  };
  // basic auth is masked: password is never returned (stored safely, sent as header at runtime)
  let auth = null;
  try {
    const a = row.auth ? JSON.parse(row.auth) : null;
    if (a && a.type === 'basic') auth = { type: 'basic', username: a.username, password: '***' };
  } catch { auth = null; }
  // v1.2.0: header values are masked in GET output (send "***" on update to keep a value)
  const rawHeaders = jparse(row.headers, {});
  const headers = Object.fromEntries(Object.entries(rawHeaders).map(([k]) => [k, '***']));
  let expectedStatus = null;
  try { expectedStatus = row.expected_status ? JSON.parse(row.expected_status) : null; } catch { expectedStatus = null; }
  let alertContactIds = [];
  try { alertContactIds = row.alert_contact_ids ? JSON.parse(row.alert_contact_ids) : []; } catch { alertContactIds = []; }
  const type = row.type || 'http';
  return {
    id: row.id,
    title: row.title || '',
    telegram_id: row.owner_telegram_id,
    type,
    url: row.url || null,
    method: row.method,
    headers,
    body: row.body ?? null,
    timeout: Number(row.timeout),
    schedule,
    enabled: !!Number(row.enabled),
    tags: jparse(row.tags, []),
    max_retries: Number(row.max_retries),
    retry_interval: Number(row.retry_interval),
    failure_webhook: row.failure_webhook || null,
    recovery_webhook: row.recovery_webhook || null,
    success_webhook: row.success_webhook || null,
    auto_disable_after: row.auto_disable_after != null ? Number(row.auto_disable_after) : 0,
    follow_redirects: row.follow_redirects != null ? !!Number(row.follow_redirects) : true,
    redirect_is_success: row.redirect_is_success != null ? !!Number(row.redirect_is_success) : false,
    auth,
    folder: row.folder || null,
    disabled_reason: row.disabled_reason || null,
    save_responses: !!Number(row.save_responses),
    // v1.2.0 monitoring fields
    expected_status: expectedStatus,
    keyword: row.keyword || null,
    keyword_mode: row.keyword_mode || 'exists',
    keyword_case_sensitive: row.keyword_case_sensitive != null ? !!Number(row.keyword_case_sensitive) : false,
    max_response_ms: row.max_response_ms != null ? Number(row.max_response_ms) : null,
    port: row.port != null ? Number(row.port) : null,
    ssl_expiry_days: row.ssl_expiry_days != null ? Number(row.ssl_expiry_days) : 14,
    heartbeat_grace_seconds: row.heartbeat_grace_seconds != null ? Number(row.heartbeat_grace_seconds) : 60,
    heartbeat_url: type === 'heartbeat' && row.heartbeat_token ? `${process.env.RENDER_EXTERNAL_URL?.replace(/\/$/, '') || 'https://uptime-cron.onrender.com'}/v1/heartbeat/${row.heartbeat_token}` : null,
    alert_contact_ids: alertContactIds,
    alert_on_down: row.alert_on_down != null ? !!Number(row.alert_on_down) : true,
    alert_on_up: row.alert_on_up != null ? !!Number(row.alert_on_up) : true,
    alert_after_minutes: row.alert_after_minutes != null ? Number(row.alert_after_minutes) : 0,
    repeat_alert_minutes: row.repeat_alert_minutes != null ? Number(row.repeat_alert_minutes) : 0,
    state: row.state || 'pending',
    state_changed_at: row.state_changed_at || null,
    last_error_code: row.last_error_code || null,
    expires_at: isoOrNull(row.expires_at),
    next_run_at: Number(row.enabled) ? isoOrNull(row.next_run_at) : null,
    last_run_at: isoOrNull(row.last_run_at),
    last_status: row.last_status || null,
    last_status_code: row.last_status_code != null ? Number(row.last_status_code) : null,
    last_duration_ms: row.last_duration_ms != null ? Number(row.last_duration_ms) : null,
    run_count: Number(row.run_count),
    fail_count: Number(row.fail_count),
    consecutive_fails: Number(row.consecutive_fails),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function executionView(row, { withBody = false } = {}) {
  const e = {
    id: row.id,
    job_id: row.job_id,
    attempt: Number(row.attempt),
    status: row.status,
    status_code: row.status_code != null ? Number(row.status_code) : null,
    duration_ms: row.duration_ms != null ? Number(row.duration_ms) : null,
    error_code: row.error_code || null,
    started_at: row.started_at,
    finished_at: row.finished_at || null,
    error: row.error || null,
  };
  if (withBody) {
    e.response_body = row.response_body ?? null;
    e.response_headers = row.response_headers != null ? jparse(row.response_headers, null) : null;
    e.timing = row.timing != null ? jparse(row.timing, null) : null;
  }
  return e;
}

export function incidentView(row) {
  return {
    id: row.id,
    job_id: row.job_id,
    telegram_id: row.telegram_id,
    started_at: row.started_at,
    ended_at: row.ended_at || null,
    duration_seconds: row.duration_seconds != null ? Number(row.duration_seconds) : null,
    ongoing: !row.ended_at,
    error_code: row.error_code || null,
    error_text: row.error_text || null,
    status_code: row.status_code != null ? Number(row.status_code) : null,
  };
}

export function contactView(row) {
  return {
    id: row.id,
    telegram_id: row.telegram_id,
    type: row.type,
    target: row.target,
    name: row.name || null,
    enabled: !!Number(row.enabled),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function lastExecutionSummary(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    status_code: row.status_code != null ? Number(row.status_code) : null,
    duration_ms: row.duration_ms != null ? Number(row.duration_ms) : null,
    started_at: row.started_at,
  };
}
