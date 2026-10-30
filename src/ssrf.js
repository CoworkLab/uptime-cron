import dns from 'node:dns';
import net from 'node:net';
import { err } from './errors.js';

/**
 * SSRF protection for all outbound URLs (job url, failure/recovery/success webhooks).
 * - Only http(s), only ports 80/443
 * - Blocks loopback / private / link-local / metadata IPs (v4 + v6)
 * - Blocks localhost, *.internal, *.local and this app's own public host
 * - Resolves DNS and rejects if ANY resolved address is blocked
 * Always fails with generic 422 URL_INVALID (no internal detail leaks).
 */

const BLOCKED_HOSTNAMES = new Set([
  'localhost', 'ip6-localhost', 'ip6-loopback', 'metadata.google.internal',
]);
const BLOCKED_SUFFIXES = ['.internal', '.local', '.localdomain', '.onion'];

const OWN_HOSTS = new Set(['uptime-cron.onrender.com']);
if (process.env.RENDER_EXTERNAL_URL) {
  try { OWN_HOSTS.add(new URL(process.env.RENDER_EXTERNAL_URL).hostname.toLowerCase()); } catch {}
}

// ---- IPv4 helpers ----

const BLOCKED_V4 = [
  ['0.0.0.0', 8],        // "this" network
  ['10.0.0.0', 8],       // private
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local (cloud metadata: 169.254.169.254)
  ['172.16.0.0', 12],    // private
  ['192.168.0.0', 16],   // private
  ['100.64.0.0', 10],    // CGNAT / Tailscale-style
];

function v4ToInt(ip) {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    const v = Number(part);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function inV4Cidr(ip, base, bits) {
  const a = v4ToInt(ip);
  const b = v4ToInt(base);
  if (a === null || b === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

// ---- IPv6 helpers ----

const BLOCKED_V6 = [
  ['::1', 128],        // loopback
  ['::', 128],         // unspecified
  ['fc00::', 7],       // unique local
  ['fe80::', 10],      // link-local
];

function v6ToBigInt(ip) {
  let addr = ip;
  const zone = addr.indexOf('%');
  if (zone !== -1) addr = addr.slice(0, zone);

  // Canonical IPv4-mapped form ::ffff:a.b.c.d -> expand v4 into two hex groups
  const m = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (m) {
    const v4 = v4ToInt(m[1]);
    if (v4 === null) return null;
    addr = '::ffff:' + ((v4 >> 16) & 0xffff).toString(16) + ':' + (v4 & 0xffff).toString(16);
  }

  const dc = addr.split('::');
  if (dc.length > 2) return null;
  const head = dc[0] ? dc[0].split(':').filter(Boolean) : [];
  const tail = dc.length === 2 && dc[1] ? dc[1].split(':').filter(Boolean) : [];
  if (dc.length === 1 && head.length !== 8) return null;
  if (dc.length === 2 && head.length + tail.length > 7) return null;
  const fill = 8 - head.length - tail.length;

  let big = 0n;
  for (const g of head) {
    const v = parseInt(g, 16);
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) return null;
    big = (big << 16n) | BigInt(v);
  }
  for (let i = 0; i < fill; i++) big <<= 16n;
  for (const g of tail) {
    const v = parseInt(g, 16);
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) return null;
    big = (big << 16n) | BigInt(v);
  }
  return big;
}

function inV6Cidr(ipBig, base, bits) {
  const b = v6ToBigInt(base);
  if (ipBig === null || b === null) return false;
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
  return (ipBig & mask) === (b & mask);
}

/** True if the IP must never be contacted. Handles IPv4, IPv6 and v4-mapped v6. */
export function isBlockedIp(rawIp) {
  const ip = String(rawIp || '').trim().toLowerCase();
  if (!ip) return true;
  if (net.isIPv4(ip)) {
    for (const [base, bits] of BLOCKED_V4) if (inV4Cidr(ip, base, bits)) return true;
    return false;
  }
  const big = v6ToBigInt(ip);
  if (big === null) return true; // unparseable -> treat as blocked
  const mapped = (big >> 32n) === 0xffffn; // ::ffff:0:0/96 — IPv4-mapped
  if (mapped) {
    const v4 = `${Number((big >> 24n) & 0xffn)}.${Number((big >> 16n) & 0xffn)}.${Number((big >> 8n) & 0xffn)}.${Number(big & 0xffn)}`;
    for (const [base, bits] of BLOCKED_V4) if (inV4Cidr(v4, base, bits)) return true;
    return false;
  }
  for (const [base, bits] of BLOCKED_V6) if (inV6Cidr(big, base, bits)) return true;
  return false;
}

function cleanHostname(hostname) {
  return String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
}

/**
 * Validate an outbound URL. Throws generic URL_INVALID on anything unsafe.
 * @param {string} urlStr
 * @returns {Promise<string>} the original URL when safe
 */
export async function assertSafeUrl(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    throw err.urlInvalid();
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw err.urlInvalid();

  const port = u.port === '' ? (u.protocol === 'https:' ? '443' : '80') : u.port;
  if (port !== '80' && port !== '443') throw err.urlInvalid();

  const host = cleanHostname(u.hostname);
  if (!host) throw err.urlInvalid();
  if (OWN_HOSTS.has(host)) throw err.urlInvalid();
  if (BLOCKED_HOSTNAMES.has(host)) throw err.urlInvalid();
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) throw err.urlInvalid();

  if (net.isIPv4(host) || net.isIPv6(host)) {
    if (isBlockedIp(host)) throw err.urlInvalid();
    return urlStr;
  }

  let addrs;
  try {
    addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch {
    throw err.urlInvalid(); // generic: cannot resolve
  }
  if (!addrs || !addrs.length) throw err.urlInvalid();
  for (const a of addrs) {
    if (isBlockedIp(a.address)) throw err.urlInvalid();
  }
  return urlStr;
}

/** Validate an optional webhook URL (empty -> null). */
export async function assertSafeWebhookUrl(value, vOptionalUrl) {
  const v = vOptionalUrl(value);
  if (!v) return null;
  return assertSafeUrl(v);
}

/**
 * DNS lookup wrapper for live requests: re-validates resolved addresses
 * right before the socket connects (DNS-rebind protection).
 * Supports both lookup modes Node requests:
 *  - all:true  (autoSelectFamily/Happy Eyeballs) -> callback(null, [{address, family}...])
 *  - all:false -> callback(null, address, family)
 */
export function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options }, (e, address, family) => {
    if (e) return callback(e);
    if (Array.isArray(address)) {
      const safe = address.filter((a) => a && !isBlockedIp(a.address));
      if (!safe.length) {
        const be = new Error('Blocked address');
        be.code = 'ESSRFBLOCKED';
        return callback(be);
      }
      return callback(null, safe);
    }
    if (isBlockedIp(address)) {
      const be = new Error('Blocked address');
      be.code = 'ESSRFBLOCKED';
      return callback(be);
    }
    callback(null, address, family);
  });
}
