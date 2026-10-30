import { db } from './db.js';
import { config } from './config.js';
import { assertSafeUrl } from './ssrf.js';

/**
 * v1.2.0 alert delivery.
 * Events: down | up | ssl_expiring | heartbeat_missed | auto_disabled | test
 * Contacts: telegram | email | webhook | discord | slack
 * Dedupe: one DOWN + one UP alert per incident (enforced by the scheduler via
 * incidents.down_alerted_at / up_alerted_at); alert_after_minutes and
 * repeat_alert_minutes are honored by the scheduler, not here.
 * failure_webhook / recovery_webhook (v1.1.0) keep working independently.
 */

const UA = 'uptime-cron/1.2';

function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return `${m}m ${rest}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function localTime(iso, tz) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toISOString().slice(11, 16);
  }
}

function tzLabel(tz) {
  if (!tz) return 'UTC';
  const part = String(tz).split('/');
  return part[part.length - 1].replace(/_/g, ' ').toUpperCase();
}

function eventLabel(event, errorCode) {
  if (event === 'ssl_expiring') return 'SSL EXPIRING';
  if (event === 'heartbeat_missed') return 'HEARTBEAT MISSED';
  if (event === 'auto_disabled') return 'AUTO-DISABLED';
  if (event === 'up') return 'UP';
  return `DOWN: ${errorCode || 'FAILED'}`;
}

export function buildAlertText({ event, job, errorCode, statusCode, incident, timezone }) {
  const title = job.title || job.url || job.id;
  const tz = timezone || job.timezone || 'UTC';
  if (event === 'up') {
    const dur = incident?.duration_seconds != null ? ` Down for ${fmtDuration(incident.duration_seconds)}` : '';
    return `UP: ${title} is back.${dur}`;
  }
  if (event === 'ssl_expiring') {
    return `SSL EXPIRING: ${title} (${job.url || ''}) - ${errorCode || 'SSL_EXPIRING'}. ${incident?.error_text || ''}`.trim();
  }
  if (event === 'heartbeat_missed') {
    return `HEARTBEAT MISSED: ${title} - no ping received. Since ${localTime(incident?.started_at || new Date().toISOString(), tz)} ${tzLabel(tz)}`;
  }
  if (event === 'auto_disabled') {
    return `AUTO-DISABLED: ${title} after repeated failures (${errorCode || 'FAILED'}). Since ${localTime(incident?.started_at || new Date().toISOString(), tz)} ${tzLabel(tz)}`;
  }
  if (event === 'test') {
    return `Test alert from uptime-cron for "${title}". If you can read this, this contact works.`;
  }
  return `DOWN: ${title} (${job.url || ''}) - ${errorCode || statusCode || 'FAILED'}. Since ${localTime(incident?.started_at || new Date().toISOString(), tz)} ${tzLabel(tz)}`;
}

export function buildAlertPayload({ event, job, errorCode, statusCode, incident }) {
  return {
    event,
    job: {
      id: job.id,
      title: job.title || '',
      url: job.url || null,
      type: job.type || 'http',
    },
    error_code: errorCode ?? null,
    status_code: statusCode ?? null,
    incident: incident
      ? {
          id: incident.id,
          started_at: incident.started_at,
          duration_seconds: incident.ended_at ? incident.duration_seconds : 0,
        }
      : null,
    at: new Date().toISOString(),
  };
}

async function postWithRetry(url, body, headers = {}, { retries = 3, timeoutMs = 10000 } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA, ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return { ok: true, status: res.status };
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, attempt * 2000));
  }
  return { ok: false, error: lastErr?.message || 'send failed' };
}

async function sendTelegram(target, text) {
  if (!config.telegramBotToken) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not configured on the server' };
  return postWithRetry(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
    chat_id: target,
    text,
    disable_web_page_preview: true,
  });
}

async function sendEmail(target, subject, text) {
  if (!config.resendApiKey || !config.resendFrom) return { ok: false, error: 'email alerts not configured on the server' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ from: config.resendFrom, to: [target], subject, text }),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok ? { ok: true, status: res.status } : { ok: false, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function sendToContact(contact, { text, payload }) {
  try {
    switch (contact.type) {
      case 'telegram':
        return await sendTelegram(contact.target, text);
      case 'email':
        return await sendEmail(contact.target, text.split('\n')[0].slice(0, 120), text);
      case 'webhook': {
        await assertSafeUrl(contact.target);
        return await postWithRetry(contact.target, payload, {}, { retries: 3 });
      }
      case 'discord': {
        await assertSafeUrl(contact.target);
        return await postWithRetry(contact.target, { content: text, username: 'uptime-cron' }, {}, { retries: 3 });
      }
      case 'slack': {
        await assertSafeUrl(contact.target);
        return await postWithRetry(contact.target, { text }, {}, { retries: 3 });
      }
      default:
        return { ok: false, error: `unknown contact type: ${contact.type}` };
    }
  } catch (e) {
    return { ok: false, error: e.status === 422 ? 'contact target blocked by SSRF protection' : (e.message || 'send failed') };
  }
}

/** Resolve the contacts a job should alert. */
export async function resolveContacts(job) {
  let ids = [];
  try { ids = JSON.parse(job.alert_contact_ids || '[]'); } catch { ids = []; }
  if (Array.isArray(ids) && ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const r = await db.execute({
      sql: `SELECT * FROM alert_contacts WHERE id IN (${placeholders}) AND telegram_id = ? AND enabled = 1`,
      args: [...ids, job.owner_telegram_id],
    });
    return r.rows;
  }
  // default: the user's first enabled telegram contact
  const r = await db.execute({
    sql: `SELECT * FROM alert_contacts WHERE telegram_id = ? AND type = 'telegram' AND enabled = 1 ORDER BY created_at ASC LIMIT 1`,
    args: [job.owner_telegram_id],
  });
  return r.rows;
}

/**
 * Send an alert for a job event to all matching contacts.
 * Returns { sent, failed, details }.
 */
export async function sendJobAlert(job, { event, errorCode, statusCode, incident }) {
  const contacts = await resolveContacts(job);
  if (!contacts.length) return { sent: 0, failed: 0, details: ['no alert contacts configured'] };
  const text = buildAlertText({ event, job, errorCode, statusCode, incident });
  const payload = buildAlertPayload({ event, job, errorCode, statusCode, incident });
  const details = [];
  let sent = 0;
  let failed = 0;
  for (const c of contacts) {
    const r = await sendToContact(c, { text, payload });
    if (r.ok) sent++;
    else failed++;
    details.push({ contact_id: c.id, type: c.type, ok: r.ok, error: r.error || null });
  }
  return { sent, failed, details };
}

/** Send a test alert to one contact. */
export async function sendTestAlert(contact) {
  const fakeJob = { id: contact.id, title: contact.name || contact.type + ' contact', url: null, timezone: 'UTC' };
  return sendToContact(contact, {
    text: buildAlertText({ event: 'test', job: fakeJob }),
    payload: { event: 'test', at: new Date().toISOString() },
  });
}
