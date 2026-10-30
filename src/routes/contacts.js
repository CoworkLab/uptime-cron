import { Router } from 'express';
import { db, isoNow } from '../db.js';
import { config } from '../config.js';
import { err, ok, asyncH } from '../errors.js';
import { genId } from '../ids.js';
import { vString, vContactType, vContactTarget, vBool } from '../validate.js';
import { assertSafeUrl } from '../ssrf.js';
import { contactView } from '../views.js';
import { sendTestAlert } from '../notifier.js';

const router = Router();

function scope(req, bodyTid = undefined) {
  if (req.auth.mode === 'dev') {
    return bodyTid !== undefined ? String(bodyTid) : null; // null = all
  }
  return req.auth.user.telegram_id;
}

router.post('/', asyncH(async (req, res) => {
  const body = req.body || {};
  const telegram_id = scope(req, body.telegram_id);
  if (!telegram_id) throw err.validation('telegram_id is required when using the dev key');
  const type = vContactType(body.type);
  const target = vContactTarget(type, body.target);
  const name = vString(body.name, 'name', { max: 60 });
  if (type === 'webhook' || type === 'discord' || type === 'slack') {
    await assertSafeUrl(target); // SSRF on contact targets
  }

  const countR = await db.execute({ sql: 'SELECT COUNT(*) AS c FROM alert_contacts WHERE telegram_id = ?', args: [telegram_id] });
  if (Number(countR.rows[0].c) >= config.userContactLimit) {
    throw err.validation(`Contact limit reached (${config.userContactLimit}). Delete a contact first`);
  }

  const id = genId('con_');
  const now = isoNow();
  await db.execute({
    sql: `INSERT INTO alert_contacts (id, telegram_id, type, target, name, enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    args: [id, telegram_id, type, target, name || null, now, now],
  });
  const row = await db.execute({ sql: 'SELECT * FROM alert_contacts WHERE id = ?', args: [id] });
  ok(res, { contact: contactView(row.rows[0]) }, 201);
}));

router.get('/', asyncH(async (req, res) => {
  const q = req.query || {};
  const telegram_id = scope(req, q.telegram_id);
  let sql = 'SELECT * FROM alert_contacts';
  const args = [];
  if (telegram_id) { sql += ' WHERE telegram_id = ?'; args.push(telegram_id); }
  sql += ' ORDER BY created_at ASC LIMIT 200';
  const rows = await db.execute({ sql, args });
  ok(res, { contacts: rows.rows.map(contactView) });
}));

router.get('/:id', asyncH(async (req, res) => {
  const telegram_id = scope(req);
  const r = await db.execute({ sql: 'SELECT * FROM alert_contacts WHERE id = ?', args: [req.params.id] });
  if (!r.rows.length || (telegram_id && r.rows[0].telegram_id !== telegram_id)) throw err.contactNotFound();
  ok(res, { contact: contactView(r.rows[0]) });
}));

router.patch('/:id', asyncH(async (req, res) => {
  const telegram_id = scope(req);
  const r = await db.execute({ sql: 'SELECT * FROM alert_contacts WHERE id = ?', args: [req.params.id] });
  if (!r.rows.length || (telegram_id && r.rows[0].telegram_id !== telegram_id)) throw err.contactNotFound();
  const contact = r.rows[0];
  const body = req.body || {};
  const sets = [];
  const args = [];
  if (body.name !== undefined) { sets.push('name = ?'); args.push(vString(body.name, 'name', { max: 60 }) || null); }
  if (body.target !== undefined) {
    const target = vContactTarget(contact.type, body.target);
    if (contact.type === 'webhook' || contact.type === 'discord' || contact.type === 'slack') await assertSafeUrl(target);
    sets.push('target = ?'); args.push(target);
  }
  if (body.enabled !== undefined) { sets.push('enabled = ?'); args.push(vBool(body.enabled, true) ? 1 : 0); }
  if (sets.length) {
    sets.push('updated_at = ?'); args.push(isoNow(), contact.id);
    await db.execute({ sql: `UPDATE alert_contacts SET ${sets.join(', ')} WHERE id = ?`, args });
  }
  const row = await db.execute({ sql: 'SELECT * FROM alert_contacts WHERE id = ?', args: [contact.id] });
  ok(res, { contact: contactView(row.rows[0]) });
}));

router.delete('/:id', asyncH(async (req, res) => {
  const telegram_id = scope(req);
  const r = await db.execute({ sql: 'SELECT * FROM alert_contacts WHERE id = ?', args: [req.params.id] });
  if (!r.rows.length || (telegram_id && r.rows[0].telegram_id !== telegram_id)) throw err.contactNotFound();
  await db.execute({ sql: 'DELETE FROM alert_contacts WHERE id = ?', args: [r.rows[0].id] });
  ok(res, { deleted: true, id: r.rows[0].id });
}));

router.post('/:id/test', asyncH(async (req, res) => {
  const telegram_id = scope(req);
  const r = await db.execute({ sql: 'SELECT * FROM alert_contacts WHERE id = ?', args: [req.params.id] });
  if (!r.rows.length || (telegram_id && r.rows[0].telegram_id !== telegram_id)) throw err.contactNotFound();
  const result = await sendTestAlert(r.rows[0]);
  ok(res, {
    contact_id: r.rows[0].id,
    delivered: result.ok,
    detail: result.ok ? 'Test alert sent' : (result.error || 'Delivery failed'),
  });
}));

export default router;
