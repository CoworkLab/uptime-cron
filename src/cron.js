import parser from 'cron-parser';
import cronstrue from 'cronstrue';
import { config } from './config.js';
import { err } from './errors.js';

const PRESETS = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

const MULT = { s: 1, m: 60, h: 3600, d: 86400 };

export function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function arrayToField(value, min, max, name) {
  if (value === undefined || value === null) return '*';
  if (value === '*') return '*';
  if (!Array.isArray(value)) throw err.validation(`schedule.${name} must be an array of integers or "*"`);
  const out = [];
  for (const v of value) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw err.validation(`schedule.${name} value "${v}" out of range (${min}-${max})`);
    }
    out.push(String(n));
  }
  if (!out.length) throw err.validation(`schedule.${name} cannot be empty`);
  return out.join(',');
}

function assertMinGap(cronExpr, tz) {
  let expr;
  try {
    expr = parser.parseExpression(cronExpr, { tz, currentDate: new Date() });
  } catch (e) {
    throw err.validation(`Invalid cron expression: ${cronExpr}`);
  }
  let prev = expr.next().toDate();
  for (let i = 0; i < 4; i++) {
    const nx = expr.next().toDate();
    const gap = Math.round((nx - prev) / 1000);
    if (gap < config.minIntervalSeconds) {
      throw new ApiErrorGap(gap);
    }
    prev = nx;
  }
}

function ApiErrorGap(gap) {
  const e = err.intervalTooShort(config.minIntervalSeconds);
  e.message = `Schedule fires every ${gap}s. Minimum allowed interval is ${config.minIntervalSeconds} seconds (2 minutes)`;
  return e;
}

function validateCron(cronExpr, tz) {
  const fields = cronExpr.split(/\s+/);
  if (fields.length === 6) {
    throw err.validation('Seconds-level schedules (6-field cron) are not supported. Minimum interval is 2 minutes.');
  }
  if (fields.length !== 5) {
    throw err.validation('Invalid cron expression (expected 5 fields: "min hour day month weekday")');
  }
  assertMinGap(cronExpr, tz);
}

export function humanSchedule(s) {
  try {
    if (s.kind === 'every') {
      const iv = s.interval_seconds;
      if (iv % 86400 === 0) return `Every ${iv / 86400} day(s)`;
      if (iv % 3600 === 0) return `Every ${iv / 3600} hour(s)`;
      if (iv % 60 === 0) return `Every ${iv / 60} minute(s)`;
      return `Every ${iv} seconds`;
    }
    return cronstrue.toString(s.cron) || s.cron;
  } catch {
    return s.cron || s.input || '';
  }
}

/**
 * Normalize any supported schedule input into a canonical shape:
 *   { kind: 'cron' | 'every', cron, interval_seconds, timezone, input }
 * Accepts:
 *   "every 5 min cron" (5-field cron, e.g. "0 9 * * *")
 *   "@daily" / "@hourly" / ... presets
 *   "@every 30m"                        (true interval, min 2m)
 *   { cron: "0 9 * * *", timezone: "Asia/Kolkata" }
 *   { minutes:[0], hours:[9], mdays:["*"], wdays:["*"], months:["*"], timezone }  (cron-job.org style)
 */
export function parseSchedule(input, defaultTz, rawInput) {
  if (input === undefined || input === null || input === '') {
    throw err.validation('schedule is required (cron string, @every interval, or cron-job.org style object)');
  }

  const tz = typeof input === 'object' && isValidTimezone(input.timezone || '') ? input.timezone : defaultTz;
  if (typeof input === 'object' && input.timezone && !isValidTimezone(input.timezone)) {
    throw err.validation(`Unknown timezone: "${input.timezone}" (use an IANA timezone like Asia/Kolkata)`);
  }

  // --- object forms ---
  if (typeof input === 'object') {
    if (typeof input.cron === 'string') {
      const parsed = parseSchedule(input.cron, tz, rawInput ?? JSON.stringify(input));
      return { ...parsed, timezone: tz };
    }
    const cron = [
      arrayToField(input.minutes, 0, 59, 'minutes'),
      arrayToField(input.hours, 0, 23, 'hours'),
      arrayToField(input.mdays, 1, 31, 'mdays'),
      arrayToField(input.months, 1, 12, 'months'),
      arrayToField(input.wdays, 0, 6, 'wdays'),
    ].join(' ');
    validateCron(cron, tz);
    return { kind: 'cron', cron, interval_seconds: null, timezone: tz, input: rawInput ?? JSON.stringify(input) };
  }

  // --- string forms ---
  const s = String(input).trim();
  if (!s) throw err.validation('schedule cannot be empty');

  const every = s.match(/^@every\s+(\d+)\s*([smhd])$/i);
  if (every) {
    const iv = Number(every[1]) * MULT[every[2].toLowerCase()];
    if (iv < config.minIntervalSeconds) {
      throw new ApiErrorGap(iv);
    }
    return { kind: 'every', cron: null, interval_seconds: iv, timezone: tz, input: s };
  }

  let expr = PRESETS[s.toLowerCase()] || s;
  validateCron(expr, tz);
  return { kind: 'cron', cron: expr, interval_seconds: null, timezone: tz, input: s };
}

export function computeNextRun(schedule, fromDate = new Date()) {
  if (schedule.kind === 'every') {
    return new Date(fromDate.getTime() + schedule.interval_seconds * 1000);
  }
  const expr = parser.parseExpression(schedule.cron, { tz: schedule.timezone, currentDate: fromDate });
  return expr.next().toDate();
}

export function nextRuns(schedule, count = 3) {
  const out = [];
  if (schedule.kind === 'every') {
    let t = Date.now();
    for (let i = 0; i < count; i++) {
      t += schedule.interval_seconds * 1000;
      out.push(new Date(t).toISOString());
    }
    return out;
  }
  const expr = parser.parseExpression(schedule.cron, { tz: schedule.timezone, currentDate: new Date() });
  for (let i = 0; i < count; i++) {
    out.push(expr.next().toDate().toISOString());
  }
  return out;
}
