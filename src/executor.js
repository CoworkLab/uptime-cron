import http from 'node:http';
import https from 'node:https';
import { assertSafeUrl, safeLookup } from './ssrf.js';
import { isValidTimezone } from './cron.js';

const MAX_BODY_BYTES = 4096;
const KEYWORD_READ_LIMIT = 256 * 1024; // keyword search reads first 256 KB
const MAX_HEADERS_BYTES = 2048;
const MAX_REDIRECTS = 5;
const REDIRECT_METHODS = new Set([301, 302, 303]);

function mapNetworkErrorCode(e) {
  const code = e.code || '';
  const msg = String(e.message || '').toLowerCase();
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENODATA') return 'DNS_ERROR';
  if (code === 'ECONNREFUSED') return 'CONNECTION_REFUSED';
  if (code.startsWith('ERR_TLS') || code.startsWith('CERT') || msg.includes('certificate') || msg.includes('ssl') || msg.includes('tls')) return 'TLS_ERROR';
  return null;
}

function truncateStr(s, cap) {
  return s.length > cap ? s.slice(0, cap) + '…[truncated]' : s;
}

function decodeChunks(chunks, cap) {
  let got = 0;
  const all = [];
  for (const c of chunks) {
    if (got + c.length > cap) {
      all.push(c.subarray(0, cap - got));
      got = cap;
      break;
    }
    all.push(c);
    got += c.length;
  }
  const buf = Buffer.concat(all);
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

/** Read at most `cap` bytes from an IncomingMessage. Never throws. */
function readCappedStream(stream, cap) {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    stream.on('data', (c) => {
      if (done) return;
      chunks.push(c);
      if (chunks.reduce((n, x) => n + x.length, 0) >= cap) {
        stream.destroy();
        finish(decodeChunks(chunks, cap) + '…[truncated]');
      }
    });
    stream.once('end', () => finish(decodeChunks(chunks, cap)));
    stream.once('error', () => finish(null));
    stream.once('aborted', () => finish(null));
    stream.once('close', () => finish((chunks.length ? decodeChunks(chunks, cap) : null)));
  });
}

/** Replace %date% %time% %timestamp% %job_id% in url/body, in the job's timezone. */
function applyUrlVariables(input, job) {
  if (!input || typeof input !== 'string' || !input.includes('%')) return input;
  let tz = job.timezone || 'UTC';
  if (!isValidTimezone(tz)) tz = 'UTC';
  const now = new Date();
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now);
  return input
    .replaceAll('%date%', date)
    .replaceAll('%time%', time)
    .replaceAll('%timestamp%', String(Math.floor(now.getTime() / 1000)))
    .replaceAll('%job_id%', job.id || '');
}

function buildRequestHeaders(job) {
  let headers;
  try { headers = JSON.parse(job.headers || '{}'); } catch { headers = {}; }
  if (typeof headers !== 'object' || Array.isArray(headers) || headers === null) headers = {};
  if (!headers['User-Agent'] && !headers['user-agent']) headers['User-Agent'] = 'uptime-cron/1.1';

  let auth = null;
  try { auth = job.auth ? JSON.parse(job.auth) : null; } catch { auth = null; }
  if (auth && auth.type === 'basic' && auth.username != null && auth.password != null) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
  }
  return headers;
}

/**
 * Single HTTP hop. Resolves when response headers arrive with
 * { statusCode, headers, stream, timing, cleanup }.
 * `state.timedOut` is set when the hop-level timeout destroys the request.
 */
function requestHop(urlStr, { method, headers, body, timeoutMs }, state) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error('Invalid URL')); }

    const mod = u.protocol === 'https:' ? https : http;
    const timing = { start: Date.now(), dns: null, connect: null, tls: null, firstByte: null };
    const finalHeaders = { ...headers };
    if (body != null && finalHeaders['Content-Length'] === undefined) {
      finalHeaders['Content-Length'] = Buffer.byteLength(body);
    }

    const req = mod.request(u, { method, headers: finalHeaders, lookup: safeLookup }, (res) => {
      if (timing.firstByte === null) timing.firstByte = Date.now() - timing.start;
      resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        stream: res,
        timing,
        cleanup: () => clearTimeout(timer),
      });
    });

    req.on('socket', (socket) => {
      socket.once('lookup', () => { if (timing.dns === null) timing.dns = Date.now() - timing.start; });
      socket.once('connect', () => { if (timing.connect === null) timing.connect = Date.now() - timing.start; });
      socket.once('secureConnect', () => { if (timing.tls === null) timing.tls = Date.now() - timing.start; });
    });

    req.on('error', (e) => reject(e));

    const timer = setTimeout(() => {
      state.timedOut = true;
      const te = new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
      te.name = 'TimeoutError';
      req.destroy(te);
    }, timeoutMs);

    if (body != null) req.write(body);
    req.end();
  });
}

/**
 * Execute a job's HTTP request with SSRF checks, manual redirects and timing.
 * opts.readLimit: how much of the response body to read (default 4 KB;
 *   keyword checks pass 256 KB so the keyword search sees enough of the body).
 * Returns { status, status_code, duration_ms, error, error_code, response_body, response_headers, timing }
 * status: success | failed | timeout | error
 * error_code (network-level): TIMEOUT | DNS_ERROR | CONNECTION_REFUSED | TLS_ERROR | null
 */
export async function executeJob(job, opts = {}) {
  const started = Date.now();
  const timeoutMs = (Number(job.timeout) || 30) * 1000;
  const state = { timedOut: false };
  const readLimit = Math.min(Math.max(Number(opts.readLimit) || MAX_BODY_BYTES, MAX_BODY_BYTES), KEYWORD_READ_LIMIT);

  const followRedirects = job.follow_redirects === undefined || job.follow_redirects === null
    ? true
    : !!Number(job.follow_redirects);
  const redirectIsSuccess = !!Number(job.redirect_is_success);
  const saveResponses = !(job.save_responses === 0 || job.save_responses === false);
  const wantBody = saveResponses || readLimit > MAX_BODY_BYTES;

  let status = 'error';
  let statusCode = null;
  let errorText = null;
  let errorCode = null;
  let responseBody = null;
  let responseHeaders = null;
  let timing = null;

  const method = job.method || 'GET';
  let currentUrl = applyUrlVariables(job.url, job);
  let currentMethod = method;
  let currentBody = ['GET', 'HEAD'].includes(method) ? null : (applyUrlVariables(job.body, job) ?? null);
  const baseHeaders = buildRequestHeaders(job);

  let hopTiming = null;
  let redirects = 0;

  try {
    // Pre-flight SSRF validation (DNS resolve + IP check) — spec: re-check at execution time
    await assertSafeUrl(currentUrl);

    for (;;) {
      const res = await requestHop(currentUrl, { method: currentMethod, headers: baseHeaders, body: currentBody, timeoutMs }, state);
      hopTiming = res.timing;
      const sc = Number(res.statusCode) || 0;
      const is3xx = sc >= 300 && sc < 400;
      const location = res.headers && res.headers.location;

      if (is3xx && location) {
        if (redirectIsSuccess) {
          // Treat redirect as final success — do not follow
          res.stream.destroy();
          res.cleanup();
          statusCode = sc;
          status = 'success';
          break;
        }
        if (followRedirects && redirects < MAX_REDIRECTS) {
          redirects++;
          const nextUrl = new URL(location, currentUrl).toString();
          res.stream.destroy();
          res.cleanup();
          await assertSafeUrl(nextUrl); // re-validate every hop
          currentUrl = nextUrl;
          if (REDIRECT_METHODS.has(sc) && currentMethod !== 'HEAD') {
            currentMethod = 'GET';
            currentBody = null;
          }
          continue;
        }
        if (followRedirects && redirects >= MAX_REDIRECTS) {
          res.stream.destroy();
          res.cleanup();
          status = 'error';
          errorText = 'Too many redirects (max 5)';
          break;
        }
        // follow_redirects=false -> terminal 3xx falls through to normal handling
      }

      // Terminal response
      statusCode = sc;
      status = sc >= 200 && sc < 300 ? 'success' : 'failed';
      if (wantBody) {
        responseBody = await readCappedStream(res.stream, readLimit);
      } else {
        res.stream.destroy();
      }
      try {
        const flat = {};
        for (const [k, v] of Object.entries(res.headers || {})) flat[k] = Array.isArray(v) ? v.join(', ') : v;
        responseHeaders = truncateStr(JSON.stringify(flat), MAX_HEADERS_BYTES);
      } catch { responseHeaders = null; }
      res.cleanup();
      break;
    }

    if (state.timedOut) {
      status = 'timeout';
      errorText = `Request timed out after ${Math.round(timeoutMs / 1000)}s`;
    }

    if (hopTiming) {
      timing = {
        dns_ms: hopTiming.dns,
        connect_ms: hopTiming.connect,
        tls_ms: hopTiming.tls,
        first_byte_ms: hopTiming.firstByte,
        total_ms: Date.now() - started,
      };
    }
  } catch (e) {
    if (state.timedOut || e.name === 'TimeoutError' || e.code === 'ETIMEDOUT') {
      status = 'timeout';
      errorCode = 'TIMEOUT';
      errorText = `Request timed out after ${Math.round(timeoutMs / 1000)}s`;
    } else if (e.code === 'ESSRFBLOCKED' || (e.status === 422 && e.code === 'URL_INVALID')) {
      status = 'error';
      errorText = 'Request blocked by SSRF protection';
    } else {
      status = 'error';
      errorCode = mapNetworkErrorCode(e);
      errorText = (e.cause?.message || e.message || 'Request failed').slice(0, 500);
    }
  }

  return {
    status,
    status_code: statusCode,
    duration_ms: Date.now() - started,
    error: errorText,
    error_code: errorCode,
    response_body: responseBody,
    response_headers: responseHeaders,
    timing,
  };
}
