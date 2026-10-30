import { Router } from 'express';
import { db, isoNow } from '../db.js';
import { err, ok, asyncH } from '../errors.js';
import { genId } from '../ids.js';
import { vString, vSlug, vInt, vBool } from '../validate.js';
import { RANGES, jobUptime } from '../uptime.js';

const router = Router();

function scope(req, bodyTid = undefined) {
  if (req.auth.mode === 'dev') {
    return bodyTid !== undefined ? String(bodyTid) : null;
  }
  return req.auth.user.telegram_id;
}

function pageView(row) {
  return {
    id: row.id,
    telegram_id: row.telegram_id,
    slug: row.slug,
    title: row.title,
    job_ids: (() => { try { return JSON.parse(row.job_ids || '[]'); } catch { return []; } })(),
    uptime_days: row.uptime_days != null ? Number(row.uptime_days) : 30,
    message: row.message || null,
    enabled: !!Number(row.enabled),
    public_url: `/status/${row.slug}`,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

router.post('/', asyncH(async (req, res) => {
  const body = req.body || {};
  const telegram_id = scope(req, body.telegram_id);
  if (!telegram_id) throw err.validation('telegram_id is required when using the dev key');

  const slug = vSlug(body.slug);
  const title = vString(body.title, 'title', { max: 120, required: true, allowEmpty: false });
  const message = vString(body.message, 'message', { max: 300 });
  const uptimeDays = body.uptime_days === undefined ? 30 : vInt(body.uptime_days, 'uptime_days', { min: 1, max: 365, def: 30 });
  const enabled = vBool(body.enabled, true);

  let jobIds = body.job_ids || [];
  if (!Array.isArray(jobIds)) throw err.validation('job_ids must be an array of job ids');
  if (jobIds.length > 100) throw err.validation('job_ids supports at most 100 entries');
  jobIds = [...new Set(jobIds.map(String))];
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

  const exists = await db.execute({ sql: 'SELECT id FROM status_pages WHERE slug = ?', args: [slug] });
  if (exists.rows.length) throw err.slugTaken();

  const id = genId('stp_');
  const now = isoNow();
  await db.execute({
    sql: `INSERT INTO status_pages (id, telegram_id, slug, title, job_ids, uptime_days, message, enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, telegram_id, slug, title, JSON.stringify(jobIds), uptimeDays, message || null, enabled ? 1 : 0, now, now],
  });
  const row = await db.execute({ sql: 'SELECT * FROM status_pages WHERE id = ?', args: [id] });
  ok(res, { status_page: pageView(row.rows[0]) }, 201);
}));

router.get('/', asyncH(async (req, res) => {
  const q = req.query || {};
  const telegram_id = scope(req, q.telegram_id);
  let sql = 'SELECT * FROM status_pages';
  const args = [];
  if (telegram_id) { sql += ' WHERE telegram_id = ?'; args.push(telegram_id); }
  sql += ' ORDER BY created_at DESC LIMIT 100';
  const rows = await db.execute({ sql, args });
  ok(res, { status_pages: rows.rows.map(pageView) });
}));

router.get('/:id', asyncH(async (req, res) => {
  const telegram_id = scope(req);
  const r = await db.execute({ sql: 'SELECT * FROM status_pages WHERE id = ?', args: [req.params.id] });
  if (!r.rows.length || (telegram_id && r.rows[0].telegram_id !== telegram_id)) throw err.statusPageNotFound();
  ok(res, { status_page: pageView(r.rows[0]) });
}));

router.patch('/:id', asyncH(async (req, res) => {
  const telegram_id = scope(req);
  const r = await db.execute({ sql: 'SELECT * FROM status_pages WHERE id = ?', args: [req.params.id] });
  if (!r.rows.length || (telegram_id && r.rows[0].telegram_id !== telegram_id)) throw err.statusPageNotFound();
  const page = r.rows[0];
  const body = req.body || {};
  const sets = [];
  const args = [];
  if (body.title !== undefined) { sets.push('title = ?'); args.push(vString(body.title, 'title', { max: 120, required: true, allowEmpty: false })); }
  if (body.message !== undefined) { sets.push('message = ?'); args.push(vString(body.message, 'message', { max: 300 }) || null); }
  if (body.uptime_days !== undefined) { sets.push('uptime_days = ?'); args.push(vInt(body.uptime_days, 'uptime_days', { min: 1, max: 365, def: 30 })); }
  if (body.enabled !== undefined) { sets.push('enabled = ?'); args.push(vBool(body.enabled, true) ? 1 : 0); }
  if (body.slug !== undefined) {
    const slug = vSlug(body.slug);
    if (slug !== page.slug) {
      const exists = await db.execute({ sql: 'SELECT id FROM status_pages WHERE slug = ?', args: [slug] });
      if (exists.rows.length) throw err.slugTaken();
      sets.push('slug = ?'); args.push(slug);
    }
  }
  if (body.job_ids !== undefined) {
    let jobIds = body.job_ids;
    if (!Array.isArray(jobIds)) throw err.validation('job_ids must be an array of job ids');
    if (jobIds.length > 100) throw err.validation('job_ids supports at most 100 entries');
    jobIds = [...new Set(jobIds.map(String))];
    if (jobIds.length) {
      const ph = jobIds.map(() => '?').join(',');
      const owned = await db.execute({
        sql: `SELECT COUNT(*) AS c FROM jobs WHERE id IN (${ph}) AND owner_telegram_id = ?`,
        args: [...jobIds, page.telegram_id],
      });
      if (Number(owned.rows[0].c) !== jobIds.length) {
        throw err.validation('job_ids contains a job that does not exist or belongs to another user');
      }
    }
    sets.push('job_ids = ?'); args.push(JSON.stringify(jobIds));
  }
  if (sets.length) {
    sets.push('updated_at = ?');
    args.push(isoNow(), page.id);
    await db.execute({ sql: `UPDATE status_pages SET ${sets.join(', ')} WHERE id = ?`, args });
  }
  const row = await db.execute({ sql: 'SELECT * FROM status_pages WHERE id = ?', args: [page.id] });
  ok(res, { status_page: pageView(row.rows[0]) });
}));

router.delete('/:id', asyncH(async (req, res) => {
  const telegram_id = scope(req);
  const r = await db.execute({ sql: 'SELECT * FROM status_pages WHERE id = ?', args: [req.params.id] });
  if (!r.rows.length || (telegram_id && r.rows[0].telegram_id !== telegram_id)) throw err.statusPageNotFound();
  await db.execute({ sql: 'DELETE FROM status_pages WHERE id = ?', args: [r.rows[0].id] });
  ok(res, { deleted: true, id: r.rows[0].id });
}));

export { pageView };
export default router;

// ===================== public page data + rendering =====================

export async function statusPageData(page) {
  let jobIds = [];
  try { jobIds = JSON.parse(page.job_ids || '[]'); } catch { jobIds = []; }
  let jobs;
  if (jobIds.length) {
    const ph = jobIds.map(() => '?').join(',');
    jobs = (await db.execute({
      sql: `SELECT * FROM jobs WHERE id IN (${ph}) AND owner_telegram_id = ? AND enabled = 1 ORDER BY created_at ASC LIMIT 100`,
      args: [...jobIds, page.telegram_id],
    })).rows;
  } else {
    jobs = (await db.execute({
      sql: 'SELECT * FROM jobs WHERE owner_telegram_id = ? AND enabled = 1 ORDER BY created_at ASC LIMIT 100',
      args: [page.telegram_id],
    })).rows;
  }

  const rangeSeconds = RANGES[`${page.uptime_days}d`] || RANGES['30d'];
  const jobData = [];
  for (const j of jobs) {
    const state = j.state || 'pending';
    const u = await jobUptime(j, rangeSeconds);
    // daily bars (green/red/gray) from job_daily + incidents
    const daily = (await db.execute({
      sql: `SELECT date, runs, fails FROM job_daily WHERE job_id = ? AND date >= ? ORDER BY date ASC`,
      args: [j.id, new Date(Date.now() - rangeSeconds * 1000).toISOString().slice(0, 10)],
    })).rows;
    const bars = [];
    const byDay = new Map(daily.map((d) => [d.date, d]));
    for (let i = page.uptime_days - 1; i >= 0; i--) {
      const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const d = byDay.get(date);
      bars.push({ date, ok: d ? Number(d.fails) === 0 : null, runs: d ? Number(d.runs) : 0 });
    }
    jobData.push({
      title: j.title || 'Untitled check',
      state,
      uptime_percent: state === 'pending' ? null : u.uptime_percent,
      bars,
    });
  }

  const scopeIds = jobIds.length ? jobIds : null;
  let incidents;
  if (scopeIds) {
    const ph = scopeIds.map(() => '?').join(',');
    incidents = (await db.execute({
      sql: `SELECT i.* FROM incidents i JOIN jobs j ON j.id = i.job_id
            WHERE i.job_id IN (${ph}) AND i.started_at >= ?
            ORDER BY i.started_at DESC LIMIT 20`,
      args: [...scopeIds, new Date(Date.now() - 30 * 86400000).toISOString()],
    })).rows;
  } else {
    incidents = (await db.execute({
      sql: `SELECT * FROM incidents WHERE telegram_id = ? AND started_at >= ? ORDER BY started_at DESC LIMIT 20`,
      args: [page.telegram_id, new Date(Date.now() - 30 * 86400000).toISOString()],
    })).rows;
  }

  const maintenance = (await db.execute({
    sql: 'SELECT * FROM maintenance_windows WHERE telegram_id = ?',
    args: [page.telegram_id],
  })).rows;

  const anyDown = jobData.some((j) => j.state === 'down');
  const allUp = jobData.length > 0 && jobData.every((j) => j.state === 'up');
  const overall = jobData.length === 0 ? 'unknown' : anyDown ? 'down' : allUp ? 'up' : 'pending';

  return {
    slug: page.slug,
    title: page.title,
    message: page.message,
    overall,
    jobs: jobData,
    incidents: incidents.map((i) => ({
      job_title: (jobs.find((j) => j.id === i.job_id) || {}).title || 'Check',
      started_at: i.started_at,
      ended_at: i.ended_at,
      duration_seconds: i.duration_seconds != null ? Number(i.duration_seconds) : null,
      error_code: i.error_code || null,
    })),
    maintenance: maintenance.map((m) => ({
      name: m.name || 'Maintenance',
      recurrence: m.recurrence,
      start_at: m.start_at,
      end_at: m.end_at,
    })),
  };
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderStatusHtml(data) {
  const badge = (state) => {
    const cls = state === 'up' ? 'ok' : state === 'down' ? 'bad' : state === 'paused' ? 'pause' : 'pend';
    const label = state === 'up' ? 'UP' : state === 'down' ? 'DOWN' : state === 'paused' ? 'PAUSED' : 'PENDING';
    return `<span class="badge ${cls}">${label}</span>`;
  };
  const bannerCls = data.overall === 'up' ? 'ok' : data.overall === 'down' ? 'bad' : 'pend';
  const bannerText = data.overall === 'up' ? 'All Systems Operational'
    : data.overall === 'down' ? 'Partial Outage'
    : data.overall === 'pending' ? 'Awaiting first checks' : 'No monitors on this page';

  const jobCards = data.jobs.map((j) => `
    <div class="job">
      <div class="job-head"><span class="job-title">${esc(j.title)}</span>${badge(j.state)}</div>
      <div class="bars">${j.bars.map((b) => `<span class="bar ${b.ok === true ? 'ok' : b.ok === false ? 'bad' : 'nodata'}" title="${b.date}${b.runs ? ` (${b.runs} checks)` : ''}"></span>`).join('')}</div>
      <div class="job-meta"><span>${j.uptime_percent != null ? `${j.uptime_percent}% uptime` : 'no uptime data yet'}</span></div>
    </div>`).join('');

  const incRows = data.incidents.length
    ? data.incidents.map((i) => `
      <div class="incident">
        <div class="inc-head">${esc(i.job_title)} <span class="err">${esc(i.error_code || '')}</span></div>
        <div class="inc-meta">${esc(i.started_at.replace('T', ' ').slice(0, 16))} UTC
          ${i.ended_at ? `— resolved in ${i.duration_seconds != null ? Math.round(i.duration_seconds / 60) : '?'} min` : '— <b>ongoing</b>'}</div>
      </div>`).join('')
    : '<p class="muted">No incidents in the last 30 days.</p>';

  const maint = data.maintenance.length
    ? `<h2>Maintenance</h2>${data.maintenance.map((m) => `<div class="incident"><div class="inc-head">${esc(m.name)}</div><div class="inc-meta">${esc(m.recurrence)} · ${esc(m.start_at)} → ${esc(m.end_at)}</div></div>`).join('')}`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(data.title)} — Status</title>
<style>
  :root { --bg:#f5f7fa; --card:#ffffff; --text:#1a2233; --muted:#66708a; --ok:#16a34a; --bad:#dc2626; --pend:#d97706; --pause:#64748b; --bar:#e5e9f0; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0d1117; --card:#161b22; --text:#e6edf3; --muted:#8b949e; --ok:#2ea043; --bad:#f85149; --pend:#d29922; --pause:#64748b; --bar:#21262d; }
  }
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:var(--bg); color:var(--text); }
  .wrap { max-width:760px; margin:0 auto; padding:24px 16px 60px; }
  h1 { font-size:1.5rem; margin:0 0 4px; }
  .message { color:var(--muted); margin:0 0 20px; }
  .banner { padding:14px 18px; border-radius:10px; font-weight:600; margin-bottom:24px; color:#fff; }
  .banner.ok { background:var(--ok); } .banner.bad { background:var(--bad); } .banner.pend { background:var(--pend); }
  .job { background:var(--card); border-radius:10px; padding:14px 16px; margin-bottom:12px; box-shadow:0 1px 3px rgba(0,0,0,.08); }
  .job-head { display:flex; justify-content:space-between; align-items:center; gap:10px; }
  .job-title { font-weight:600; font-size:1rem; }
  .badge { font-size:.7rem; font-weight:700; letter-spacing:.5px; padding:3px 8px; border-radius:999px; color:#fff; }
  .badge.ok { background:var(--ok); } .badge.bad { background:var(--bad); } .badge.pend { background:var(--pend); } .badge.pause { background:var(--pause); }
  .bars { display:flex; gap:2px; margin:10px 0 6px; }
  .bar { flex:1; height:22px; border-radius:2px; background:var(--bar); }
  .bar.ok { background:var(--ok); } .bar.bad { background:var(--bad); }
  .job-meta { color:var(--muted); font-size:.8rem; }
  h2 { font-size:1.05rem; margin:28px 0 10px; }
  .incident { background:var(--card); border-radius:10px; padding:12px 16px; margin-bottom:8px; box-shadow:0 1px 3px rgba(0,0,0,.08); }
  .inc-head { font-weight:600; } .inc-head .err { color:var(--bad); font-size:.8rem; font-weight:700; }
  .inc-meta { color:var(--muted); font-size:.82rem; margin-top:2px; }
  .muted { color:var(--muted); }
  footer { margin-top:32px; color:var(--muted); font-size:.78rem; text-align:center; }
</style>
</head>
<body>
<div class="wrap">
  <h1>${esc(data.title)}</h1>
  ${data.message ? `<p class="message">${esc(data.message)}</p>` : ''}
  <div class="banner ${bannerCls}">${bannerText}</div>
  ${jobCards}
  <h2>Recent incidents</h2>
  ${incRows}
  ${maint}
  <footer>Powered by uptime-cron · updated every check · cached 30s</footer>
</div>
</body>
</html>`;
}
