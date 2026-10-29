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
