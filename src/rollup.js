import { db } from './db.js';
import { config } from './config.js';
import { genId } from './ids.js';

/**
 * v1.2.0 free-plan safety:
 * - job_daily rollups (incremental, watermark-based) so 7d/30d/90d stats work
 *   even though raw executions are trimmed to the last 50 per job.
 * - monitoring gap tracking: on boot, if the previous process's last scheduler
 *   tick is older than 10 minutes (Render sleep / crash), the gap is recorded
 *   and excluded from uptime percentages.
 * - daily purge: incidents > 90d, job_daily > 92d, gaps > 30d.
 */

const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);

function p95(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[idx];
}

/** Record a scheduler tick; detect monitoring gaps > 10 min since last record. */
export async function recordTick() {
  const nowIso = new Date().toISOString();
  try {
    const prev = await db.execute({ sql: `SELECT value FROM system_state WHERE key = 'last_tick_at'`, args: [] });
    const prevIso = prev.rows[0]?.value;
    if (prevIso) {
      const gapMs = Date.now() - Date.parse(prevIso);
      if (gapMs > 10 * 60 * 1000) {
        await db.execute({
          sql: 'INSERT INTO monitoring_gaps (id, started_at, ended_at) VALUES (?, ?, ?)',
          args: [genId('gap_'), prevIso, nowIso],
        });
        console.log(`[rollup] monitoring gap recorded: ${Math.round(gapMs / 60000)} min`);
      }
    }
    await db.execute({
      sql: `INSERT INTO system_state (key, value) VALUES ('last_tick_at', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      args: [nowIso],
    });
  } catch (e) {
    console.error('[rollup] recordTick error:', e.message);
  }
}

/** Incremental per-job rollup of executions into job_daily. */
export async function rollupTick() {
  try {
    const jobs = await db.execute({ sql: 'SELECT id FROM jobs', args: [] });
    for (const j of jobs.rows) {
      const st = await db.execute({ sql: 'SELECT last_at FROM job_rollup_state WHERE job_id = ?', args: [j.id] });
      const since = st.rows[0]?.last_at || '1970-01-01T00:00:00.000Z';

      const rows = await db.execute({
        sql: 'SELECT started_at, status, duration_ms FROM executions WHERE job_id = ? AND started_at > ? ORDER BY started_at ASC LIMIT 2000',
        args: [j.id, since],
      });
      if (!rows.rows.length) continue;

      const byDay = new Map();
      for (const r of rows.rows) {
        const d = dayStr(Date.parse(r.started_at));
        if (!byDay.has(d)) byDay.set(d, { runs: 0, fails: 0, sum: 0, durations: [] });
        const b = byDay.get(d);
        b.runs++;
        if (r.status !== 'success') b.fails++;
        if (r.duration_ms != null) {
          b.sum += Number(r.duration_ms);
          b.durations.push(Number(r.duration_ms));
        }
      }

      for (const [date, b] of byDay) {
        await db.execute({
          sql: `INSERT INTO job_daily (job_id, date, runs, fails, sum_ms, p95_ms)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(job_id, date) DO UPDATE SET
                  runs = runs + excluded.runs,
                  fails = fails + excluded.fails,
                  sum_ms = sum_ms + excluded.sum_ms`,
          args: [j.id, date, b.runs, b.fails, b.sum, null],
        });
        // refresh today's p95 from the raw rows still in DB (best effort)
        const today = dayStr(Date.now());
        if (date === today) {
          const dur = await db.execute({
            sql: `SELECT duration_ms FROM executions WHERE job_id = ? AND started_at >= ? AND duration_ms IS NOT NULL`,
            args: [j.id, `${today}T00:00:00.000Z`],
          });
          const p = p95(dur.rows.map((r) => Number(r.duration_ms)));
          if (p != null) {
            await db.execute({ sql: 'UPDATE job_daily SET p95_ms = ? WHERE job_id = ? AND date = ?', args: [p, j.id, date] });
          }
        }
      }

      const lastAt = rows.rows[rows.rows.length - 1].started_at;
      await db.execute({
        sql: `INSERT INTO job_rollup_state (job_id, last_at) VALUES (?, ?)
              ON CONFLICT(job_id) DO UPDATE SET last_at = excluded.last_at`,
        args: [j.id, lastAt],
      });
    }
  } catch (e) {
    console.error('[rollup] rollupTick error:', e.message);
  }
}

/** Daily purge: old incidents, old rollups, old gaps. */
export async function purgeOld() {
  try {
    const incCut = new Date(Date.now() - config.incidentsRetentionDays * 86400000).toISOString();
    const r1 = await db.execute({ sql: 'DELETE FROM incidents WHERE started_at < ?', args: [incCut] });
    const dayCut = new Date(Date.now() - (config.incidentsRetentionDays + 2) * 86400000).toISOString().slice(0, 10);
    const r2 = await db.execute({ sql: 'DELETE FROM job_daily WHERE date < ?', args: [dayCut] });
    const gapCut = new Date(Date.now() - 30 * 86400000).toISOString();
    const r3 = await db.execute({ sql: 'DELETE FROM monitoring_gaps WHERE ended_at < ?', args: [gapCut] });
    const n = Number(r1.rowsAffected || 0) + Number(r2.rowsAffected || 0) + Number(r3.rowsAffected || 0);
    if (n > 0) console.log(`[rollup] purge removed ${n} old rows`);
  } catch (e) {
    console.error('[rollup] purgeOld error:', e.message);
  }
}
