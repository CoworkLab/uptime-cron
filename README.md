# uptime-cron

Self-hosted, cron-job.org style **scheduling + uptime monitoring API** (no UI — API only) with **Telegram-scoped multi-user jobs**. Built to run free on Render, with Turso (libSQL) as the database. **v1.2.0**

- Node 20 + Express
- Turso (libSQL) cloud storage — survives restarts, deploys and free-tier spin-downs
- Per-user job isolation via Telegram IDs (perfect backend for a Telegram bot)
- Dev key for full global admin access
- Minimum schedule interval: **2 minutes** (strictly validated, including tricky cron gaps)
- **SSRF protection**: job URLs and webhook URLs are validated on create/update/import *and* re-validated at execution time (after DNS resolve, every redirect hop)
- **Webhook events**: `failed`, `auto_disabled`, `recovered`, `success` (+ `down`, `up`, `ssl_expiring`, `heartbeat_missed` to alert contacts)
- **Uptime monitoring (v1.2.0)**: monitor types `http | keyword | port | ssl | heartbeat`, job states (`up/down/paused/pending`), incidents, uptime %, response-times, dashboards, alert contacts (telegram/email/webhook/discord/slack), maintenance windows, public status pages, CSV export

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

## Endpoints (53)

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
| GET | `/v1/jobs/:id/stats` | Success rate, avg duration, next runs (+ `state`, `uptime_24h_percent`) |
| GET | `/v1/jobs/:id/incidents` | Incidents of one job (`?ongoing=true&limit&offset`) |
| GET | `/v1/jobs/:id/uptime` | `{uptime_percent, downtime_seconds, incidents, avg_response_ms, p95_response_ms}` (`?range=24h\|7d\|30d\|90d`) |
| GET | `/v1/jobs/:id/response-times` | Downsampled chart points (`?range=&points=`) |
| GET | `/v1/jobs/:id/history.csv` | CSV export of history |
| GET | `/v1/incidents` | All incidents of the caller's jobs (`?job_id&ongoing&limit&offset`) |
| GET | `/v1/dashboard` | `{jobs:{total,up,down,paused,pending}, ongoing_incidents, uptime_24h_percent, avg_response_ms}` |
| GET | `/v1/folders` | Folder list with job counts (`?telegram_id=` for dev) |
| POST | `/v1/jobs/bulk` | `{ action: "pause"\|"resume"\|"delete"\|"run", job_ids: [...] }` |
| POST | `/v1/jobs/import/curl` | Import from a curl command (`create: true` to create directly) |
| POST | `/v1/meta/preview-schedule` | Next N run times + human text |
| POST | `/v1/meta/parse-cron` | Cron -> human text |
| GET | `/v1/meta/timezones` | Common timezones |
| POST/GET/GET:id/PATCH/DELETE | `/v1/contacts` | Alert contacts (+ `POST /v1/contacts/:id/test`) |
| POST/GET/GET:id/PATCH/DELETE | `/v1/maintenance` | Maintenance windows |
| POST/GET/GET:id/PATCH/DELETE | `/v1/status-pages` | Public status pages |
| GET/POST | `/v1/heartbeat/:token` | **Public** heartbeat ping (rate limited 60/min) |
| GET | `/status/:slug` | **Public** HTML status page (cached 30s, light/dark) |
| GET | `/status/:slug/json` | **Public** status JSON |

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

Error codes: `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `JOB_NOT_FOUND`, `EXECUTION_NOT_FOUND`, `USER_NOT_FOUND`, `USER_ALREADY_EXISTS`, `VALIDATION_ERROR`, `URL_INVALID`, `INTERVAL_TOO_SHORT`, `QUOTA_EXCEEDED`, `RATE_LIMITED`, `PAYLOAD_TOO_LARGE`, `INVALID_JSON`, `INTERNAL_ERROR`, `CONTACT_NOT_FOUND`, `MAINTENANCE_NOT_FOUND`, `STATUS_PAGE_NOT_FOUND`, `SLUG_TAKEN`, `INVALID_JOB_TYPE`.

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

## Uptime monitoring (v1.2.0)

**A monitor is a job.** New optional `type` on the job object (default `http` — all v1.1 behavior unchanged):

| Type | Extra fields | Check |
|---|---|---|
| `http` | `expected_status` (e.g. `["200-299","301"]`, default 200-299), `max_response_ms` | status/rule checks |
| `keyword` | + `keyword` (max 200), `keyword_mode` (`exists`\|`not_exists`), `keyword_case_sensitive` | keyword searched in first 256 KB of body |
| `port` | `port` (1-65535, required); `url` holds the host; no method/body/headers | TCP connect check |
| `ssl` | `ssl_expiry_days` (default 14); `url` must be https | certificate expiry/validity |
| `heartbeat` | `heartbeat_grace_seconds` (default 60); `url` optional; schedule = `@every` interval; `heartbeat_url` returned | no outgoing request — you ping `/v1/heartbeat/:token` |

Invalid combos are rejected with `422 VALIDATION_ERROR`; a wrong `type` gives `422 INVALID_JOB_TYPE`.

Read-only job fields: `state` (`up`\|`down`\|`paused`\|`pending`), `state_changed_at`, `last_error_code` (`TIMEOUT`, `DNS_ERROR`, `CONNECTION_REFUSED`, `TLS_ERROR`, `STATUS_MISMATCH`, `KEYWORD_MISSING`, `KEYWORD_FOUND`, `SLOW_RESPONSE`, `SSL_EXPIRING`, `HEARTBEAT_MISSED`), `heartbeat_url`.

- State machine: success -> `up`, all retries failed -> `down`, disabled -> `paused`, never checked -> `pending`. Filter jobs with `?state=` and `?type=`.
- **Incidents**: opened on down, closed on up (with `duration_seconds`). `GET /v1/jobs/:id/incidents` and `GET /v1/incidents`.
- **Uptime math**: incidents minus maintenance windows minus monitoring gaps (Render sleeps > 10 min are recorded as gaps and excluded).
- **Alert contacts**: `POST /v1/contacts {type: telegram\|email\|webhook\|discord\|slack, target, name}` (max 10/user). Jobs link via `alert_contact_ids` (empty -> your default telegram contact). Events: `down`, `up`, `ssl_expiring`, `heartbeat_missed`, `auto_disabled`. Honor `alert_on_down`, `alert_on_up`, `alert_after_minutes`, `repeat_alert_minutes`. Dedupe: one DOWN + one UP alert per incident. Telegram needs `TELEGRAM_BOT_TOKEN` env; email needs `RESEND_API_KEY` + `RESEND_FROM` (skipped when unset).
- **Maintenance windows**: `POST /v1/maintenance {name, job_ids[], start_at, end_at, recurrence: none\|daily\|weekly, timezone}` (daily/weekly use `"HH:MM"`). Checks still run, but no alerts, no new incidents, and the time is excluded from uptime %.
- **Status pages**: `POST /v1/status-pages {slug, title, job_ids[], uptime_days, message}` -> public `GET /status/:slug` (HTML, mobile friendly, light/dark, 30s cache) + `GET /status/:slug/json`. URLs/tokens are never exposed.
- **Free-plan safety**: daily purge of incidents > 90d, rollups in `job_daily` so 30d/90d stats work with only 50 raw runs per job.

Masking: header values and basic-auth passwords are returned as `***`; send `"***"` back on update to keep the stored value.

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
| `TELEGRAM_BOT_TOKEN` | – | Telegram alert delivery (optional) |
| `RESEND_API_KEY` / `RESEND_FROM` | – | Email alerts via Resend (optional) |
| `USER_CONTACT_LIMIT` | 10 | Alert contacts per user |
| `INCIDENTS_RETENTION_DAYS` | 90 | Incident history retention |

## Deploy (Render free)

1. Push this repo to GitHub
2. Render -> New Web Service -> connect repo
3. Runtime: Node, Build: `npm install`, Start: `node src/server.js`
4. Env vars: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `DEV_API_KEY`, `DEFAULT_TIMEZONE`
5. Keep it awake: external pinger on `/healthz` every 5 minutes (free-tier services sleep after 15 idle minutes)

Create a free Turso database at [turso.tech](https://turso.tech) — tables are created automatically on first boot.
