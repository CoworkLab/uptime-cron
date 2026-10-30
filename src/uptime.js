import { db } from './db.js';
import { maintenanceSeconds, downtimeOutsideBusy, maintenanceIntervals } from './maintenance.js';

/**
 * v1.2.0 uptime math.
 * uptime% = (denominator - downtime) / denominator where:
 *   denominator = range seconds - maintenance seconds - monitoring gap seconds
 *   downtime    = incident overlap with the range, minus maintenance/gap intersections
 * Response aggregates: 24h uses raw executions; 7d/30d/90d use job_daily rollups
 * (p95 from daily p95 samples = approximation).
 */

export const RANGES = { '24h': 86400, '7d': 604800, '30d': 2592000, '90d': 7776000 };

function overlap(aS, aE, bS, bE) {
  return Math.max(0, Math.min(aE, bE) - Math.max(aS, bS));
}

function totalMs(intervals) {
  return intervals.reduce((n, iv) => n + (iv[1] - iv[0]), 0);
}

function merge(intervals) {
  const sorted = intervals.filter((x) => x[1] > x[0]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[idx];
}

/**
 * Compute uptime stats for one job over a range.
 * job: full jobs row. Returns:
 * { uptime_percent, downtime_seconds, incidents, avg_response_ms, p95_response_ms, monitored_seconds }
 */
export async function jobUptime(job, rangeSeconds, fromMs = Date.now() - rangeSeconds * 1000, toMs = Date.now()) {
  const fromIso = new Date(fromMs).toISOString();
  const toIso = new Date(toMs).toISOString();

  // incidents overlapping the range
  const inc = await db.execute({
    sql: `SELECT * FROM incidents WHERE job_id = ? AND started_at < ? AND (ended_at IS NULL OR ended_at > ?)`,
    args: [job.id, toIso, fromIso],
  });

  // monitoring gaps in range
  const gapsR = await db.execute({
    sql: 'SELECT started_at, ended_at FROM monitoring_gaps WHERE ended_at > ? AND started_at < ?',
    args: [fromIso, toIso],
  });

  const busy = merge([
    ...gapsR.rows.map((g) => [Date.parse(g.started_at), Date.parse(g.ended_at)]),
  ]);

  // maintenance for this job (job_ids may scope it)
  const maintIvs = await maintenanceIntervals(job.id, job.owner_telegram_id, fromMs, toMs);
  const allBusy = merge([...busy, ...maintIvs]);

  const incidentIntervals = [];
  let incidentsCount = 0;
  for (const i of inc.rows) {
    if (Date.parse(i.started_at) >= fromMs) incidentsCount++;
    const s = Math.max(Date.parse(i.started_at), fromMs);
    const e = Math.min(i.ended_at ? Date.parse(i.ended_at) : toMs, toMs);
    if (e > s) incidentIntervals.push([s, e]);
  }

  const maintSeconds = totalMs(allBusy) / 1000;
  const denom = Math.max(0, rangeSeconds - maintSeconds);
  const downtimeSeconds = denom > 0 ? downtimeOutsideBusy(incidentIntervals, allBusy) : 0;

  const uptimePercent = denom > 0
    ? Math.round(((denom - downtimeSeconds) / denom) * 1000) / 10
    : null;

  // response aggregates
  let avgMs = null;
  let p95Ms = null;
  if (rangeSeconds <= 86400) {
    const r = await db.execute({
      sql: `SELECT duration_ms FROM executions WHERE job_id = ? AND started_at >= ? AND duration_ms IS NOT NULL`,
      args: [job.id, fromIso],
    });
    const durations = r.rows.map((x) => Number(x.duration_ms));
    if (durations.length) {
      avgMs = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
      p95Ms = percentile(durations, 0.95);
    }
  } else {
    const fromDay = fromIso.slice(0, 10);
    const toDay = toIso.slice(0, 10);
    const r = await db.execute({
      sql: `SELECT date, runs, sum_ms, p95_ms FROM job_daily WHERE job_id = ? AND date >= ? AND date <= ? AND runs > 0`,
      args: [job.id, fromDay, toDay],
    });
    if (r.rows.length) {
      const runs = r.rows.reduce((n, x) => n + Number(x.runs), 0);
      const sum = r.rows.reduce((n, x) => n + Number(x.sum_ms), 0);
      if (runs > 0) avgMs = Math.round(sum / runs);
      const p95s = r.rows.map((x) => (x.p95_ms != null ? Number(x.p95_ms) : null)).filter((x) => x != null);
      // approximation: daily p95s upper bound the true range p95
      p95Ms = p95s.length ? Math.max(...p95s) : null;
    }
  }

  return {
    uptime_percent: uptimePercent,
    downtime_seconds: Math.round(downtimeSeconds),
    incidents: incidentsCount,
    avg_response_ms: avgMs,
    p95_response_ms: p95Ms != null ? Math.round(p95Ms) : null,
  };
}

/** Downsampled response-time points for charts. */
export async function responseTimes(jobId, rangeSeconds, points) {
  const fromIso = new Date(Date.now() - rangeSeconds * 1000).toISOString();
  const rows = await db.execute({
    sql: `SELECT started_at, duration_ms, status FROM executions
          WHERE job_id = ? AND started_at >= ? AND duration_ms IS NOT NULL
          ORDER BY started_at ASC`,
    args: [jobId, fromIso],
  });
  const data = rows.rows.map((r) => ({ t: r.started_at, ms: Number(r.duration_ms), ok: r.status === 'success' }));
  if (data.length <= points) return data;

  const bucketMs = (rangeSeconds * 1000) / points;
  const out = [];
  let bucket = { t: null, sum: 0, n: 0, ok: true };
  const flush = () => {
    if (bucket.n > 0) out.push({ t: bucket.t, ms: Math.round(bucket.sum / bucket.n), ok: bucket.ok });
  };
  const startMs = Date.parse(fromIso);
  for (const d of data) {
    const idx = Math.min(points - 1, Math.floor((Date.parse(d.t) - startMs) / bucketMs));
    const bt = new Date(startMs + idx * bucketMs).toISOString();
    if (bucket.t !== null && bt !== bucket.t) {
      flush();
      bucket = { t: null, sum: 0, n: 0, ok: true };
    }
    if (bucket.t === null) bucket.t = bt;
    bucket.sum += d.ms;
    bucket.n++;
    if (!d.ok) bucket.ok = false;
  }
  flush();
  return out;
}
