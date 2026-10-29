import { Router } from 'express';
import { db, isoNow } from '../db.js';
import { err, ok, asyncH } from '../errors.js';
import { genApiKey } from '../ids.js';
import { vTelegramId, vString } from '../validate.js';
import { userView } from '../views.js';

const router = Router();

// All /v1/users routes are dev-only (middleware applied at mount time)

router.post('/', asyncH(async (req, res) => {
  const body = req.body || {};
  const telegram_id = vTelegramId(body.telegram_id);
  const username = vString(body.username, 'username', { max: 64 });

  const exists = await db.execute({ sql: 'SELECT * FROM users WHERE telegram_id = ?', args: [telegram_id] });
  if (exists.rows.length) throw err.userExists();

  const now = isoNow();
  await db.execute({
    sql: `INSERT INTO users (telegram_id, username, api_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    args: [telegram_id, username || null, genApiKey(), now, now],
  });
  const row = await db.execute({ sql: 'SELECT * FROM users WHERE telegram_id = ?', args: [telegram_id] });
  ok(res, { user: userView(row.rows[0], { withKey: true }) }, 201);
}));

router.get('/', asyncH(async (req, res) => {
  const rows = await db.execute({
    sql: `SELECT u.*, (SELECT COUNT(*) FROM jobs j WHERE j.owner_telegram_id = u.telegram_id) AS job_count
          FROM users u ORDER BY u.created_at DESC LIMIT 200`,
    args: [],
  });
  ok(res, { users: rows.rows.map((r) => userView(r)) });
}));

router.get('/:telegram_id', asyncH(async (req, res) => {
  const tid = String(req.params.telegram_id || '');
  const r = await db.execute({
    sql: `SELECT u.*, (SELECT COUNT(*) FROM jobs j WHERE j.owner_telegram_id = u.telegram_id) AS job_count
          FROM users u WHERE u.telegram_id = ?`,
    args: [tid],
  });
  if (!r.rows.length) throw err.userNotFound();
  const jobs = await db.execute({
    sql: `SELECT id, title, enabled, last_status, next_run_at FROM jobs WHERE owner_telegram_id = ? ORDER BY created_at DESC LIMIT 100`,
    args: [tid],
  });
  ok(res, { user: userView(r.rows[0]), jobs: jobs.rows });
}));

router.delete('/:telegram_id', asyncH(async (req, res) => {
  const tid = String(req.params.telegram_id || '');
  const r = await db.execute({ sql: 'SELECT * FROM users WHERE telegram_id = ?', args: [tid] });
  if (!r.rows.length) throw err.userNotFound();

  const jobCount = await db.execute({ sql: 'SELECT COUNT(*) AS c FROM jobs WHERE owner_telegram_id = ?', args: [tid] });
  await db.execute({ sql: `DELETE FROM executions WHERE job_id IN (SELECT id FROM jobs WHERE owner_telegram_id = ?)`, args: [tid] });
  await db.execute({ sql: 'DELETE FROM jobs WHERE owner_telegram_id = ?', args: [tid] });
  await db.execute({ sql: 'DELETE FROM users WHERE telegram_id = ?', args: [tid] });
  ok(res, { deleted: { user: true, telegram_id: tid, jobs: Number(jobCount.rows[0].c) } });
}));

router.post('/:telegram_id/regenerate-key', asyncH(async (req, res) => {
  const tid = String(req.params.telegram_id || '');
  const r = await db.execute({ sql: 'SELECT * FROM users WHERE telegram_id = ?', args: [tid] });
  if (!r.rows.length) throw err.userNotFound();
  const newKey = genApiKey();
  await db.execute({ sql: 'UPDATE users SET api_key = ?, updated_at = ? WHERE telegram_id = ?', args: [newKey, isoNow(), tid] });
  ok(res, { telegram_id: tid, api_key: newKey, note: 'Old key is now invalid' });
}));

export default router;
