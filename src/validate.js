import { err } from './errors.js';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
const BODY_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

export function vString(value, name, { max = 255, required = false, allowEmpty = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw err.validation(`${name} is required`);
    return '';
  }
  if (typeof value !== 'string') throw err.validation(`${name} must be a string`);
  const v = value.trim();
  if (!v && required) throw err.validation(`${name} is required`);
  if (!v && !allowEmpty) throw err.validation(`${name} cannot be empty`);
  if (v.length > max) throw err.validation(`${name} must be at most ${max} characters`);
  return v;
}

export function vUrl(value, name = 'url') {
  const v = vString(value, name, { max: 2048, required: true, allowEmpty: false });
  let u;
  try {
    u = new URL(v);
  } catch {
    throw err.urlInvalid();
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw err.urlInvalid();
  return v;
}

export function vOptionalUrl(value, name) {
  if (value === undefined || value === null || value === '') return null;
  return vUrl(value, name);
}

export function vMethod(value) {
  if (value === undefined || value === null) return 'GET';
  const v = String(value).toUpperCase().trim();
  if (!HTTP_METHODS.includes(v)) {
    throw err.validation(`method must be one of: ${HTTP_METHODS.join(', ')}`);
  }
  return v;
}

export function vInt(value, name, { min, max, def }) {
  if (value === undefined || value === null || value === '') return def;
  const n = Number(value);
  if (!Number.isInteger(n)) throw err.validation(`${name} must be an integer`);
  if (n < min || n > max) throw err.validation(`${name} must be between ${min} and ${max}`);
  return n;
}

export function vBool(value, def) {
  if (value === undefined || value === null) return def;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw err.validation('Expected boolean (true/false)');
}

export function vHeaders(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw err.validation('headers must be a JSON object');
  const keys = Object.keys(value);
  if (keys.length > 20) throw err.validation('headers supports at most 20 entries');
  const out = {};
  for (const k of keys) {
    if (typeof k !== 'string' || !k.trim() || k.length > 128) throw err.validation(`Invalid header name: "${k}"`);
    const v = value[k];
    if (typeof v !== 'string') throw err.validation(`Header "${k}" value must be a string`);
    if (v.length > 1024) throw err.validation(`Header "${k}" value too long (max 1024)`);
    out[k.trim()] = v;
  }
  return out;
}

export function vBody(value, method) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw err.validation('body must be a string');
  if (value.length > 65536) throw err.validation('body too large (max 64 KB)');
  if (value && !BODY_METHODS.includes(method)) {
    throw err.validation(`body is not allowed for ${method}. Use POST/PUT/PATCH/DELETE, or remove the body`);
  }
  return value || null;
}

export function vTags(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw err.validation('tags must be an array of strings');
  if (value.length > 5) throw err.validation('tags supports at most 5 entries');
  const out = value.map((t) => {
    if (typeof t !== 'string' || !t.trim()) throw err.validation('tags must be non-empty strings');
    if (t.length > 32) throw err.validation('tag too long (max 32 characters)');
    return t.trim();
  });
  return [...new Set(out)];
}

export function vExpiresAt(value) {
  if (value === undefined || value === null || value === '') return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) throw err.validation('expires_at must be a valid ISO 8601 date');
  return t;
}

export function vTelegramId(value, name = 'telegram_id') {
  const v = vString(value, name, { max: 20, required: true, allowEmpty: false });
  if (!/^\d{3,20}$/.test(v)) throw err.validation(`${name} must be a numeric Telegram user id (digits only)`);
  return v;
}

export function vAuth(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw err.validation('auth must be an object like {"type":"basic","username":"...","password":"..."}');
  const type = value.type === undefined ? 'basic' : value.type;
  if (type !== 'basic') throw err.validation('auth.type must be "basic"');
  const username = typeof value.username === 'string' ? value.username.trim() : '';
  const password = typeof value.password === 'string' ? value.password : '';
  if (!username || username.length > 128) throw err.validation('auth.username is required (max 128 chars)');
  if (!password || password.length > 256) throw err.validation('auth.password is required (max 256 chars)');
  return { type: 'basic', username, password };
}

// ---------- v1.2.0 uptime monitoring ----------

export const JOB_TYPES = ['http', 'keyword', 'port', 'ssl', 'heartbeat'];

export function vJobType(value) {
  if (value === undefined || value === null || value === '') return 'http';
  const v = String(value).toLowerCase().trim();
  if (!JOB_TYPES.includes(v)) throw err.invalidJobType();
  return v;
}

export function vExpectedStatus(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw err.validation('expected_status must be an array like ["200-299","301"]');
  if (value.length > 10) throw err.validation('expected_status supports at most 10 entries');
  const out = [];
  for (const item of value) {
    const s = String(item).trim();
    const m = s.match(/^(\d{3})-(\d{3})$/);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (a < 100 || b > 599 || a > b) throw err.validation(`expected_status range "${s}" is invalid (100-599, min <= max)`);
      out.push(s);
    } else if (/^\d{3}$/.test(s)) {
      const n = Number(s);
      if (n < 100 || n > 599) throw err.validation(`expected_status "${s}" out of range (100-599)`);
      out.push(s);
    } else {
      throw err.validation(`expected_status entry "${s}" must be "200" or "200-299"`);
    }
  }
  return JSON.stringify(out);
}

export function vKeyword(value, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) throw err.validation('keyword is required for type "keyword"');
    return null;
  }
  if (typeof value !== 'string') throw err.validation('keyword must be a string');
  const v = value;
  if (v.length > 200) throw err.validation('keyword must be at most 200 characters');
  return v;
}

export function vKeywordMode(value) {
  if (value === undefined || value === null) return 'exists';
  const v = String(value).toLowerCase().trim();
  if (!['exists', 'not_exists'].includes(v)) throw err.validation('keyword_mode must be "exists" or "not_exists"');
  return v;
}

export function vAlertContactIds(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw err.validation('alert_contact_ids must be an array of contact ids');
  if (value.length > 10) throw err.validation('alert_contact_ids supports at most 10 contacts');
  const out = value.map((x) => {
    const s = String(x || '').trim();
    if (!s.startsWith('con_')) throw err.validation(`alert_contact_ids entry "${s}" is not a valid contact id`);
    return s;
  });
  return JSON.stringify([...new Set(out)]);
}

export const CONTACT_TYPES = ['telegram', 'email', 'webhook', 'discord', 'slack'];

export function vContactType(value) {
  const v = String(value || '').toLowerCase().trim();
  if (!CONTACT_TYPES.includes(v)) throw err.validation(`type must be one of: ${CONTACT_TYPES.join(', ')}`);
  return v;
}

export function vContactTarget(type, value) {
  const v = String(value || '').trim();
  if (!v) throw err.validation('target is required');
  if (v.length > 512) throw err.validation('target too long (max 512 characters)');
  if (type === 'telegram') {
    if (!/^-?\d{4,20}$/.test(v)) throw err.validation('telegram target must be a numeric chat id (e.g. "6123456789" or "-1001234567890" for groups)');
  } else if (type === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw err.validation('email target must be a valid email address');
  } else {
    try {
      const u = new URL(v);
      if (u.protocol !== 'https:') throw new Error('not https');
    } catch {
      throw err.validation(`${type} target must be a valid https URL`);
    }
  }
  return v;
}

export function vSlug(value) {
  const v = String(value || '').toLowerCase().trim();
  if (!/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/.test(v)) {
    throw err.validation('slug must be 3-60 characters: lowercase letters, digits and hyphens (no leading/trailing hyphen)');
  }
  return v;
}

export function vHHMM(value, name) {
  const v = String(value || '').trim();
  const m = v.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw err.validation(`${name} must be "HH:MM" (e.g. "02:30")`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) throw err.validation(`${name} must be a valid time (HH:MM)`);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function vRecurrence(value) {
  const v = String(value || 'none').toLowerCase().trim();
  if (!['none', 'daily', 'weekly'].includes(v)) throw err.validation('recurrence must be one of: none, daily, weekly');
  return v;
}
