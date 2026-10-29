import { Router } from 'express';
import { ok, asyncH, err } from '../errors.js';
import { parseSchedule, nextRuns, humanSchedule, isValidTimezone } from '../cron.js';
import { config } from '../config.js';

const router = Router();

const TIMEZONES = [
  'UTC',
  'Asia/Kolkata', 'Asia/Karachi', 'Asia/Dhaka', 'Asia/Kathmandu', 'Asia/Colombo',
  'Asia/Dubai', 'Asia/Riyadh', 'Asia/Tehran', 'Asia/Singapore', 'Asia/Hong_Kong',
  'Asia/Tokyo', 'Asia/Seoul', 'Asia/Jakarta', 'Asia/Bangkok', 'Asia/Manila',
  'Asia/Shanghai', 'Asia/Kuala_Lumpur', 'Asia/Karachi', 'Asia/Tashkent', 'Asia/Almaty',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Rome',
  'Europe/Istanbul', 'Europe/Moscow', 'Europe/Amsterdam', 'Europe/Zurich', 'Europe/Warsaw',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Sao_Paulo', 'America/Toronto', 'America/Vancouver', 'America/Mexico_City',
  'Australia/Sydney', 'Australia/Melbourne', 'Australia/Perth',
  'Africa/Lagos', 'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Nairobi',
  'Pacific/Auckland', 'Pacific/Fiji',
];

router.post('/preview-schedule', asyncH(async (req, res) => {
  const body = req.body || {};
  try {
    const schedule = parseSchedule(body.schedule, body.timezone && isValidTimezone(body.timezone) ? body.timezone : config.defaultTimezone);
    const count = Math.min(Math.max(Number(body.count) || 3, 1), 10);
    ok(res, {
      valid: true,
      human: humanSchedule(schedule),
      timezone: schedule.timezone,
      cron: schedule.cron,
      interval_seconds: schedule.interval_seconds,
      next_runs: nextRuns(schedule, count),
    });
  } catch (e) {
    if (e.code) return ok(res, { valid: false, error: { code: e.code, message: e.message } });
    throw e;
  }
}));

router.post('/parse-cron', asyncH(async (req, res) => {
  const body = req.body || {};
  try {
    const schedule = parseSchedule(body.schedule, body.timezone && isValidTimezone(body.timezone) ? body.timezone : config.defaultTimezone);
    ok(res, {
      valid: true,
      human: humanSchedule(schedule),
      cron: schedule.cron,
      interval_seconds: schedule.interval_seconds,
      timezone: schedule.timezone,
      kind: schedule.kind,
    });
  } catch (e) {
    if (e.code) {
      const status = e.status || 422;
      return res.status(status).json({ ok: false, error: { code: e.code, message: e.message, status } });
    }
    throw e;
  }
}));

router.get('/timezones', (req, res) => {
  ok(res, { timezones: TIMEZONES, note: 'Any valid IANA timezone is accepted; these are the common ones' });
});

export default router;
