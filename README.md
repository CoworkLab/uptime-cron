# uptime-cron

Self-hosted, cron-job.org style **scheduling API** (no UI — API only) with **Telegram-scoped multi-user jobs**. Built to run free on Render, with Turso (libSQL) as the database. **v1.1.0**

- Node 20 + Express
- Turso (libSQL) cloud storage — survives restarts, deploys and free-tier spin-downs
- Per-user job isolation via Telegram IDs (perfect backend for a Telegram bot)
- Dev key for full global admin access
- Minimum schedule interval: **2 minutes** (strictly validated, including tricky cron gaps)
- **SSRF protection**: job URLs and webhook URLs are validated on create/update/import *and* re-validated at execution time (after DNS resolve, every redirect hop)
- **Webhook events**: `failed`, `auto_disabled`, `recovered`, `success`
- **Auto-disable** after N consecutive failures
- **Timing breakdown** (dns/connect/tls/first-byte) per execution
- Clean, consistent JSON responses — one envelope everywhere

---

## Auth

Send your key with every request (except `/healthz` and `/`):

```
Authorization: Bearer <api_key>
```
(`X-API-Key: <api_key>` header also accepted)

| Key type | Who | Powers |
|---|---|---|
| `uc_dev_...` | Bot developer / admin | Everything: all users, all jobs, global stats, register users |
| `uc_user_...` | Telegram user (via bot) | Only their own jobs — automatically scoped, cannot be bypassed |

### Bot integration flow

```
1. New Telegram user -> bot calls POST /v1/users (dev key) { telegram_id, username }
2. Store the returned api_key for that user
3. Bot performs all user actions with the user's key (scoping is automatic)
```

Shortcut: the dev key + `telegram_id` in the request body also works for any user operation.

---

## Schedules (all accepted forms)

| Form | Example | Notes |
|---|---|---|
| 5-field cron | `0 9 * * *` | Standard cron |
| Presets | `@hourly`, `@daily`, `@weekly`, `@monthly` | |
| True interval | `@every 5m`, `@every 30m`, `@every 2h` | Min 2 minutes |
| Object | `{"cron":"0 9 * * *","timezone":"Asia/Kolkata"}` | |
| cron-job.org style | `{"minutes":[0,30],"hours":[9],"mdays":["*"],"wdays":["*"],"months":["*"]}` | Converted internally |

**2-minute rule:** before a job is accepted, the engine computes the next runs and rejects any schedule whose smallest gap is below 120 seconds — so `*/1 * * * *`, `0,1 * * * *`, `{"minutes":[0,1]}` and `@every 90s` are all rejected with `INTERVAL_TOO_SHORT`. Seconds-level (6-field) crons are not supported.

Timezone: any IANA timezone (default from `DEFAULT_TIMEZONE` env, e.g. `Asia/Kolkata`).

---

## Endpoints (28)

### Open
| Method | Path | Description |
|---|---|---|
| GET | `/` | API info |
| GET | `/healthz` | Keep-alive ping -> `{ "ok": true }` |

### Any valid key
| Method | Path | Description |
|---|---|---|
| GET | `/v1/me` | Key info, quota usage |
| POST | `/v1/jobs` | Create job |
| GET | `/v1/jobs` | List jobs (`?search&enabled&status&tag&folder&sort&order&limit&offset`) |
| GET | `/v1/jobs/:id` | Job detail + last execution |
| PATCH / PUT | `/v1/jobs/:id` | Update (partial / full) |
| DELETE | `/v1/jobs/:id` | Delete job + history |
| POST | `/v1/jobs/:id/stop` | Pause |
| POST | `/v1/jobs/:id/start` | Resume |
| POST | `/v1/jobs/:id/run` | Run now (async) |
| GET | `/v1/jobs/:id/history` | Execution logs (`?status&limit&offset`) |
| GET | `/v1/jobs/:id/history/:execId` | Single execution (with full response body) |
| DELETE | `/v1/jobs/:id/history` | Clear logs |
| GET | `/v1/jobs/:id/stats` | Success rate, avg duration, next runs |
| GET | `/v1/folders` | Folder list with job counts (`?telegram_id=` for dev) |
| POST | `/v1/jobs/bulk` | `{ action: "pause"\|"resume"\|"delete"\|"run", job_ids: [...] }` |
| POST | `/v1/jobs/import/curl` | Import from a curl command (`create: true` to create directly) |
| POST | `/v1/meta/preview-schedule` | Next N run times + human text |
| POST | `/v1/meta/parse-cron` | Cron -> human text |
| GET | `/v1/meta/timezones` | Common timezones |

### Dev key only
| Method | Path | Description |
|---|---|---|
| POST | `/v1/users` | Register Telegram user -> generates `api_key` |
| GET | `/v1/users` | List users + job counts |
| GET | `/v1/users/:telegram_id` | User detail + their jobs |
| DELETE | `/v1/users/:telegram_id` | Delete user (cascade: jobs + history) |
| POST | `/v1/users/:telegram_id/regenerate-key` | Rotate user key |
| GET | `/v1/stats` | Global stats |

---

## Response format

```json
{ "ok": true, "data": { ... } }
```
```json
{ "ok": false, "error": { "code": "JOB_NOT_FOUND", "message": "Job not found or does not belong to you", "status": 404 } }
```

Error codes: `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `JOB_NOT_FOUND`, `EXECUTION_NOT_FOUND`, `USER_NOT_FOUND`, `USER_ALREADY_EXISTS`, `VALIDATION_ERROR`, `URL_INVALID`, `INTERVAL_TOO_SHORT`, `QUOTA_EXCEEDED`, `RATE_LIMITED`, `PAYLOAD_TOO_LARGE`, `INVALID_JSON`, `INTERNAL_ERROR`.

## Examples

Create a job:
```bash
curl -X POST https://<your-host>/v1/jobs \
  -H "Authorization: Bearer <api_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Morning ping",
    "url": "https://example.com/api/ping",
    "method": "POST",
    "headers": {"Authorization": "Bearer xyz"},
    "body": "{\"hello\":\"world\"}",
    "schedule": "0 9 * * *",
    "timezone": "Asia/Kolkata",
    "max_retries": 2,
    "retry_interval": 60,
    "failure_webhook": "https://your-bot.example/notify"
  }'
```

Import from curl:
```bash
curl -X POST https://<your-host>/v1/jobs/import/curl \
  -H "Authorization: Bearer <api_key>" \
  -H "Content-Type: application/json" \
  -d '{"create": true, "schedule": "@every 10m", "curl": "curl -X POST https://api.example.com/ping -H \"X-Token: abc\""}'
```

## Job fields

| Field | Default | Limits |
|---|---|---|
| `url` | required | http(s), max 2048 chars, **SSRF-validated** (public IPs only, ports 80/443) |
| `method` | `GET` | GET/POST/PUT/PATCH/DELETE/HEAD |
| `headers` | `{}` | max 20 entries |
| `body` | null | max 64 KB, body-methods only. Supports `%date%` `%time%` `%timestamp%` `%job_id%` |
| `schedule` | required | see above, min 2-minute gap |
| `timezone` | `DEFAULT_TIMEZONE` | IANA name (also used for URL variables) |
| `timeout` | 30 | 5-60 seconds |
| `max_retries` | 0 | 0-3 |
| `retry_interval` | 60 | 30-3600 seconds |
| `failure_webhook` | null | POSTed on final failure (`event: "failed"`) or auto-disable (`event: "auto_disabled"`) |
| `recovery_webhook` | null | POSTed when a job succeeds again after failures (`event: "recovered"`) |
| `success_webhook` | null | POSTed on every successful run (`event: "success"`) |
| `auto_disable_after` | 0 | 0-100; 0 = off. Auto-pause after N consecutive failed runs (`disabled_reason: "auto_disabled_after_failures"`) |
| `follow_redirects` | true | max 5 redirects (each hop SSRF-revalidated) |
| `redirect_is_success` | false | treat any 3xx as success without following |
| `auth` | null | `{"type":"basic","username":"...","password":"..."}` — sent as Basic auth header; password is masked as `***` in responses and never returned |
| `folder` | null | max 60 chars; filter with `GET /v1/jobs?folder=name` |
| `save_responses` | true | store first 4 KB of response + response headers (2 KB) |
| `tags` | `[]` | max 5 |
| `expires_at` | null | auto-disable after this time (`disabled_reason: "expired"`) |
| `enabled` | true | manual pause sets `disabled_reason: "paused_by_user"` |

Job responses additionally expose read-only status: `disabled_reason`, `last_status`, `last_status_code`, `last_duration_ms`, `run_count`, `fail_count`, `consecutive_fails`, `next_run_at`, `last_run_at`.

## SSRF protection

All outbound URLs (job `url`, `failure_webhook`, `recovery_webhook`, `success_webhook`) are checked:

- on **create**, **update** and **curl import** -> rejected with `422 URL_INVALID`
- at **execution time** again: DNS is resolved and the actual connect address is re-validated (DNS-rebind safe), including **every redirect hop**

Blocked: loopback/private/link-local ranges (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `0.0.0.0/8`, CGNAT), IPv6 equivalents (`::1`, `fc00::/7`, `fe80::/10`), `localhost`, `*.internal`, `*.local`, this app's own public URL, non-80/443 ports.

## Webhook events

All webhooks are `POST`ed as JSON with `User-Agent: uptime-cron/1.1`:

| Event | Fired to | Payload |
|---|---|---|
| `failed` | `failure_webhook` | `{event, occurred_at, job:{id,title,telegram_id,url,method,schedule}, execution:{status,status_code,duration_ms,error,attempts_used}}` |
| `auto_disabled` | `failure_webhook` | `{event, occurred_at, job:{id,title,telegram_id}, auto_disable_after, consecutive_fails, last_error}` |
| `recovered` | `recovery_webhook` | `{event:"recovered", job_id, title, downtime_runs, at}` |
| `success` | `success_webhook` | `{event:"success", job_id, status_code, duration_ms}` |

## Execution history

`GET /v1/jobs/:id/history/:execId` returns the full execution including:

```json
{
  "execution": {
    "id": "exe_...",
    "status": "success",
    "status_code": 200,
    "duration_ms": 412,
    "timing": { "dns_ms": 8, "connect_ms": 35, "tls_ms": 90, "first_byte_ms": 180, "total_ms": 410 },
    "response_headers": { "content-type": "text/html; charset=UTF-8", "...": "..." },
    "response_body": "<!doctype html>…"
  }
}
```

List view (`/history`) stays lean (no body/headers/timing). `duration_ms` is unchanged and backward compatible.

## Scheduler engine

- 10-second tick loop; due jobs claimed atomically (no double runs)
- Concurrency cap 20; per-job timeout 5-60s
- Retries with interval; `failure_webhook` fires on final failure
- Auto-disable after `auto_disable_after` consecutive failures (webhook event `auto_disabled`)
- Recovery detection: success after failures fires `recovery_webhook` with the number of downtime runs
- SSRF re-validation before every request and every redirect hop (max 5)
- URL variables `%date%`, `%time%`, `%timestamp%`, `%job_id%` substituted at run time in the job's timezone
- History: last 50 executions per job (auto-trimmed)
- Missed-while-down jobs run once on wake-up (catch-up), then normal schedule

## Limits (env-configurable)

| Env | Default | Meaning |
|---|---|---|
| `USER_JOB_LIMIT` | 25 | Jobs per Telegram user (dev unlimited) |
| `MIN_INTERVAL_SECONDS` | 120 | Minimum schedule gap |
| `HISTORY_LIMIT` | 50 | Executions kept per job |
| `MAX_CONCURRENCY` | 20 | Parallel executions |
| `RATE_LIMIT_PER_MIN` | 120 | API requests per key per minute |
| `DEFAULT_TIMEZONE` | UTC | Default timezone |

## Deploy (Render free)

1. Push this repo to GitHub
2. Render -> New Web Service -> connect repo
3. Runtime: Node, Build: `npm install`, Start: `node src/server.js`
4. Env vars: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `DEV_API_KEY`, `DEFAULT_TIMEZONE`
5. Keep it awake: external pinger on `/healthz` every 5 minutes (free-tier services sleep after 15 idle minutes)

Create a free Turso database at [turso.tech](https://turso.tech) — tables are created automatically on first boot.
