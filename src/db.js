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
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_exec_job ON executions(job_id, started_at)`,
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
