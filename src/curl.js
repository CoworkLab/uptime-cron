import { err } from './errors.js';

/** Tokenize a curl command respecting single/double quotes. */
function tokenize(input) {
  const tokens = [];
  let cur = '';
  let quote = null;
  const s = input.trim();
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\' && quote === '"' && s[i + 1]) {
        cur += s[i + 1];
        i++;
      } else if (c === quote) {
        quote = null;
      } else {
        cur += c;
      }
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '\\' && s[i + 1]) {
      cur += s[i + 1];
      i++;
    } else if (/\s/.test(c)) {
      if (cur) tokens.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

const URL_FLAGS = new Set(['--url', '-X', '--request']);
const IGNORED_FLAGS = new Set([
  '-L', '--location', '-s', '--silent', '-S', '--show-error', '-k', '--insecure',
  '-v', '--verbose', '--compressed', '-i', '--include', '-#, --progress-bar',
  '-#', '--progress-bar', '--http1.1', '--http2', '-4', '-6', '--no-buffer', '-f', '--fail',
]);

/**
 * Parse a curl command into { method, url, headers, body }.
 * Supports: -X/--request, -H/--header, -d/--data/--data-raw/--data-binary, -u/--user,
 * --json, --url, bare URL. Rejects multipart (-F) cleanly.
 */
export function parseCurlCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) {
    throw err.validation('curl is required (paste the full curl command)');
  }
  const trimmed = cmd.trim().replace(/^curl\s+/i, '').replace(/^curl$/i, '');
  const tokens = tokenize(trimmed);

  let method = null;
  let url = null;
  const headers = {};
  let body = null;
  let basicAuth = null;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-X' || t === '--request') {
      method = (tokens[++i] || '').toUpperCase();
    } else if (t === '-H' || t === '--header') {
      const raw = tokens[++i] || '';
      const idx = raw.indexOf(':');
      if (idx > 0) {
        const k = raw.slice(0, idx).trim();
        const v = raw.slice(idx + 1).trim();
        if (k) headers[k] = v;
      } else if (raw.endsWith(';')) {
        // "Header;" with no value — remove that header if set
        delete headers[raw.slice(0, -1).trim()];
      }
    } else if (['-d', '--data', '--data-raw', '--data-binary', '--data-ascii'].includes(t)) {
      body = tokens[++i] ?? '';
      if (!method) method = 'POST';
    } else if (t === '--data-urlencode') {
      body = tokens[++i] ?? '';
      if (!method) method = 'POST';
      headers['Content-Type'] = headers['Content-Type'] || 'application/x-www-form-urlencoded';
    } else if (t === '--json') {
      body = tokens[++i] ?? '';
      headers['Content-Type'] = 'application/json';
      headers['Accept'] = 'application/json';
      if (!method) method = 'POST';
    } else if (t === '-u' || t === '--user') {
      basicAuth = tokens[++i] || '';
    } else if (t === '--url') {
      url = tokens[++i] || url;
    } else if (t === '-F' || t === '--form' || t === '--form-string') {
      throw err.validation('Multipart form (-F) is not supported. Convert it to a raw body with an explicit Content-Type header.');
    } else if (IGNORED_FLAGS.has(t)) {
      continue;
    } else if (t.startsWith('-') && t.length > 1) {
      // Unknown flag — skip it; if the next token looks like its value, skip it too
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('-')) i++;
      continue;
    } else if (!url) {
      url = t;
    }
  }

  if (basicAuth) {
    headers['Authorization'] = 'Basic ' + Buffer.from(basicAuth).toString('base64');
  }
  delete headers['Content-Length'];
  delete headers['content-length'];

  if (!url) throw err.validation('Could not find a URL in the curl command');

  return {
    method: method || (body !== null ? 'POST' : 'GET'),
    url,
    headers,
    body: body !== null && body !== '' ? body : null,
  };
}
