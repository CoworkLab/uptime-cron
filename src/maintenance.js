import { db } from './db.js';

/**
 * v1.2.0 maintenance windows.
 * recurrence: none (start_at/end_at are absolute ISO datetimes)
 *             daily (start_at/end_at are "HH:MM" in window timezone, every day)
 *             weekly (same, plus weekday 0=Sun..6=Sat; default 1=Mon)
 * job_ids: [] = all of the owner's jobs.
 * During a window: checks still run, but no alerts, no incidents, and the
 * time is excluded from uptime percentages.
 */

export function isValidRecurrence(r) {
  return ['none', 'daily', 'weekly'].includes(r);
}

export function isValidWeekday(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 6;
}

function localParts(tz, date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short',
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: Number(parts.year), m: Number(parts.month), d: Number(parts.day),
    hh: Number(parts.hour === '24' ? '00' : parts.hour), mm: Number(parts.minute),
    weekday: wd[parts.weekday] ?? 0,
  };
}

/** Convert a wall-clock time in `tz` to a UTC epoch ms (DST-safe, 2-pass). */
function zonedToUtcMs(tz, y, m, d, hh, mm) {
  let guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  for (let i = 0; i < 2; i++) {
    const p = localParts(tz, new Date(guess));
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, 0);
    const diff = Date.UTC(y, m - 1, d, hh, mm, 0) - asUtc;
    guess += diff;
  }
  return guess;
}

function parseHHMM(s) {
  const m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return { hh, mm };
}

/**
 * Expand a maintenance window into concrete [startMs, endMs] intervals
 * overlapping [fromMs, toMs].
 */
export function windowIntervals(win, fromMs, toMs) {
  const out = [];
  const tz = win.timezone || 'UTC';

  if (win.recurrence === 'none' || !win.recurrence) {
    const s = Date.parse(win.start_at);
    const e = Date.parse(win.end_at);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return out;
    if (e > fromMs && s < toMs) out.push([Math.max(s, fromMs), Math.min(e, toMs)]);
    return out;
  }

  const startT = parseHHMM(win.start_at);
  const endT = parseHHMM(win.end_at);
  if (!startT || !endT) return out;

  const crossesMidnight = startT.hh * 60 + startT.mm >= endT.hh * 60 + endT.mm;
  // iterate day anchors covering the range (extend 1 day each side for midnight crossing)
  const dayMs = 86400000;
  let anchor = Math.floor(fromMs / dayMs) * dayMs - dayMs * 2;
  const endAnchor = toMs + dayMs * 2;

  const makeInterval = (dayStartLocal) => {
    // dayStartLocal: UTC ms of local midnight for that calendar day
    const p = localParts(tz, new Date(dayStartLocal));
    const sMs = zonedToUtcMs(tz, p.y, p.m, p.d, startT.hh, startT.mm);
    let eMs = zonedToUtcMs(tz, p.y, p.m, p.d, endT.hh, endT.mm);
    if (crossesMidnight) eMs += dayMs;
    return [sMs, eMs];
  };

  while (anchor <= endAnchor) {
    const p = localParts(tz, new Date(anchor));
    if (win.recurrence !== 'daily') {
      const wd = win.weekday != null ? Number(win.weekday) : 1;
      if (p.weekday !== wd) {
        anchor += dayMs;
        continue;
      }
    }
    const [sMs, eMs] = makeInterval(anchor);
    if (eMs > fromMs && sMs < toMs) out.push([Math.max(sMs, fromMs), Math.min(eMs, toMs)]);
    anchor += dayMs;
  }
  return out;
}

function mergeIntervals(list) {
  const sorted = list.filter((x) => x[1] > x[0]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

function totalSeconds(intervals) {
  return intervals.reduce((n, iv) => n + (iv[1] - iv[0]) / 1000, 0);
}

function subtract(intervals, busy) {
  // subtract merged busy intervals from intervals; returns remaining seconds
  const remaining = [];
  for (const [s, e] of intervals) {
    let cur = s;
    for (const [bs, be] of busy) {
      if (be <= cur || bs >= e) continue;
      if (bs > cur) remaining.push([cur, Math.min(bs, e)]);
      cur = Math.max(cur, be);
      if (cur >= e) break;
    }
    if (cur < e) remaining.push([cur, e]);
  }
  return totalSeconds(remaining);
}

/** Maintenance intervals for a job within [fromMs, toMs]. */
export async function maintenanceIntervals(jobId, telegramId, fromMs, toMs) {
  const r = await db.execute({
    sql: 'SELECT * FROM maintenance_windows WHERE telegram_id = ?',
    args: [telegramId],
  });
  const out = [];
  for (const row of r.rows) {
    let ids = [];
    try { ids = JSON.parse(row.job_ids || '[]'); } catch { ids = []; }
    if (Array.isArray(ids) && ids.length && !ids.includes(jobId)) continue;
    out.push(...windowIntervals(row, fromMs, toMs));
  }
  return mergeIntervals(out);
}

/** True when the job is inside a maintenance window right now. */
export async function isMaintenanceActive(jobId, telegramId, nowMs = Date.now()) {
  const ivs = await maintenanceIntervals(jobId, telegramId, nowMs - 1000, nowMs + 1000);
  return ivs.length > 0;
}

/** Total maintenance seconds for a job within a range. */
export async function maintenanceSeconds(jobId, telegramId, fromMs, toMs) {
  return totalSeconds(await maintenanceIntervals(jobId, telegramId, fromMs, toMs));
}

/** Subtract busy intervals (maintenance/gaps) from incident intervals -> downtime seconds. */
export function downtimeOutsideBusy(incidentIntervals, busyIntervals) {
  return subtract(incidentIntervals, mergeIntervals(busyIntervals));
}
