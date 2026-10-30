import { createClient } from '@libsql/client';
import { config } from './config.js';

export const db = createClient({
  url: config.tursoUrl,
  authToken: config.tursoToken || undefined,
});

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL UNIQUE,
    username TEXT,
    api_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    owner_telegram_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT 'GET',
    headers TEXT NOT NULL DEFAULT '{}',
    body TEXT,
    timeout INTEGER NOT NULL DEFAULT 30,
    schedule_kind TEXT NOT NULL DEFAULT 'cron',
    schedule_cron TEXT,
    schedule_input TEXT NOT NULL DEFAULT '',
    interval_seconds INTEGER,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    enabled INTEGER NOT NULL DEFAULT 1,
    expires_at INTEGER,
    next_run_at INTEGER,
    last_run_at INTEGER,
    last_status TEXT,
    last_status_code INTEGER,
    last_duration_ms INTEGER,
    run_count INTEGER NOT NULL DEFAULT 0,
    fail_count INTEGER NOT NULL DEFAULT 0,
    consecutive_fails INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 0,
    retry_interval INTEGER NOT NULL DEFAULT 60,
    failure_webhook TEXT,
    recovery_webhook TEXT,
    success_webhook TEXT,
    auto_disable_after INTEGER NOT NULL DEFAULT 0,
    follow_redirects INTEGER NOT NULL DEFAULT 1,
    redirect_is_success INTEGER NOT NULL DEFAULT 0,
    auth TEXT,
    folder TEXT,
    disabled_reason TEXT,
    save_responses INTEGER NOT NULL DEFAULT 1,
    tags TEXT NOT NULL DEFAULT '[]',
    type TEXT NOT NULL DEFAULT 'http',
    expected_status TEXT,
    keyword TEXT,
    keyword_mode TEXT,
    keyword_case_sensitive INTEGER NOT NULL DEFAULT 0,
    max_response_ms INTEGER,
    port INTEGER,
    ssl_expiry_days INTEGER NOT NULL DEFAULT 14,
    heartbeat_grace_seconds INTEGER NOT NULL DEFAULT 60,
    alert_contact_ids TEXT NOT NULL DEFAULT '[]',
    alert_on_down INTEGER NOT NULL DEFAULT 1,
    alert_on_up INTEGER NOT NULL DEFAULT 1,
    alert_after_minutes INTEGER NOT NULL DEFAULT 0,
    repeat_alert_minutes INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'pending',
    state_changed_at TEXT,
    last_error_code TEXT,
    heartbeat_token TEXT,
    last_ping_at INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_owner ON jobs(owner_telegram_id)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(enabled, next_run_at)`,
  `CREATE TABLE IF NOT EXISTS executions (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    status_code INTEGER,
    duration_ms INTEGER,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error TEXT,
    response_body TEXT,
    response_headers TEXT,
    timing TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_exec_job ON executions(job_id, started_at)`,
  // ---- v1.2.0 uptime monitoring tables ----
  `CREATE TABLE IF NOT EXISTS incidents (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    telegram_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    duration_seconds INTEGER,
    error_code TEXT,
    error_text TEXT,
    status_code INTEGER,
    down_alerted_at TEXT,
    up_alerted_at TEXT,
    last_alert_at TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_inc_job ON incidents(job_id, started_at)`,
  `CREATE TABLE IF NOT EXISTS alert_contacts (
    id TEXT PRIMARY KEY,
    telegram_id TEXT NOT NULL,
    type TEXT NOT NULL,
    target TEXT NOT NULL,
    name TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_contacts_owner ON alert_contacts(telegram_id)`,
  `CREATE TABLE IF NOT EXISTS maintenance_windows (
    id TEXT PRIMARY KEY,
    telegram_id TEXT NOT NULL,
    name TEXT,
    job_ids TEXT NOT NULL DEFAULT '[]',
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    recurrence TEXT NOT NULL DEFAULT 'none',
    weekday INTEGER,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS status_pages (
    id TEXT PRIMARY KEY,
    telegram_id TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    job_ids TEXT NOT NULL DEFAULT '[]',
    uptime_days INTEGER NOT NULL DEFAULT 30,
    message TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS job_daily (
    job_id TEXT NOT NULL,
    date TEXT NOT NULL,
    runs INTEGER NOT NULL DEFAULT 0,
    fails INTEGER NOT NULL DEFAULT 0,
    sum_ms INTEGER NOT NULL DEFAULT 0,
    p95_ms INTEGER,
    downtime_s INTEGER,
    PRIMARY KEY (job_id, date)
  )`,
  `CREATE TABLE IF NOT EXISTS job_rollup_state (
    job_id TEXT PRIMARY KEY,
    last_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS system_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS monitoring_gaps (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL
  )`,
];

// Columns added after v1.0.0 — applied to existing databases on boot.
const MIGRATIONS = [
  ['jobs', 'recovery_webhook', 'TEXT'],
  ['jobs', 'success_webhook', 'TEXT'],
  ['jobs', 'auto_disable_after', 'INTEGER NOT NULL DEFAULT 0'],
  ['jobs', 'follow_redirects', 'INTEGER NOT NULL DEFAULT 1'],
  ['jobs', 'redirect_is_success', 'INTEGER NOT NULL DEFAULT 0'],
  ['jobs', 'auth', 'TEXT'],
  ['jobs', 'folder', 'TEXT'],
  ['jobs', 'disabled_reason', 'TEXT'],
  ['executions', 'response_headers', 'TEXT'],
  ['executions', 'timing', 'TEXT'],
  // v1.2.0
  ['jobs', 'type', "TEXT NOT NULL DEFAULT 'http'"],
  ['jobs', 'expected_status', 'TEXT'],
  ['jobs', 'keyword', 'TEXT'],
  ['jobs', 'keyword_mode', "TEXT DEFAULT 'exists'"],
  ['jobs', 'keyword_case_sensitive', 'INTEGER NOT NULL DEFAULT 0'],
  ['jobs', 'max_response_ms', 'INTEGER'],
  ['jobs', 'port', 'INTEGER'],
  ['jobs', 'ssl_expiry_days', 'INTEGER NOT NULL DEFAULT 14'],
  ['jobs', 'heartbeat_grace_seconds', 'INTEGER NOT NULL DEFAULT 60'],
  ['jobs', 'alert_contact_ids', "TEXT NOT NULL DEFAULT '[]'"],
  ['jobs', 'alert_on_down', 'INTEGER NOT NULL DEFAULT 1'],
  ['jobs', 'alert_on_up', 'INTEGER NOT NULL DEFAULT 1'],
  ['jobs', 'alert_after_minutes', 'INTEGER NOT NULL DEFAULT 0'],
  ['jobs', 'repeat_alert_minutes', 'INTEGER NOT NULL DEFAULT 0'],
  ['jobs', 'state', "TEXT NOT NULL DEFAULT 'pending'"],
  ['jobs', 'state_changed_at', 'TEXT'],
  ['jobs', 'last_error_code', 'TEXT'],
  ['jobs', 'heartbeat_token', 'TEXT'],
  ['jobs', 'last_ping_at', 'INTEGER'],
  ['executions', 'error_code', 'TEXT'],
];

export async function initSchema() {
  for (const stmt of SCHEMA) {
    await db.execute(stmt);
  }
  for (const [table, col, def] of MIGRATIONS) {
    try {
      await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
      console.log(`[db] migrated: ${table}.${col} added`);
    } catch (e) {
      if (!/duplicate column|already exists/i.test(e.message || '')) throw e;
    }
  }
}

export const isoNow = () => new Date().toISOString();
