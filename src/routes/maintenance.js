import { Router } from 'express';
import { db, isoNow } from '../db.js';
import { err, ok, asyncH } from '../errors.js';
import { genId } from '../ids.js';
import { vString, vRecurrence, vHHMM, vTelegramId } from '../validate.js';
import { isValidTimezone } from '../cron.js';
import { incidentView } from '../views.js';

const router = Router();

function scope(req, bodyTid = undefined) {
  if (req.auth.mode === 'dev') {
    return bodyTid !== undefined ? String(bodyTid) : null;
  }
  return req.auth.user.telegram_id;
}

async function validateJobIds(jobIds, telegram_id) {
  if (!Array.isArray(jobIds)) throw err.validation('job_ids must be an array of job ids');
  if (jobIds.length > 100) throw err.validation('job_ids supports at most 100 entries');
  for (const id of jobIds) {
    if (typeof id !== 'string' || !id.startsWith('job_')) throw err.validation(`job_ids entry "${id}" is not a job id`);
  }
  if (jobIds.length) {
    const ph = jobIds.map(() => '?').join(',');
    const owned = await db.execute({
      sql: `SELECT COUNT(*) AS c FROM jobs WHERE id IN (${ph}) AND owner_telegram_id = ?`,
      args: [...jobIds, telegram_id],
    });
    if (Number(owned.rows[0].c) !== jobIds.length) {
      throw err.validation('job_ids contains a job that does not exist or belongs to another user');
    }
  }
  return JSON.stringify(jobIds);
}

router.post('/', asyncH(async (req, res) => {
  const body = req.body || {};
  const telegram_id = scope(req, body.telegram_id);
  if (!telegram_id) throw err.validation('telegram_id is required when using the dev key');

  const name = vString(body.name, 'name', { max: 80 });
  const recurrence = vRecurrence(body.recurrence);
  const timezone = body.timezone || 'UTC';
  if (!isValidTimezone(timezone)) throw err.validation(`Unknown timezone: "${timezone}"`);
  const job_ids = await validateJobIds(body.job_ids || [], telegram_id);

  let start_at, end_at, weekday = null;
  if (recurrence === 'none') {
    const sMs = Date.parse(body.start_at);
    const eMs = Date.parse(body.end_at);
    if (!Number.isFinite(sMs) || !Number.isFinite(eMs)) throw err.validation('start_at and end_at must be valid ISO 8601 datetimes for recurrence "none"');
    if (eMs <= sMs) throw err.validation('end_at must be after start_at');
    start_at = new Date(sMs).toISOString();
    end_at = new Date(eMs).toISOString();
  } else {
    start_at = vHHMM(body.start_at, 'start_at');
    end_at = vHHMM(body.end_at, 'end_at');
    if (recurrence === 'weekly') {
      if (body.weekday === undefined) throw err.validation('weekday (0=Sun..6=Sat) is required for weekly recurrence');
      const wd = Number(body.weekday);
      if (!Number.isInteger(wd) || wd < 0 || wd > 6) throw err.validation('weekday must be 0-6 (0=Sunday)');
      weekday = wd;
    }
  }

  const id = genId('mnt_');
  const now = isoNow();
  await db.execute({
    sql: `INSERT INTO maintenance_windows (id, telegram_id, name, job_ids, start_at, end_at, recurrence, weekday, timezone, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, telegram_id, name || null, job_ids, start_at, end_at, recurrence, weekday, timezone, now, now],
  });
  const row = await db.execute({ sql: 'SELECT * FROM maintenance_windows WHERE id = ?', args: [id] });
  ok(res, { maintenance: maintenanceView(row.rows[0]) }, 201);
}));

function maintenanceView(row) {
  return {
    id: row.id,
    telegram_id: row.telegram_id,
    name: row.name || null,
    job_ids: (() => { try { return JSON.parse(row.job_ids || '[]'); } catch { return []; } })(),
    start_at: row.start_at,
    end_at: row.end_at,
    recurrence: row.recurrence,
    weekday: row.weekday != null ? Number(row.weekday) : null,
    timezone: row.timezone,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

router.get('/', asyncH(async (req, res) => {
  const q = req.query || {};
  const telegram_id = scope(req, q.telegram_id);
  let sql = 'SELECT * FROM maintenance_windows';
  const args = [];
  if (telegram_id) { sql += ' WHERE telegram_id = ?'; args.push(telegram_id); }
  sql += ' ORDER BY created_at DESC LIMIT 200';
  const rows = await db.execute({ sql, args });
  ok(res, { maintenance_windows: rows.rows.map(maintenanceView) });
}));

router.get('/:id', asyncH(async (req, res) => {
  const telegram_id = scope(req);
  const r = await db.execute({ sql: 'SELECT * FROM maintenance_windows WHERE id = ?', args: [req.params.id] });
  if (!r.rows.length || (telegram_id && r.rows[0].telegram_id !== telegram_id)) throw err.maintenanceNotFound();
  ok(res, { maintenance: maintenanceView(r.rows[0]) });
}));

router.patch('/:id', asyncH(async (req, res) => {
  const telegram_id = scope(req);
  const r = await db.execute({ sql: 'SELECT * FROM maintenance_windows WHERE id = ?', args: [req.params.id] });
  if (!r.rows.length || (telegram_id && r.rows[0].telegram_id !== telegram_id)) throw err.maintenanceNotFound();
  const win = r.rows[0];
  const body = req.body || {};

  const sets = [];
  const args = [];
  if (body.name !== undefined) { sets.push('name = ?'); args.push(vString(body.name, 'name', { max: 80 }) || null); }
  if (body.job_ids !== undefined) { sets.push('job_ids = ?'); args.push(await validateJobIds(body.job_ids, win.telegram_id)); }
  if (body.timezone !== undefined) {
    if (!isValidTimezone(body.timezone)) throw err.validation(`Unknown timezone: "${body.timezone}"`);
    sets.push('timezone = ?'); args.push(body.timezone);
  }
  if (body.recurrence !== undefined) { sets.push('recurrence = ?'); args.push(vRecurrence(body.recurrence)); }

  const recurrence = body.recurrence !== undefined ? vRecurrence(body.recurrence) : win.recurrence;
  if (body.start_at !== undefined || recurrence !== win.recurrence) {
    if (recurrence === 'none') {
      const s = body.start_at !== undefined ? body.start_at : win.start_at;
      const parsed = Date.parse(s);
      if (!Number.isFinite(parsed)) throw err.validation('start_at must be a valid ISO 8601 datetime for recurrence "none"');
      sets.push('start_at = ?'); args.push(new Date(parsed).toISOString());
    } else {
      sets.push('start_at = ?'); args.push(vHHMM(body.start_at !== undefined ? body.start_at : win.start_at, 'start_at'));
    }
  }
  if (body.end_at !== undefined || recurrence !== win.recurrence) {
    if (recurrence === 'none') {
      const e = body.end_at !== undefined ? body.end_at : win.end_at;
      const parsed = Date.parse(e);
      if (!Number.isFinite(parsed)) throw err.validation('end_at must be a valid ISO 8601 datetime for recurrence "none"');
      sets.push('end_at = ?'); args.push(new Date(parsed).toISOString());
    } else {
      sets.push('end_at = ?'); args.push(vHHMM(body.end_at !== undefined ? body.end_at : win.end_at, 'end_at'));
    }
  }
  if (recurrence === 'weekly' && body.weekday !== undefined) {
    const wd = Number(body.weekday);
    if (!Number.isInteger(wd) || wd < 0 || wd > 6) throw err.validation('weekday must be 0-6 (0=Sunday)');
    sets.push('weekday = ?'); args.push(wd);
  }

  if (sets.length) {
    sets.push('updated_at = ?');
    args.push(isoNow(), win.id);
    await db.execute({ sql: `UPDATE maintenance_windows SET ${sets.join(', ')} WHERE id = ?`, args });
  }
  const row = await db.execute({ sql: 'SELECT * FROM maintenance_windows WHERE id = ?', args: [win.id] });
  ok(res, { maintenance: maintenanceView(row.rows[0]) });
}));

router.delete('/:id', asyncH(async (req, res) => {
  const telegram_id = scope(req);
  const r = await db.execute({ sql: 'SELECT * FROM maintenance_windows WHERE id = ?', args: [req.params.id] });
  if (!r.rows.length || (telegram_id && r.rows[0].telegram_id !== telegram_id)) throw err.maintenanceNotFound();
  await db.execute({ sql: 'DELETE FROM maintenance_windows WHERE id = ?', args: [r.rows[0].id] });
  ok(res, { deleted: true, id: r.rows[0].id });
}));

export { maintenanceView };
export default router;
