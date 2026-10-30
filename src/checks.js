import net from 'node:net';
import tls from 'node:tls';
import { executeJob } from './executor.js';
import { assertSafeHost } from './ssrf.js';

/**
 * v1.2.0 check runner — extends the v1.0 HTTP runner with monitoring rules.
 * A monitor is a job: type http | keyword | port | ssl | heartbeat.
 * Heartbeat jobs never reach this file (no outgoing request; handled by the scheduler).
 *
 * runCheck(job) -> { status, status_code, duration_ms, error, error_code, response_body, response_headers, timing }
 * error_code: TIMEOUT | DNS_ERROR | CONNECTION_REFUSED | TLS_ERROR | STATUS_MISMATCH |
 *             KEYWORD_MISSING | KEYWORD_FOUND | SLOW_RESPONSE | SSL_EXPIRING | null
 */

function parseExpectedStatus(job) {
  let raw = job.expected_status;
  if (!raw) return [{ min: 200, max: 299 }]; // default = classic 2xx rule
  try { raw = JSON.parse(raw); } catch { return [{ min: 200, max: 299 }]; }
  if (!Array.isArray(raw) || !raw.length) return [{ min: 200, max: 299 }];
  const ranges = [];
  for (const item of raw) {
    const s = String(item).trim();
    const m = s.match(/^(\d{3})-(\d{3})$/);
    if (m) ranges.push({ min: Number(m[1]), max: Number(m[2]) });
    else if (/^\d{3}$/.test(s)) ranges.push({ min: Number(s), max: Number(s) });
  }
  return ranges.length ? ranges : [{ min: 200, max: 299 }];
}

function statusInRanges(code, ranges) {
  return ranges.some((r) => code >= r.min && code <= r.max);
}

function extractHost(urlOrHost) {
  const s = String(urlOrHost || '').trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try { return new URL(s).hostname.replace(/^\[|\]$/g, ''); } catch { return s; }
  }
  return s.replace(/^\[|\]$/g, '');
}

/** HTTP / keyword check on top of the existing executor. */
async function runHttpCheck(job) {
  const isKeyword = (job.type || 'http') === 'keyword';
  const res = await executeJob(job, { readLimit: isKeyword ? 256 * 1024 : 4096 });

  // network-level failures pass straight through (error_code already mapped)
  if (res.status === 'timeout' || res.status === 'error') return res;

  // got an HTTP response -> expected_status rule
  const ranges = parseExpectedStatus(job);
  const code = res.status_code;
  if (code == null) return res; // defensive

  if (!statusInRanges(code, ranges)) {
    return {
      ...res,
      status: 'failed',
      error_code: 'STATUS_MISMATCH',
      error: `Status ${code} is not in expected_status (${ranges.map((r) => (r.min === r.max ? r.min : `${r.min}-${r.max}`)).join(', ')})`,
    };
  }

  // keyword rule (first 256 KB of the body)
  if (isKeyword && job.keyword) {
    const text = res.response_body || '';
    const kw = String(job.keyword);
    const found = job.keyword_case_sensitive
      ? text.includes(kw)
      : text.toLowerCase().includes(kw.toLowerCase());
    const mode = job.keyword_mode || 'exists';
    if (mode === 'exists' && !found) {
      return { ...res, status: 'failed', error_code: 'KEYWORD_MISSING', error: `Keyword "${kw}" not found in response` };
    }
    if (mode === 'not_exists' && found) {
      return { ...res, status: 'failed', error_code: 'KEYWORD_FOUND', error: `Keyword "${kw}" found in response (not_exists mode)` };
    }
  }

  // slow-response rule
  const maxMs = job.max_response_ms != null ? Number(job.max_response_ms) : null;
  if (maxMs != null && maxMs > 0 && res.duration_ms > maxMs) {
    return { ...res, status: 'failed', error_code: 'SLOW_RESPONSE', error: `Response took ${res.duration_ms}ms (max_response_ms is ${maxMs})` };
  }

  return { ...res, status: 'success', error: null, error_code: null };
}

/** TCP port check. job.url holds the host, job.port the port. */
async function runPortCheck(job) {
  const started = Date.now();
  const host = extractHost(job.url);
  const port = Number(job.port);
  const timeoutMs = (Number(job.timeout) || 30) * 1000;

  try {
    await assertSafeHost(host); // SSRF: same blocklist, no port restriction
  } catch {
    return { status: 'error', status_code: null, duration_ms: Date.now() - started, error: 'Request blocked by SSRF protection', error_code: null, response_body: null, response_headers: null, timing: null };
  }

  return new Promise((resolve) => {
    const timing = { start: started, dns: null, connect: null, tls: null, firstByte: null };
    let done = false;
    const finish = (status, errorCode, errorText) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch {}
      resolve({
        status,
        status_code: null,
        duration_ms: Date.now() - started,
        error: errorText,
        error_code: errorCode,
        response_body: null,
        response_headers: null,
        timing: { dns_ms: timing.dns, connect_ms: timing.connect, tls_ms: null, first_byte_ms: timing.connect, total_ms: Date.now() - started },
      });
    };

    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      finish('timeout', 'TIMEOUT', `Port ${port} check timed out after ${Math.round(timeoutMs / 1000)}s`);
    }, timeoutMs);

    socket.on('lookup', () => { if (timing.dns === null) timing.dns = Date.now() - started; });
    socket.on('connect', () => {
      if (timing.connect === null) timing.connect = Date.now() - started;
      finish('success', null, null);
    });
    socket.on('error', (e) => {
      const code = e.code || '';
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return finish('error', 'DNS_ERROR', (e.message || 'Host not found').slice(0, 300));
      if (code === 'ECONNREFUSED') return finish('failed', 'CONNECTION_REFUSED', `Connection refused on port ${port}`);
      if (code === 'ETIMEDOUT') return finish('timeout', 'TIMEOUT', `Port ${port} check timed out after ${Math.round(timeoutMs / 1000)}s`);
      finish('error', null, (e.message || 'Connection failed').slice(0, 300));
    });
  });
}

/** SSL certificate check: expiry within ssl_expiry_days => SSL_EXPIRING. */
async function runSslCheck(job) {
  const started = Date.now();
  let host = extractHost(job.url);
  let port = 443;
  try {
    const u = new URL(/^https?:\/\//i.test(job.url) ? job.url : `https://${job.url}`);
    host = u.hostname.replace(/^\[|\]$/g, '');
    if (u.port) port = Number(u.port);
  } catch { /* keep bare host */ }
  const timeoutMs = (Number(job.timeout) || 30) * 1000;
  const expiryDays = job.ssl_expiry_days != null ? Number(job.ssl_expiry_days) : 14;

  try {
    await assertSafeHost(host);
  } catch {
    return { status: 'error', status_code: null, duration_ms: Date.now() - started, error: 'Request blocked by SSRF protection', error_code: null, response_body: null, response_headers: null, timing: null };
  }

  return new Promise((resolve) => {
    let done = false;
    const finish = (status, errorCode, errorText, tlsMs) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch {}
      resolve({
        status,
        status_code: null,
        duration_ms: Date.now() - started,
        error: errorText,
        error_code: errorCode,
        response_body: null,
        response_headers: null,
        timing: { dns_ms: null, connect_ms: tlsMs ?? null, tls_ms: tlsMs ?? null, first_byte_ms: tlsMs ?? null, total_ms: Date.now() - started },
      });
    };

    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs });
    const timer = setTimeout(() => finish('timeout', 'TIMEOUT', `TLS handshake timed out after ${Math.round(timeoutMs / 1000)}s`, null), timeoutMs);

    socket.on('secureConnect', () => {
      const tlsMs = Date.now() - started;
      let cert = null;
      try { cert = socket.getPeerCertificate(); } catch { cert = null; }
      if (!cert || !cert.valid_to) return finish('failed', 'TLS_ERROR', 'No TLS certificate presented', tlsMs);
      const validTo = new Date(cert.valid_to).getTime();
      if (!Number.isFinite(validTo)) return finish('failed', 'TLS_ERROR', 'Invalid TLS certificate dates', tlsMs);
      const daysLeft = Math.floor((validTo - Date.now()) / 86400000);
      if (socket.authorized === false && socket.authorizationError) {
        return finish('failed', 'TLS_ERROR', `Certificate verification failed: ${String(socket.authorizationError).slice(0, 120)}`, tlsMs);
      }
      if (daysLeft < 0) return finish('failed', 'TLS_ERROR', `Certificate expired ${-daysLeft} day(s) ago`, tlsMs);
      if (daysLeft < expiryDays) {
        return finish('failed', 'SSL_EXPIRING', `SSL certificate expires in ${daysLeft} day(s) (threshold ${expiryDays})`, tlsMs);
      }
      finish('success', null, null, tlsMs);
    });
    socket.on('error', (e) => {
      const code = e.code || '';
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return finish('error', 'DNS_ERROR', (e.message || 'Host not found').slice(0, 300), null);
      if (code === 'ETIMEDOUT' || e.message === 'ok') return finish('timeout', 'TIMEOUT', `TLS handshake timed out after ${Math.round(timeoutMs / 1000)}s`, null);
      const msg = (e.message || 'TLS connection failed').slice(0, 300);
      finish('failed', /certificate|tls|ssl|handshake/i.test(msg) ? 'TLS_ERROR' : null, msg, null);
    });
    socket.on('timeout', () => finish('timeout', 'TIMEOUT', `TLS handshake timed out after ${Math.round(timeoutMs / 1000)}s`, null));
  });
}

/** Dispatch a check by job type. Heartbeat jobs must not be dispatched. */
export async function runCheck(job) {
  const type = job.type || 'http';
  if (type === 'port') return runPortCheck(job);
  if (type === 'ssl') return runSslCheck(job);
  return runHttpCheck(job); // http + keyword
}
