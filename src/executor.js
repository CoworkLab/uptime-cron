const MAX_BODY_BYTES = 4096;

async function readCapped(res, cap) {
  try {
    if (!res.body) return null;
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    while (got < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      if (got >= cap) {
        reader.cancel().catch(() => {});
        break;
      }
    }
    const all = new Uint8Array(got);
    let off = 0;
    for (const c of chunks) {
      all.set(c, off);
      off += c.length;
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(all.slice(0, cap));
    return got > cap ? text.slice(0, text.length) + '…[truncated]' : text;
  } catch {
    return null;
  }
}

/**
 * Execute a job's HTTP request once.
 * Returns { status, status_code, duration_ms, error, response_body }
 * status: success | failed | timeout | error
 */
export async function executeJob(job) {
  const started = Date.now();
  let status = 'error';
  let statusCode = null;
  let errorText = null;
  let responseBody = null;

  let headers;
  try {
    headers = JSON.parse(job.headers || '{}');
  } catch {
    headers = {};
  }
  if (!headers['User-Agent'] && !headers['user-agent']) {
    headers['User-Agent'] = 'uptime-cron/1.0';
  }

  let body;
  if (!['GET', 'HEAD'].includes(job.method) && job.body != null && job.body !== '') {
    body = job.body;
  }

  try {
    const res = await fetch(job.url, {
      method: job.method,
      headers,
      body,
      redirect: 'follow',
      signal: AbortSignal.timeout(job.timeout * 1000),
    });
    statusCode = res.status;
    status = res.ok ? 'success' : 'failed';
    if (job.save_responses) {
      responseBody = await readCapped(res, MAX_BODY_BYTES);
    } else {
      res.body?.cancel?.().catch(() => {});
    }
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      status = 'timeout';
      errorText = `Request timed out after ${job.timeout}s`;
    } else {
      status = 'error';
      errorText = (e.cause?.message || e.message || 'Request failed').slice(0, 500);
    }
  }

  return {
    status,
    status_code: statusCode,
    duration_ms: Date.now() - started,
    error: errorText,
    response_body: responseBody,
  };
}
