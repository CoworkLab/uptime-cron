# uptime-cron API — Complete Reference (v1.2.0)

Single-file documentation for the **uptime-cron** REST API — a cron-job.org style scheduling + uptime-monitoring API with Telegram-scoped multi-user jobs. This document is self-contained: an external developer (or AI agent) can build a full Telegram Bot client on top of the API using only this file. No code access is needed.

- **Base URL:** `https://uptime-cron.onrender.com`
- **API base:** `/v1`
- **Current version:** `1.2.0`
- **Transport:** HTTPS, JSON only (`Content-Type: application/json` for request bodies)
- **Hosting:** Render (free tier) + Turso (libSQL). Free tier can sleep after inactivity; sleep periods are tracked as "monitoring gaps" and excluded from uptime math (see §18).

## Table of Contents

1. [Response envelope](#1-response-envelope)
2. [Authentication](#2-authentication)
3. [Multi-user scoping model](#3-multi-user-scoping-model)
4. [Error reference](#4-error-reference)
5. [Schedules & timezones](#5-schedules--timezones)
6. [Object schemas](#6-object-schemas)
7. [System endpoints](#7-system-endpoints)
8. [Users API (dev only)](#8-users-api-dev-only)
9. [Jobs API](#9-jobs-api)
10. [Folders, incidents, dashboard, stats](#10-folders-incidents-dashboard-stats)
11. [Alert contacts API](#11-alert-contacts-api)
12. [Maintenance windows API](#12-maintenance-windows-api)
13. [Status pages API](#13-status-pages-api)
14. [Heartbeat API (public)](#14-heartbeat-api-public)
15. [Meta API (schedule preview)](#15-meta-api-schedule-preview)
16. [Monitoring behavior](#16-monitoring-behavior)
17. [Alerts & webhooks](#17-alerts--webhooks)
18. [Uptime math](#18-uptime-math)
19. [Limits](#19-limits)
20. [Telegram Bot integration guide](#20-telegram-bot-integration-guide)
21. [Version changelog](#21-version-changelog)

---

## 1. Response envelope

Every JSON response — success or failure — uses one unified envelope.

**Success:**

```json
{ "ok": true, "data": { ... } }
```

**Failure:**

```json
{ "ok": false, "error": { "code": "JOB_NOT_FOUND", "message": "Job not found or does not belong to you", "status": 404 } }
```

Rules:

- `data` shapes are documented per endpoint below. Everything is **snake_case**.
- Most timestamps are ISO 8601 UTC strings (`2026-11-02T09:30:00.000Z`).
- Unknown routes and wrong HTTP methods on known paths both return `404 NOT_FOUND` in the standard envelope.
- Malformed JSON body → `400 INVALID_JSON`. Body larger than 256 KB → `413 PAYLOAD_TOO_LARGE`.

## 2. Authentication

All `/v1/*` endpoints require an API key, except the public ones listed in §7 and §14.

Send the key with either header:

```
Authorization: Bearer <api_key>
X-API-Key: <api_key>
```

There are two key types:

| Key type | Format | Scope | Who uses it |
|---|---|---|---|
| **User key** | `uc_user_` + 48 hex chars | Bound to one `telegram_id`. Can only see and control **its own** jobs, contacts, maintenance windows and status pages. | Issued per Telegram user (see §8). This is the key a bot stores per chat. |
| **Dev key** | `uc_dev_` + 48 hex chars | Global admin access. Can manage **every** user's resources and can create/manage users. | Held by the bot operator only. Never share it with end users. |

Key-type detection is automatic: the server compares the key against the configured dev key first; otherwise it looks the key up in the `users` table. `GET /v1/me` tells you which type a key is.

### Rate limiting

- **120 requests/minute per key** (in-memory sliding window).
- Exceeding it returns `429 RATE_LIMITED` with a `Retry-After: 30` response header.
- Heartbeat pings have a separate limit: **60 pings/minute per heartbeat token** (see §14).

### Notes

- Rate limiting is applied **before** key validation, so even invalid keys consume the limit bucket for that key string.
- Restarting the service resets rate-limit counters (they are in-memory).
- Requests must be authenticated per request; there are no sessions or tokens beyond the static API key.

## 3. Multi-user scoping model

- Every job, alert contact, maintenance window and status page is owned by a **`telegram_id`** (a numeric Telegram user id, stored as a string of 3–20 digits).
- A user row is created either explicitly via `POST /v1/users` (dev key) or **implicitly** the first time a job is created for a `telegram_id` (auto-provisioning with a generated `uc_user_` key).
- All reads/writes with a **user key** are silently filtered to that user's `telegram_id`. If a user key requests another user's job id, the API returns the same `404 JOB_NOT_FOUND` as for a nonexistent job (existence is not revealed).
- With a **dev key**, resources are global. Endpoints that list resources accept `?telegram_id=<id>` to filter, and creation endpoints accept a `telegram_id` field in the body to create on behalf of a user.
- Job quota: **25 jobs per user** (configurable via `USER_JOB_LIMIT`). Dev-key creation bypasses the quota. Exceeding it → `403 QUOTA_EXCEEDED`.

### What each key can call

| Endpoint group | User key | Dev key |
|---|---|---|
| `/v1/me`, jobs, folders, incidents, dashboard, contacts, maintenance, status-pages, meta, heartbeat | ✅ (own data) | ✅ (all data) |
| `/v1/users/*` (create/list/delete/regenerate-key) | ❌ 403 | ✅ |
| `/v1/stats` (platform stats) | ❌ 403 | ✅ |
| `/status/:slug`, `/status/:slug/json`, `/v1/heartbeat/:token`, `/healthz`, `/` | public — no key | public |

## 4. Error reference

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `INVALID_JSON` | Request body is not valid JSON |
| 401 | `UNAUTHORIZED` | Missing/invalid API key (header missing, key unknown) |
| 403 | `FORBIDDEN` | Endpoint requires the dev key, or action not allowed for this key (e.g. creating a job for another telegram_id) |
| 403 | `QUOTA_EXCEEDED` | Job limit reached (default 25 per user) |
| 404 | `NOT_FOUND` | Unknown route / wrong method on a known route |
| 404 | `JOB_NOT_FOUND` | Job does not exist **or** belongs to another user |
| 404 | `EXECUTION_NOT_FOUND` | History entry id unknown for this job |
| 404 | `USER_NOT_FOUND` | telegram_id not registered |
| 404 | `CONTACT_NOT_FOUND` | Alert contact does not exist or belongs to another user |
| 404 | `MAINTENANCE_NOT_FOUND` | Maintenance window does not exist or belongs to another user |
| 404 | `STATUS_PAGE_NOT_FOUND` | Status page id/slug unknown or disabled |
| 409 | `USER_ALREADY_EXISTS` | A user with this telegram_id is already registered |
| 409 | `SLUG_TAKEN` | Status page slug already in use |
| 413 | `PAYLOAD_TOO_LARGE` | Request body over 256 KB |
| 422 | `VALIDATION_ERROR` | Any field validation failure (message explains which field) |
| 422 | `URL_INVALID` | URL is not a valid public http(s) URL — generic message, also used for SSRF blocks (see §16.7) |
| 422 | `INTERVAL_TOO_SHORT` | Schedule fires more often than every 120 seconds |
| 422 | `INVALID_JOB_TYPE` | `type` must be one of `http, keyword, port, ssl, heartbeat` |
| 429 | `RATE_LIMITED` | 120 req/min exceeded (API key) or 60 pings/min exceeded (heartbeat token) |
| 500 | `INTERNAL_ERROR` | Unexpected server error |

Duplicate-style conflicts: only `USER_ALREADY_EXISTS` and `SLUG_TAKEN` (both 409).

## 5. Schedules & timezones

The `schedule` field accepts four input forms. They are normalized server-side into `{ kind, cron, interval_seconds, timezone, input, human }`.

### 5.1 Accepted forms

**1. Five-field cron string** (`min hour day month weekday`) — seconds are NOT supported:

```
"*/5 * * * *"        every 5 minutes
"0 9 * * *"          daily at 09:00
"30 8 * * 1-5"       weekdays at 08:30
```

**2. Presets:** `@hourly`, `@daily`, `@midnight`, `@weekly`, `@monthly`, `@yearly`, `@annually`.

**3. Interval string** `@every <n><s|m|h|d>` (minimum 2 minutes):

```
"@every 5m"          every 5 minutes
"@every 30s"         ✗ 422 INTERVAL_TOO_SHORT
"@every 2h"
"@every 1d"
```

**4. Object forms:**

```json
{ "cron": "0 9 * * *", "timezone": "Asia/Kolkata" }
```

```json
{ "minutes": [0], "hours": [9], "mdays": ["*"], "months": ["*"], "wdays": ["*"], "timezone": "Asia/Kolkata" }
```

The second form is cron-job.org style: each field is an array of integers (or `["*"]`); they are joined into a cron expression. Field ranges: minutes 0-59, hours 0-23, mdays 1-31, months 1-12, wdays 0-6 (0 = Sunday).

### 5.2 Timezone rules (important!)

- **On job creation**, the timezone comes **only from the schedule object** (`{ "cron": "...", "timezone": "Asia/Kolkata" }`). A top-level `timezone` body field is **ignored on create**. If absent, the server default applies (`DEFAULT_TIMEZONE` env var; currently `Asia/Kolkata` on the live deployment).
- **On job update**, a top-level `timezone` body field **is** honored: the stored schedule input is re-parsed under the new timezone and `next_run_at` is recomputed.
- Any valid IANA timezone is accepted (`Asia/Kolkata`, `Europe/London`, `America/New_York`, ...). Unknown timezone → `422 VALIDATION_ERROR`.
- `GET /v1/meta/timezones` returns the common list.

### 5.3 Minimum interval

Every schedule is checked to fire **at least 120 seconds apart** (next 4 occurrences are simulated for cron). Violations → `422 INTERVAL_TOO_SHORT` with message like `Schedule fires every 60s. Minimum allowed interval is 120 seconds (2 minutes)`.

### 5.4 Scheduling engine

- Scheduler ticks every **10 seconds**; due jobs are claimed optimistically (`next_run_at` is bumped first, then dispatched — missed ticks during downtime are skipped, not replayed as a burst).
- Max **20 concurrent executions**; extra due jobs wait for the next tick.
- `next_run_at` is an epoch-ms value (returned as ISO string in job views); it is `null` for paused jobs and heartbeat jobs.
- A job with `expires_at` is auto-disabled (reason `expired`) when its next run would be past the expiry.

## 6. Object schemas

### 6.1 Job object (the central resource)

Returned by job create/get/list/update. A **job is a monitor** — the `type` field selects what is checked (§16).

```json
{
  "id": "job_K7m2xQ9pR4tZ",
  "title": "My API health",
  "telegram_id": "6123456789",
  "type": "http",
  "url": "https://api.example.com/health",
  "method": "GET",
  "headers": { "X-Token": "***" },
  "body": null,
  "timeout": 30,
  "schedule": {
    "kind": "cron",
    "cron": "*/5 * * * *",
    "interval_seconds": null,
    "timezone": "Asia/Kolkata",
    "input": "*/5 * * * *",
    "human": "Every 5 minutes"
  },
  "enabled": true,
  "tags": ["prod"],
  "max_retries": 0,
  "retry_interval": 60,
  "failure_webhook": null,
  "recovery_webhook": null,
  "success_webhook": null,
  "auto_disable_after": 0,
  "follow_redirects": true,
  "redirect_is_success": false,
  "auth": { "type": "basic", "username": "admin", "password": "***" },
  "folder": "production",
  "disabled_reason": null,
  "save_responses": true,
  "expected_status": null,
  "keyword": null,
  "keyword_mode": "exists",
  "keyword_case_sensitive": false,
  "max_response_ms": null,
  "port": null,
  "ssl_expiry_days": 14,
  "heartbeat_grace_seconds": 60,
  "heartbeat_url": null,
  "alert_contact_ids": ["con_Ab12Cd34Ef56"],
  "alert_on_down": true,
  "alert_on_up": true,
  "alert_after_minutes": 0,
  "repeat_alert_minutes": 0,
  "state": "up",
  "state_changed_at": "2026-11-02T09:12:40.123Z",
  "last_error_code": null,
  "expires_at": null,
  "next_run_at": "2026-11-02T09:35:00.000Z",
  "last_run_at": "2026-11-02T09:30:00.512Z",
  "last_status": "success",
  "last_status_code": 200,
  "last_duration_ms": 412,
  "run_count": 1337,
  "fail_count": 12,
  "consecutive_fails": 0,
  "created_at": "2026-10-01T10:00:00.000Z",
  "updated_at": "2026-11-02T09:30:01.000Z"
}
```

Field notes:

| Field | Notes |
|---|---|
| `type` | `http` \| `keyword` \| `port` \| `ssl` \| `heartbeat` (default `http`) |
| `url` | http/https URL (max 2048 chars) for http/keyword; bare host or IP for `port`; https URL or bare host for `ssl`; optional reference for `heartbeat` |
| `headers` | Values are **always masked as `"***"` in GET output**. Send `"***"` back on update to keep the stored value; send a real value to replace it. Max 20 headers, value ≤ 1024 chars. |
| `body` | Only for POST/PUT/PATCH/DELETE; string ≤ 64 KB |
| `method` | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD` (default `GET`) |
| `schedule` | Normalized schedule (§5) |
| `auth` | Basic auth `{type:"basic",username,password}`. `password` masked as `"***"` in GET; send `"***"` to keep it. |
| `folder` | Free-text folder name ≤ 60 chars, used for grouping (`GET /v1/folders`) |
| `disabled_reason` | `null` when enabled; else `paused_by_user` \| `expired` \| `auto_disabled_after_failures` |
| `state` | Monitor state machine: `pending` → `up` \| `down`; `paused` when disabled |
| `heartbeat_url` | Only for `type:"heartbeat"`: the public ping URL for this job |
| `next_run_at` | `null` when paused or heartbeat type |
| `expected_status` | Array like `["200-299","301"]` (http/keyword only; default rule = any 2xx) |
| `keyword` / `keyword_mode` / `keyword_case_sensitive` | keyword type only; mode `exists` \| `not_exists` |
| `max_response_ms` | 100–600000; failure code `SLOW_RESPONSE` when exceeded (all types except heartbeat) |
| `port` | 1–65535 (port type only) |
| `ssl_expiry_days` | 1–365 (default 14); cert expiring within window → `SSL_EXPIRING` failure |
| `heartbeat_grace_seconds` | 0–86400 (default 60); ping missed for interval+grace → `HEARTBEAT_MISSED` |
| `alert_contact_ids` | Array of `con_...` contact ids (max 10). Empty → the owner's first enabled **telegram** contact is used as fallback. |
| `alert_on_down` / `alert_on_up` | Toggle DOWN/UP alert delivery for this job |
| `alert_after_minutes` | Delay before the first DOWN alert (0–1440) |
| `repeat_alert_minutes` | Repeat DOWN alert every N minutes while down (0 = never repeat) |

### 6.2 Execution (history entry)

List view (history endpoint):

```json
{
  "id": "exe_K7m2xQ9pR4tZ",
  "job_id": "job_K7m2xQ9pR4tZ",
  "attempt": 1,
  "status": "success",
  "status_code": 200,
  "duration_ms": 412,
  "error_code": null,
  "started_at": "2026-11-02T09:30:00.100Z",
  "finished_at": "2026-11-02T09:30:00.512Z",
  "error": null
}
```

Detail view (single history endpoint) adds:

```json
{
  "response_body": "{\"status\":\"ok\"}",
  "response_headers": { "content-type": "application/json", "server": "nginx" },
  "timing": { "dns_ms": 12, "connect_ms": 34, "tls_ms": 78, "first_byte_ms": 120, "total_ms": 412 }
}
```

- `status`: `success` \| `failed` \| `timeout` \| `error` (§16.2)
- `response_body`: first **4 KB** of the response (truncated with `…[truncated]`); `null` when `save_responses=false` on the job
- `response_headers`: flattened response headers, stored up to 2 KB
- `timing`: millisecond breakdown; individual legs may be `null` (e.g. `tls_ms` on plain http)

### 6.3 Incident

```json
{
  "id": "inc_K7m2xQ9pR4tZ",
  "job_id": "job_K7m2xQ9pR4tZ",
  "telegram_id": "6123456789",
  "started_at": "2026-11-02T09:31:00.000Z",
  "ended_at": null,
  "duration_seconds": null,
  "ongoing": true,
  "error_code": "TIMEOUT",
  "error_text": "Request timed out after 30s",
  "status_code": null
}
```

An incident opens when a job transitions to `down` and closes on the first successful check/ping (then `ended_at` + `duration_seconds` are set and `ongoing` is `false`). Retained 90 days.

### 6.4 Alert contact

```json
{
  "id": "con_Ab12Cd34Ef56",
  "telegram_id": "6123456789",
  "type": "telegram",
  "target": "6123456789",
  "name": "Owner DM",
  "enabled": true,
  "created_at": "2026-10-01T10:00:00.000Z",
  "updated_at": "2026-10-01T10:00:00.000Z"
}
```

`type`: `telegram` \| `email` \| `webhook` \| `discord` \| `slack`. Target format depends on type (§11).

### 6.5 Maintenance window

```json
{
  "id": "mnt_Ab12Cd34Ef56",
  "telegram_id": "6123456789",
  "name": "Sunday deploy window",
  "job_ids": [],
  "start_at": "02:30",
  "end_at": "04:00",
  "recurrence": "weekly",
  "weekday": 0,
  "timezone": "Asia/Kolkata",
  "created_at": "2026-10-01T10:00:00.000Z",
  "updated_at": "2026-10-01T10:00:00.000Z"
}
```

- `recurrence: "none"` → `start_at`/`end_at` are absolute ISO datetimes.
- `recurrence: "daily" | "weekly"` → `start_at`/`end_at` are `"HH:MM"` wall-clock times in `timezone`; weekly adds `weekday` (0=Sun..6=Sat). Windows may cross midnight.
- `job_ids: []` means **all** of the owner's jobs.
- During a window: checks still run, but **no alerts, no incidents**, and the time is **excluded from uptime %**.

### 6.6 Status page

```json
{
  "id": "stp_Ab12Cd34Ef56",
  "telegram_id": "6123456789",
  "slug": "my-service",
  "title": "My Service Status",
  "job_ids": [],
  "uptime_days": 30,
  "message": null,
  "enabled": true,
  "public_url": "/status/my-service",
  "created_at": "2026-10-01T10:00:00.000Z",
  "updated_at": "2026-10-01T10:00:00.000Z"
}
```

`job_ids: []` → the page shows **all enabled jobs** of the owner. Public URL: `https://uptime-cron.onrender.com/status/<slug>` (HTML, auto light/dark, 30s cache) and `/status/<slug>/json` (JSON, 30s cache). Pages never expose job URLs or tokens.

### 6.7 User

```json
{ "telegram_id": "6123456789", "username": "somename", "created_at": "2026-10-01T10:00:00.000Z", "job_count": 3 }
```

`api_key` is only ever returned **once**: at user creation and at key regeneration.

---

## 7. System endpoints

### 7.1 `GET /` — service info (public)

```json
{
  "ok": true,
  "data": {
    "name": "uptime-cron",
    "description": "cron-job.org style scheduling API with Telegram-scoped multi-user jobs",
    "version": "1.2.0",
    "health": "/healthz",
    "api_base": "/v1",
    "auth": "Authorization: Bearer <api_key>"
  }
}
```

### 7.2 `GET /healthz` — health check (public)

```json
{ "ok": true, "data": { "ok": true } }
```

Use this for keep-alive pings (an external cron pings it every 5 minutes to reduce free-tier sleep).

## 8. Users API (dev only)

All `/v1/users` routes require the **dev key**; a user key gets `403 FORBIDDEN`.

### 8.1 `POST /v1/users` — register a user

Body:

| Field | Type | Required | Notes |
|---|---|---|---|
| `telegram_id` | string | ✅ | Numeric Telegram user id, 3–20 digits |
| `username` | string | — | Max 64 chars |

```bash
curl -X POST https://uptime-cron.onrender.com/v1/users \
  -H "Authorization: Bearer $DEV_KEY" -H "Content-Type: application/json" \
  -d '{"telegram_id":"6123456789","username":"somename"}'
```

Response `201`:

```json
{
  "ok": true,
  "data": {
    "user": {
      "telegram_id": "6123456789",
      "username": "somename",
      "api_key": "uc_user_3f9a2b7c8d1e4f6a0b5c7d9e1f3a5b7c9d0e2f4a6b8c0d2e",
      "created_at": "2026-11-02T09:00:00.000Z"
    }
  }
}
```

Errors: `409 USER_ALREADY_EXISTS`, `422 VALIDATION_ERROR`.

> **Save `api_key` immediately** — it is never shown again (only regenerable, §8.5).

### 8.2 `GET /v1/users` — list users

```json
{ "ok": true, "data": { "users": [ { "telegram_id": "6123456789", "username": "somename", "created_at": "...", "job_count": 3 } ] } }
```

Newest first, max 200.

### 8.3 `GET /v1/users/:telegram_id` — user detail

```json
{
  "ok": true,
  "data": {
    "user": { "telegram_id": "6123456789", "username": "somename", "created_at": "...", "job_count": 2 },
    "jobs": [ { "id": "job_...", "title": "My API health", "enabled": true, "last_status": "success", "next_run_at": "2026-11-02T09:35:00.000Z" } ]
  }
}
```

`jobs` holds up to 100 summary rows, newest first. Error: `404 USER_NOT_FOUND`.

### 8.4 `DELETE /v1/users/:telegram_id` — delete user + everything they own

Cascades: jobs, executions, incidents, daily rollups, alert contacts, maintenance windows, status pages, the user row.

```json
{ "ok": true, "data": { "deleted": { "user": true, "telegram_id": "6123456789", "jobs": 2 } } }
```

### 8.5 `POST /v1/users/:telegram_id/regenerate-key` — new API key

```json
{
  "ok": true,
  "data": {
    "telegram_id": "6123456789",
    "api_key": "uc_user_9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f",
    "note": "Old key is now invalid"
  }
}
```

## 9. Jobs API

A **job is both a scheduled cron task and a monitor**. All routes under `/v1/jobs` accept user keys (own jobs) and the dev key (all jobs).

### 9.1 `POST /v1/jobs` — create a job/monitor

Body (all fields optional unless marked ✅; defaults shown):

| Field | Type / range | Default | Notes |
|---|---|---|---|
| `telegram_id` | string | — | **Required when using the dev key** (the owner). With a user key it must be omitted or equal to the key's own id, else `403 FORBIDDEN`. |
| `username` | string | — | Used only for auto-provisioning the user row on first job |
| `title` | string ≤ 120 | `""` | |
| `type` | enum | `http` | `http` \| `keyword` \| `port` \| `ssl` \| `heartbeat` |
| `url` | string ≤ 2048 | ✅ (except heartbeat) | http/https URL for http/keyword; host or IP for `port`; https URL or bare host for `ssl`. SSRF-validated (§16.7). |
| `method` | enum | `GET` | GET/POST/PUT/PATCH/DELETE/HEAD |
| `headers` | object ≤ 20 | `{}` | string values ≤ 1024 chars |
| `body` | string ≤ 64 KB | `null` | only with POST/PUT/PATCH/DELETE |
| `timeout` | int 5–60 | `30` | seconds |
| `schedule` | string/object | ✅ | §5. Heartbeat type requires an **interval** schedule (`@every ...`). |
| `max_retries` | int 0–3 | `0` | extra attempts after a failed attempt |
| `retry_interval` | int 30–3600 | `60` | seconds between attempts |
| `failure_webhook` | https URL | `null` | POSTed on every finished-failure run (§17.4) |
| `recovery_webhook` | https URL | `null` | POSTed when a job recovers after ≥1 consecutive failure |
| `success_webhook` | https URL | `null` | POSTed on every successful run |
| `auto_disable_after` | int 0–100 | `0` | auto-pause after N consecutive failures (0 = off) |
| `follow_redirects` | bool | `true` | max 5 hops |
| `redirect_is_success` | bool | `false` | treat any 3xx as success without following |
| `auth` | object | `null` | `{type:"basic",username,password}` |
| `folder` | string ≤ 60 | `null` | |
| `save_responses` | bool | `true` | store response body in history |
| `tags` | string[] ≤ 5 | `[]` | each ≤ 32 chars, deduplicated |
| `expires_at` | ISO date | `null` | auto-disable after this instant |
| `enabled` | bool | `true` | |
| `expected_status` | string[] ≤ 10 | `null` | http/keyword only; e.g. `["200-299","301"]`; default = any 2xx |
| `keyword` | string ≤ 200 | — | required for keyword type |
| `keyword_mode` | enum | `exists` | `exists` \| `not_exists` |
| `keyword_case_sensitive` | bool | `false` | |
| `max_response_ms` | int 100–600000 | `null` | → `SLOW_RESPONSE` failure |
| `port` | int 1–65535 | — | required for port type |
| `ssl_expiry_days` | int 1–365 | `14` | ssl type only |
| `heartbeat_grace_seconds` | int 0–86400 | `60` | heartbeat type only |
| `alert_contact_ids` | `con_` id[] ≤ 10 | `[]` | ownership is verified |
| `alert_on_down` / `alert_on_up` | bool | `true` | |
| `alert_after_minutes` | int 0–1440 | `0` | |
| `repeat_alert_minutes` | int 0–1440 | `0` | |

Type-specific validation (wrong field for the type → `422 VALIDATION_ERROR`):

- `http`: `url` required. `expected_status`, `max_response_ms` allowed.
- `keyword`: `url` + `keyword` required. `keyword_mode`, `keyword_case_sensitive`, `expected_status`, `max_response_ms` allowed.
- `port`: `url` (host/IP) + `port` required. `method`/`headers`/`body` **not allowed**. `max_response_ms` allowed.
- `ssl`: `url` (https URL or bare host) required. `method`/`headers`/`body` **not allowed**. `ssl_expiry_days`, `max_response_ms` allowed.
- `heartbeat`: `url` optional (just a reference). Requires **interval schedule**. `method`/`headers`/`body` **not allowed**. `heartbeat_grace_seconds` allowed. A `heartbeat_token` + `heartbeat_url` is generated automatically.

Example — simple HTTP monitor with telegram alerts:

```bash
curl -X POST https://uptime-cron.onrender.com/v1/jobs \
  -H "Authorization: Bearer $USER_KEY" -H "Content-Type: application/json" \
  -d '{
    "title": "My API health",
    "url": "https://api.example.com/health",
    "schedule": { "cron": "*/5 * * * *", "timezone": "Asia/Kolkata" },
    "timeout": 15,
    "max_retries": 1,
    "auto_disable_after": 20,
    "failure_webhook": "https://mybot.example.com/hooks/failure",
    "tags": ["prod"],
    "folder": "production"
  }'
```

Response `201`: `{ "ok": true, "data": { "job": { ...job object... } } }`.

Example — keyword monitor:

```json
{
  "title": "Landing page has pricing",
  "type": "keyword",
  "url": "https://example.com",
  "keyword": "pricing",
  "keyword_mode": "exists",
  "schedule": "@every 10m"
}
```

Example — port monitor (dev key, on behalf of a user):

```json
{
  "telegram_id": "6123456789",
  "title": "MQTT broker",
  "type": "port",
  "url": "mqtt.example.com",
  "port": 8883,
  "schedule": "@every 5m"
}
```

Example — heartbeat monitor:

```json
{
  "title": "Nightly backup ping",
  "type": "heartbeat",
  "heartbeat_grace_seconds": 300,
  "schedule": "@every 1d"
}
```

Response contains `"heartbeat_url": "https://uptime-cron.onrender.com/v1/heartbeat/hb_<48hex>"` — give this URL to whatever process should ping (§14).

Errors: `422 VALIDATION_ERROR`, `422 URL_INVALID`, `422 INTERVAL_TOO_SHORT`, `422 INVALID_JOB_TYPE`, `403 QUOTA_EXCEEDED`, `403 FORBIDDEN`.

### 9.2 `GET /v1/jobs` — list jobs

Query params (all optional):

| Param | Values | Notes |
|---|---|---|
| `telegram_id` | id | dev key only; without it dev sees **all** jobs |
| `search` | string | substring match on `title` or `url` |
| `enabled` | `true` / `false` | |
| `status` | string | matches `last_status` (e.g. `success`) |
| `state` | `up` \| `down` \| `paused` \| `pending` | monitor state (`paused` = disabled) |
| `type` | `http` \| `keyword` \| `port` \| `ssl` \| `heartbeat` | |
| `tag` | string | exact tag match |
| `folder` | string | exact folder match |
| `sort` | `next_run_at` \| `created_at` \| `last_run_at` \| `run_count` \| `title` | default `created_at` |
| `order` | `asc` \| `desc` | default `desc` |
| `limit` | 1–100 | default 20 |
| `offset` | ≥ 0 | default 0 |

```bash
curl "https://uptime-cron.onrender.com/v1/jobs?state=down&limit=50" -H "Authorization: Bearer $USER_KEY"
```

Response:

```json
{
  "ok": true,
  "data": {
    "jobs": [ { "...job object..." } ],
    "pagination": { "total": 12, "limit": 50, "offset": 0 }
  }
}
```

### 9.3 `GET /v1/jobs/:id` — job detail

```json
{
  "ok": true,
  "data": {
    "job": { "...job object..." },
    "last_execution": { "id": "exe_...", "status": "success", "status_code": 200, "duration_ms": 412, "started_at": "..." }
  }
}
```

`last_execution` is `null` before the first run.

### 9.4 `PATCH /v1/jobs/:id` / `PUT /v1/jobs/:id` — update job

Accepts the same fields as create; **partial** (only sent fields change). Update-specific behavior:

- Masked values: sending `"***"` for a header value or `auth.password` **keeps the stored secret**.
- `schedule` change → `next_run_at` recomputed immediately.
- `timezone` change (top-level field) → stored schedule re-parsed in the new timezone.
- `enabled: false` → `disabled_reason: "paused_by_user"`, `next_run_at: null`, `state: "paused"`.
- `enabled: true` → `next_run_at` recomputed; `state` returns from `paused` to `pending` (next run will move it to up/down).
- Switching a job **to** `type: "heartbeat"` generates a `heartbeat_token`/`heartbeat_url` if it doesn't have one; `next_run_at` becomes `null`.
- Invalid field-for-type combinations (e.g. sending `port` for an http job) → `422 VALIDATION_ERROR`.

Response: `{ "ok": true, "data": { "job": {...} } }`.

### 9.5 `DELETE /v1/jobs/:id`

Cascades executions, incidents and daily rollups.

```json
{ "ok": true, "data": { "deleted": true, "id": "job_K7m2xQ9pR4tZ" } }
```

### 9.6 `POST /v1/jobs/:id/stop` — pause

Disables scheduling: `enabled=false`, `disabled_reason="paused_by_user"`, `state="paused"`.

```json
{ "ok": true, "data": { "job": {...}, "message": "Job paused" } }
```

### 9.7 `POST /v1/jobs/:id/start` — resume

```json
{ "ok": true, "data": { "job": {...}, "message": "Job resumed" } }
```

### 9.8 `POST /v1/jobs/:id/run` — run now (manual execution)

Async: returns immediately with an execution id; the result appears in history a few seconds later. No retries are applied on manual runs.

```json
{ "ok": true, "data": { "execution_id": "exe_K7m2xQ9pR4tZ", "message": "Execution started" } }
```

HTTP `202`. Heartbeat jobs cannot be run manually → `422 VALIDATION_ERROR` ("heartbeat jobs cannot be run manually — they go UP/DOWN based on pings to the heartbeat_url").

### 9.9 `GET /v1/jobs/:id/history` — execution history

Query: `status` (filter), `limit` (1–100, default 20), `offset`.

```json
{
  "ok": true,
  "data": {
    "executions": [ { "...execution list view..." } ],
    "pagination": { "total": 47, "limit": 20, "offset": 0 }
  }
}
```

History is capped at the **50 most recent** executions per job (older ones are pruned).

### 9.10 `GET /v1/jobs/:id/history/:execId` — execution detail

Full execution including `response_body`, `response_headers`, `timing`. Error: `404 EXECUTION_NOT_FOUND`.

### 9.11 `GET /v1/jobs/:id/history.csv` — CSV export

Returns `text/csv` (attachment `<job_id>-history.csv`), newest first, up to 1000 rows (effectively the 50 stored):

```
id,started_at,finished_at,status,error_code,status_code,duration_ms,error
exe_...,2026-11-02T09:30:00.100Z,2026-11-02T09:30:00.512Z,success,,200,412,
```

### 9.12 `DELETE /v1/jobs/:id/history` — clear history

```json
{ "ok": true, "data": { "deleted": true, "executions_removed": 47 } }
```

### 9.13 `GET /v1/jobs/:id/stats` — per-job stats

```json
{
  "ok": true,
  "data": {
    "job_id": "job_K7m2xQ9pR4tZ",
    "total_executions": 1337,
    "total_failures": 12,
    "success_rate": 99.1,
    "avg_duration_ms": 380,
    "last_24h": { "runs": 288, "failures": 1 },
    "consecutive_fails": 0,
    "state": "up",
    "uptime_24h_percent": 99.7,
    "next_runs": ["2026-11-02T09:35:00.000Z", "2026-11-02T09:40:00.000Z", "2026-11-02T09:45:00.000Z"]
  }
}
```

`next_runs` is empty for paused jobs; `success_rate`/`avg_duration_ms` are `null` before the first run.

### 9.14 `GET /v1/jobs/:id/uptime` — uptime stats

Query: `range` = `24h` (default) | `7d` | `30d` | `90d`.

```json
{
  "ok": true,
  "data": {
    "job_id": "job_K7m2xQ9pR4tZ",
    "range": "7d",
    "uptime_percent": 99.92,
    "downtime_seconds": 420,
    "incidents": 2,
    "avg_response_ms": 402,
    "p95_response_ms": 950
  }
}
```

Math details in §18. `uptime_percent` is `null` when there is no monitored time in range (e.g. brand-new job).

### 9.15 `GET /v1/jobs/:id/response-times` — response-time series

Query: `range` (same as uptime), `points` (10–200, default 100 — downsampling buckets).

```json
{
  "ok": true,
  "data": {
    "job_id": "job_K7m2xQ9pR4tZ",
    "range": "24h",
    "points": [ { "t": "2026-11-02T08:15:00.000Z", "ms": 412, "ok": true }, { "t": "2026-11-02T08:30:00.000Z", "ms": 1180, "ok": false } ]
  }
}
```

### 9.16 `GET /v1/jobs/:id/incidents` — incidents of one job

Query: `ongoing`=`true`/`false`, `limit` (1–100, default 20), `offset`.

```json
{ "ok": true, "data": { "incidents": [ { "...incident..." } ], "pagination": { "total": 2, "limit": 20, "offset": 0 } } }
```

### 9.17 `POST /v1/jobs/import/curl` — import a curl command

Two modes:

**Parse-only** (default) — returns what *would* be created:

```bash
curl -X POST https://uptime-cron.onrender.com/v1/jobs/import/curl \
  -H "Authorization: Bearer $USER_KEY" -H "Content-Type: application/json" \
  -d '{"curl":"curl -X POST https://api.example.com/send -H \"Authorization: Bearer t\" -d '{\"msg\":\"hi\"}'"}'
```

```json
{
  "ok": true,
  "data": {
    "parsed": {
      "title": "Imported from curl",
      "url": "https://api.example.com/send",
      "method": "POST",
      "headers": { "Authorization": "Bearer t" },
      "body": "{\"msg\":\"hi\"}"
    },
    "note": "Set \"create\": true and provide \"schedule\" to create the job directly"
  }
}
```

**Create mode** — add `"create": true` and `"schedule"` (plus any other job fields like `title`, `telegram_id` for dev): the parsed request is merged and the normal create pipeline runs (SSRF + validation + 201 job response).

Supported curl flags: `-X/--request`, `-H/--header`, `-d/--data/--data-raw/--data-binary/--data-ascii`, `--data-urlencode`, `--json`, `-u/--user` (converted to an `Authorization: Basic ...` header), `--url`, bare URL. Common flags (`-L`, `-s`, `-k`, `-v`, ...) are ignored. `-F/--form` (multipart) is rejected with a clear `422` message.

### 9.18 `POST /v1/jobs/bulk` — bulk operations

Body:

```json
{ "action": "pause", "job_ids": ["job_a", "job_b"] }
```

- `action`: `pause` \| `resume` \| `delete` \| `run`
- `job_ids`: 1–100 ids. Ids that don't exist or belong to another user are **skipped**, not errors.

```json
{ "ok": true, "data": { "action": "pause", "requested": 2, "affected": 2, "skipped": 0 } }
```

`run` dispatches one manual execution per job (same as §9.8, no retries).

---

## 10. Folders, incidents, dashboard, stats

### 10.1 `GET /v1/folders`

Folder names with job counts across the caller's jobs (dev key: all users, or `?telegram_id=`).

```json
{ "ok": true, "data": { "folders": [ { "name": "production", "job_count": 5 }, { "name": "staging", "job_count": 2 } ] } }
```

### 10.2 `GET /v1/incidents` — incidents across all my jobs

Query: `job_id`, `ongoing`=`true`/`false`, `limit` (1–100, default 20), `offset`, and `telegram_id` (dev key only).

```json
{ "ok": true, "data": { "incidents": [ { "...incident..." } ], "pagination": { "total": 7, "limit": 20, "offset": 0 } } }
```

### 10.3 `GET /v1/dashboard` — overview for a bot home screen

```json
{
  "ok": true,
  "data": {
    "jobs": { "total": 8, "up": 6, "down": 1, "paused": 1, "pending": 0 },
    "ongoing_incidents": 1,
    "uptime_24h_percent": 99.4,
    "avg_response_ms": 388
  }
}
```

Dev key accepts `?telegram_id=` to scope. Considers up to 100 jobs; `uptime_24h_percent` is the mean of per-job 24h uptime (null when no data); `avg_response_ms` is the mean duration of the last 24h executions.

### 10.4 `GET /v1/stats` — platform stats (dev only)

```json
{
  "ok": true,
  "data": {
    "users_total": 12,
    "jobs_total": 57,
    "jobs_enabled": 51,
    "executions_total": 148230,
    "last_24h": { "runs": 9120, "failures": 74, "success_rate": 99.2 },
    "process_uptime_s": 86400
  }
}
```

## 11. Alert contacts API

Alert contacts are delivery targets for DOWN/UP alerts (§17). Max **10 per user**. All routes under `/v1/contacts`.

### 11.1 `POST /v1/contacts`

| Field | Notes |
|---|---|
| `type` | ✅ `telegram` \| `email` \| `webhook` \| `discord` \| `slack` |
| `target` | ✅ type-specific (below) |
| `name` | optional label ≤ 60 chars |
| `telegram_id` | dev key only (owner) |

Target formats:

- `telegram`: numeric chat id, 4–20 digits, may start with `-` for groups/channels (e.g. `"6123456789"`, `"-1001234567890"`). Delivery uses the bot token configured on the server — **the bot must be able to message that chat** (user must have started the bot first).
- `email`: an email address. Delivery uses Resend; requires server-side `RESEND_API_KEY` + `RESEND_FROM` (currently **not configured** — email alerts fail with a config error until set).
- `webhook` / `discord` / `slack`: an **https** URL (SSRF-validated). Discord targets are webhook URLs (`https://discord.com/api/webhooks/...`), Slack targets are incoming-webhook URLs.

```bash
curl -X POST https://uptime-cron.onrender.com/v1/contacts \
  -H "Authorization: Bearer $USER_KEY" -H "Content-Type: application/json" \
  -d '{"type":"telegram","target":"6123456789","name":"Owner DM"}'
```

Response `201`: `{ "ok": true, "data": { "contact": { "...contact..." } } }`.

### 11.2 `GET /v1/contacts` — list (oldest first, max 200)

### 11.3 `GET /v1/contacts/:id` — get one

### 11.4 `PATCH /v1/contacts/:id`

Change `name`, `target`, and/or `enabled` (disabled contacts are skipped during alerting).

### 11.5 `DELETE /v1/contacts/:id`

→ `{ "ok": true, "data": { "deleted": true, "id": "con_..." } }`

### 11.6 `POST /v1/contacts/:id/test` — send a test alert

```json
{ "ok": true, "data": { "contact_id": "con_Ab12Cd34Ef56", "delivered": true, "detail": "Test alert sent" } }
```

`delivered: false` includes a `detail` error (e.g. `"TELEGRAM_BOT_TOKEN not configured on the server"` or an SSRF block).

## 12. Maintenance windows API

All routes under `/v1/maintenance`. See §6.5 for semantics: checks still run during a window, but no alerts/incidents fire and the window time is excluded from uptime.

### 12.1 `POST /v1/maintenance`

| Field | Notes |
|---|---|
| `name` | ≤ 80 chars |
| `job_ids` | array of job ids (≤ 100); `[]`/omitted = **all** of the owner's jobs; ownership verified |
| `recurrence` | `none` (default) \| `daily` \| `weekly` |
| `timezone` | IANA, default `UTC` |
| `start_at`, `end_at` | recurrence `none`: ISO 8601 datetimes (`end` must be after `start`); `daily`/`weekly`: `"HH:MM"` |
| `weekday` | required for `weekly`: 0=Sun..6=Sat |
| `telegram_id` | dev key only |

```json
{ "name": "Sunday deploy", "recurrence": "weekly", "weekday": 0, "start_at": "02:30", "end_at": "04:00", "timezone": "Asia/Kolkata", "job_ids": [] }
```

Response `201`: `{ "ok": true, "data": { "maintenance": { "...maintenance window..." } } }`.

### 12.2 `GET /v1/maintenance` — list (newest first, max 200)

### 12.3 `GET /v1/maintenance/:id` — get one

### 12.4 `PATCH /v1/maintenance/:id`

Change `name`, `job_ids`, `timezone`, `recurrence`, `start_at`, `end_at`, `weekday`. Changing `recurrence` re-validates `start_at`/`end_at` in the new format.

### 12.5 `DELETE /v1/maintenance/:id`

## 13. Status pages API

All routes under `/v1/status-pages`. A page shows the owner's monitors (all enabled jobs, or an explicit list) on a public URL.

### 13.1 `POST /v1/status-pages`

| Field | Notes |
|---|---|
| `slug` | ✅ 3–60 chars, `[a-z0-9-]`, no leading/trailing hyphen; globally unique (`409 SLUG_TAKEN`) |
| `title` | ✅ ≤ 120 chars |
| `job_ids` | ≤ 100 job ids, deduplicated, ownership verified; `[]` = all enabled jobs of the owner |
| `uptime_days` | 1–365, default 30 (bar range + uptime window) |
| `message` | optional banner text ≤ 300 chars |
| `enabled` | default `true` |
| `telegram_id` | dev key only |

Response `201`: `{ "ok": true, "data": { "status_page": { "...status page..." } } }` with `public_url: "/status/<slug>"`.

### 13.2 `GET /v1/status-pages` — list mine (dev: all, or `?telegram_id=`)

### 13.3 `GET /v1/status-pages/:id` — by page id

### 13.4 `PATCH /v1/status-pages/:id`

Change `title`, `message`, `uptime_days`, `enabled`, `slug` (re-checked for uniqueness), `job_ids`.

### 13.5 `DELETE /v1/status-pages/:id`

### 13.6 `GET /status/:slug` — public HTML page (no auth)

Renders a self-contained status page: overall banner (`All Systems Operational` / `Partial Outage` / `Awaiting first checks`), one card per monitor with 30/90 daily bars (green/red/gray), uptime %, recent incidents (last 30 days), and maintenance windows. Cached 30 seconds (`Cache-Control: public, max-age=30`). Disabled or unknown slug → 404 HTML. `noindex` is set.

### 13.7 `GET /status/:slug/json` — public JSON (no auth)

Same data, machine-readable, cached 30s:

```json
{
  "ok": true,
  "data": {
    "slug": "my-service",
    "title": "My Service Status",
    "message": null,
    "overall": "up",
    "jobs": [
      {
        "title": "API health",
        "state": "up",
        "uptime_percent": 99.9,
        "bars": [ { "date": "2026-11-01", "ok": true, "runs": 288 } ]
      }
    ],
    "incidents": [
      { "job_title": "API health", "started_at": "...", "ended_at": "...", "duration_seconds": 420, "error_code": "TIMEOUT" }
    ],
    "maintenance": [ { "name": "Sunday deploy", "recurrence": "weekly", "start_at": "02:30", "end_at": "04:00" } ]
  }
}
```

`bars[].ok` is `true`/`false`/`null` (no data that day). `overall`: `up` \| `down` \| `pending` \| `unknown`. Job URLs and tokens are never included.

## 14. Heartbeat API (public)

`GET` or `POST` `https://uptime-cron.onrender.com/v1/heartbeat/:token` — no auth. `:token` is the `hb_...` value from the job's `heartbeat_url`.

- Rate limit: **60 pings/minute per token** → `429 RATE_LIMITED`.
- Unknown token → `404 NOT_FOUND` ("Unknown heartbeat token").

```json
{ "ok": true, "data": { "received": true, "state": "up", "recovered": false } }
```

Behavior:

- Every ping records a success execution and sets `state: "up"`, `last_ping_at`, `run_count += 1`.
- If the previous state was `down`, the ongoing incident is closed and an **UP alert** is sent; `recovered: true` is returned.
- The scheduler scans heartbeat jobs every tick: if no ping arrives within `interval_seconds + heartbeat_grace_seconds`, a `HEARTBEAT_MISSED` failure is logged, the job goes `down`, an incident opens and DOWN alerts fire — without any outgoing HTTP request from the server.

## 15. Meta API (schedule preview)

### 15.1 `POST /v1/meta/preview-schedule`

Body: `{ "schedule": <same forms as §5>, "timezone": "Asia/Kolkata", "count": 5 }` (`count` 1–10, default 3).

**Always returns 200**, even for invalid schedules (perfect for bot-side "does this parse?" UX):

```json
{
  "ok": true,
  "data": {
    "valid": true,
    "human": "Every 5 minutes",
    "timezone": "Asia/Kolkata",
    "cron": "*/5 * * * *",
    "interval_seconds": null,
    "next_runs": ["2026-11-02T09:35:00.000Z", "2026-11-02T09:40:00.000Z", "2026-11-02T09:45:00.000Z"]
  }
}
```

Invalid:

```json
{ "ok": true, "data": { "valid": false, "error": { "code": "INTERVAL_TOO_SHORT", "message": "Schedule fires every 30s. Minimum allowed interval is 120 seconds (2 minutes)" } } }
```

### 15.2 `POST /v1/meta/parse-cron`

Same input; on success returns `{valid:true, human, cron, interval_seconds, timezone, kind}`. On failure returns a **real error**: `422` envelope with `VALIDATION_ERROR` / `INTERVAL_TOO_SHORT` / `URL_INVALID`-style codes.

### 15.3 `GET /v1/meta/timezones`

```json
{ "ok": true, "data": { "timezones": ["UTC", "Asia/Kolkata", "Asia/Dubai", "Europe/London", "America/New_York", "..."], "note": "Any valid IANA timezone is accepted; these are the common ones" } }
```

## 16. Monitoring behavior

### 16.1 Check types

| Type | What happens | Success condition |
|---|---|---|
| `http` | HTTP request with job's method/headers/body/auth; response body read up to 4 KB | status in `expected_status` (default 2xx) **and** `max_response_ms` not exceeded |
| `keyword` | Same as http but body read up to 256 KB | http conditions **and** keyword rule passes |
| `port` | Raw TCP connect to `url` host on `port` | TCP connection established within `timeout` |
| `ssl` | TLS handshake to host on 443 (or URL port), certificate inspected | cert valid, not expired, and ≥ `ssl_expiry_days` days remaining |
| `heartbeat` | No outgoing request — waits for pings on `heartbeat_url` | ping received within `interval_seconds + heartbeat_grace_seconds` |

Keyword modes: `exists` (default) fails with `KEYWORD_MISSING` when absent; `not_exists` fails with `KEYWORD_FOUND` when present. Keyword search covers the first 256 KB of the body; case-insensitive unless `keyword_case_sensitive`.

### 16.2 Execution statuses and error codes

`status` values: `success`, `failed`, `timeout`, `error`.

| `error_code` | `status` | Meaning |
|---|---|---|
| `TIMEOUT` | `timeout` | Request/port/TLS timed out after `timeout` seconds |
| `DNS_ERROR` | `error` | Host could not be resolved |
| `CONNECTION_REFUSED` | `failed` | TCP refused (http connect or port check) |
| `TLS_ERROR` | `failed`/`error` | Certificate invalid, expired, or handshake failed |
| `STATUS_MISMATCH` | `failed` | Status code outside `expected_status` |
| `KEYWORD_MISSING` | `failed` | `exists` mode and keyword absent |
| `KEYWORD_FOUND` | `failed` | `not_exists` mode and keyword present |
| `SLOW_RESPONSE` | `failed` | `duration_ms` > `max_response_ms` |
| `SSL_EXPIRING` | `failed` | Cert expires within `ssl_expiry_days` (alert event: `ssl_expiring`) |
| `HEARTBEAT_MISSED` | `failed` | No ping within interval + grace |
| `null` + `error: "Request blocked by SSRF protection"` | `error` | Runtime SSRF block (§16.7) |
| `null` | `error` | Other network errors (message in `error`) |

HTTP-level: 2xx (or expected range) → `success`; any other terminal HTTP response → `failed` with the actual `status_code` recorded.

### 16.3 State machine

```
            first run success          check fails
pending ────────────────► up ◄────────────────────── (from down)
   │                        │  │
   │      check fails       │  └──────────────► down ─── check succeeds ───► up
   └────────────────────────┘                   ▲
                                                │ check fails while down (incident stays open)
paused ◄── stop / auto_disable / expiry ── (any state)
```

- `pending`: created, never run.
- `up`: last check succeeded. `state_changed_at` marks the transition.
- `down`: last check failed while previously `up`/`pending`. Remaining failed checks keep it `down` (one open incident).
- `paused`: disabled (user pause, `auto_disable_after`, expiry). `disabled_reason` records why.

### 16.4 Retries

`max_retries` (0–3) extra attempts per scheduled run, waiting `retry_interval` (30–3600 s) between attempts. Each attempt is logged separately (`attempt` field). The job-level counters use the final attempt's result. Manual runs never retry.

### 16.5 Auto-disable & expiry

- `auto_disable_after: N > 0` → after N consecutive failed runs the job is paused with `disabled_reason: "auto_disabled_after_failures"` and an `auto_disabled` failure webhook fires (§17.4).
- `expires_at` in the past at scheduling time → paused with `disabled_reason: "expired"`.
- Manual stop → `disabled_reason: "paused_by_user"`.

### 16.6 Redirects, URL variables, basic auth

- Redirects: `follow_redirects` (default true), max **5 hops**; 301/302/303 convert to GET and drop the body; hop count exceeded → `error` "Too many redirects (max 5)". `redirect_is_success: true` treats the first 3xx as success without following.
- URL variables (substituted in `url` and `body` at run time, in the job's timezone): `%date%` → `YYYY-MM-DD`, `%time%` → `HH:MM:SS`, `%timestamp%` → unix seconds, `%job_id%` → job id.
- Basic auth: `auth: {type:"basic", username, password}` → `Authorization: Basic base64(user:pass)` header at run time; password masked `"***"` in reads.
- Default `User-Agent` if none set: `uptime-cron/1.1` (webhook sender uses `uptime-cron/1.2`).

### 16.7 SSRF protection (why some URLs are rejected)

All outbound URLs — job `url` (http/keyword), webhook URLs, discord/slack contact targets — are validated at create/update **and re-validated at every execution and every redirect hop**:

- Only `http:`/`https:`, only ports **80/443** (port/ssl checks: any port, same host rules).
- Blocked: `localhost`, `*.internal`, `*.local`, `*.localdomain`, `*.onion`, the app's own public host, loopback/private/link-local/CGNAT IPv4 (`127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` incl. cloud metadata `169.254.169.254`, `100.64/10`, `0/8`), IPv6 loopback/unique-local/link-local, and IPv4-mapped IPv6 equivalents.
- DNS is resolved and **every** resolved address must be safe (DNS-rebinding protection at connect time).
- Rejections are always the generic `422 URL_INVALID` at create/update, and a runtime `error` execution with "Request blocked by SSRF protection" — no internal details are leaked.

## 17. Alerts & webhooks

### 17.1 When alerts fire

| Event | Trigger |
|---|---|
| `down` | Job transitions to `down` (after `alert_after_minutes` delay, honored at the next failed run) |
| `ssl_expiring` | Incident opened with `SSL_EXPIRING` |
| `heartbeat_missed` | Incident opened with `HEARTBEAT_MISSED` |
| `up` | Incident closes (job recovers) |
| `auto_disabled` | Job paused by `auto_disable_after` |
| `test` | `POST /v1/contacts/:id/test` |

Rules:

- One DOWN alert + one UP alert per incident (deduplicated via `down_alerted_at`/`up_alerted_at`).
- `alert_after_minutes > 0` delays the first DOWN alert; if the job recovers before the delay, no DOWN alert is sent.
- `repeat_alert_minutes > 0` re-sends the DOWN alert every N minutes while the incident stays open.
- UP alert is sent only if a DOWN alert was sent, or if `alert_after_minutes` is 0 (immediate alerting mode).
- Nothing fires during maintenance windows; `alert_on_down`/`alert_on_up` per job can mute either direction.
- Contact resolution: job's `alert_contact_ids` (enabled, owned) if set — otherwise the owner's **first enabled telegram contact** (created earliest).

### 17.2 Alert text (Telegram / Discord / Slack / email subject+body)

```
DOWN: <title> (<url>) - TIMEOUT. Since 09:31 IST
UP: <title> is back. Down for 7m 12s
SSL EXPIRING: <title> (<url>) - SSL_EXPIRING. SSL certificate expires in 9 day(s) (threshold 14)
HEARTBEAT MISSED: <title> - no ping received. Since 09:31 IST
AUTO-DISABLED: <title> after repeated failures (TIMEOUT). Since 09:31 IST
Test alert from uptime-cron for "<name>". If you can read this, this contact works.
```

Telegram messages are sent with `disable_web_page_preview: true`.

### 17.3 Structured payload (generic `webhook` contacts)

```json
{
  "event": "down",
  "job": { "id": "job_...", "title": "My API health", "url": "https://api.example.com/health", "type": "http" },
  "error_code": "TIMEOUT",
  "status_code": null,
  "incident": { "id": "inc_...", "started_at": "2026-11-02T09:31:00.000Z", "duration_seconds": 0 },
  "at": "2026-11-02T09:33:00.000Z"
}
```

`event`: `down` | `up` | `ssl_expiring` | `heartbeat_missed` | `auto_disabled` | `test`. For `up`, `duration_seconds` is the incident length. Discord contacts receive `{ "content": "<text>", "username": "uptime-cron" }`; Slack contacts receive `{ "text": "<text>" }`. All webhook-type deliveries (webhook/discord/slack) retry up to 3 times with backoff (0s/2s/4s) and a 10 s timeout.

### 17.4 Per-job webhooks (v1.1.0, independent of alert contacts)

These fire from the scheduler on every matching run (10 s timeout, no retry), and are skipped during maintenance:

**`failure_webhook`** — every finished-failure run (after retries):

```json
{
  "event": "failed",
  "occurred_at": "2026-11-02T09:33:00.000Z",
  "job": { "id": "job_...", "title": "...", "telegram_id": "6123456789", "url": "...", "method": "GET", "schedule": "*/5 * * * *" },
  "execution": { "status": "failed", "status_code": 500, "duration_ms": 812, "error": "Status 500 is not in expected_status (200-299)", "attempts_used": 2 }
}
```

**`recovery_webhook`** — success after ≥ 1 consecutive failure:

```json
{ "event": "recovered", "job_id": "job_...", "title": "...", "downtime_runs": 3, "at": "2026-11-02T09:36:00.000Z" }
```

**`success_webhook`** — every successful run:

```json
{ "event": "success", "job_id": "job_...", "status_code": 200, "duration_ms": 412 }
```

**`auto_disabled`** (via `failure_webhook`) — when auto-disable triggers:

```json
{
  "event": "auto_disabled",
  "occurred_at": "2026-11-02T09:40:00.000Z",
  "job": { "id": "job_...", "title": "...", "telegram_id": "6123456789" },
  "auto_disable_after": 5,
  "consecutive_fails": 5,
  "last_error": "Request timed out after 30s"
}
```

## 18. Uptime math

```
uptime% = (monitored_seconds - downtime_seconds) / monitored_seconds × 100

monitored_seconds = range_seconds − maintenance_seconds − monitoring_gap_seconds
downtime_seconds  = Σ incident overlap with the range, minus maintenance/gap intersections
```

- Ranges: `24h`, `7d`, `30d`, `90d`.
- **Monitoring gaps**: when the service was asleep/down > 10 minutes (Render free tier), the gap is recorded at boot and excluded — sleeping doesn't count as downtime.
- Maintenance windows are excluded from both denominator and downtime.
- Response aggregates: `24h` uses raw executions; `7d/30d/90d` use daily rollups (`job_daily`) because raw history is trimmed to 50. Range p95 for ≥7d is an approximation (max of daily p95s).
- Retention: incidents 90 days, daily rollups 92 days, gap records 30 days (purged hourly).

## 19. Limits

| Limit | Value |
|---|---|
| Jobs per user | 25 (dev key bypasses) |
| Alert contacts per user | 10 |
| Alert contacts per job | 10 |
| History (executions) per job | 50 most recent |
| Response body stored | first 4 KB (`…[truncated]` marker) |
| Keyword search window | first 256 KB |
| Response headers stored | 2 KB |
| Redirects | max 5 |
| Request timeout | 5–60 s (default 30) |
| Manual/bulk webhook timeout | 10 s (alerts retry ×3) |
| Min schedule interval | 120 s |
| Scheduler tick | 10 s |
| Max concurrent executions | 20 |
| API rate limit | 120 req/min per key |
| Heartbeat rate limit | 60 pings/min per token |
| Request body limit | 256 KB |
| Job body size | 64 KB |
| Headers per job | 20 (value ≤ 1024 chars) |
| Tags per job | 5 (each ≤ 32 chars) |
| Title / folder / keyword | 120 / 60 / 200 chars |
| expected_status entries | 10 (each `"200"` or `"200-299"`, 100–599) |
| Bulk job_ids | 100 |
| Maintenance/status-page job_ids | 100 |
| Incidents / rollups / gaps retention | 90 / 92 / 30 days |
| List endpoints default/max page size | 20 / 100 |

## 20. Telegram Bot integration guide

Recommended architecture: the bot holds the **dev key** privately and issues one **user key** per Telegram user.

### 20.1 Onboarding flow

1. User sends `/start` in Telegram. Bot reads `msg.from.id` (and `msg.from.username`).
2. Bot (dev key) calls `POST /v1/users { "telegram_id": "<id>", "username": "<username>" }`.
   - `409 USER_ALREADY_EXISTS` → user exists; the bot should have their key stored. If the key was lost, call `POST /v1/users/:telegram_id/regenerate-key` and store the new one.
3. Store `(telegram_id → api_key)` in the bot's own database. **All subsequent calls use the user's `uc_user_` key**, so scoping is enforced server-side even if your bot code has a bug.
4. Create a default alert contact so the user gets DOWN/UP messages: `POST /v1/contacts { "type": "telegram", "target": "<chat_id>" }` with the user key (target = the chat where alerts should land — for a DM it equals the user id; the user must have started the bot, or Telegram rejects the send).
5. Attach contact id to jobs via `alert_contact_ids`, or rely on the automatic fallback (first enabled telegram contact).

### 20.2 Suggested bot commands → API calls

| Bot command | API calls |
|---|---|
| `/status` | `GET /v1/dashboard` (+ `GET /v1/incidents?ongoing=true`) |
| `/list` | `GET /v1/jobs?limit=100` |
| `/add <url> [every 5m]` | optional `POST /v1/meta/preview-schedule` to confirm timing, then `POST /v1/jobs` |
| `/pause` `/resume` `/delete` | `POST /v1/jobs/:id/stop` / `start` / `DELETE /v1/jobs/:id` |
| `/run <id>` | `POST /v1/jobs/:id/run` → poll `GET /v1/jobs/:id/history?limit=1` after ~3–10 s for the result |
| `/history <id>` | `GET /v1/jobs/:id/history` |
| `/uptime <id>` | `GET /v1/jobs/:id/uptime?range=7d` |
| `/alerts` | `GET /v1/contacts`, `POST /v1/contacts`, `POST /v1/contacts/:id/test` |
| `/maintenance` | `/v1/maintenance` CRUD |
| `/statuspage` | `/v1/status-pages` CRUD → share the `public_url` |
| `/stats` (admin) | `GET /v1/stats` with dev key |

### 20.3 Receiving alerts in the bot

Two complementary mechanisms (both can be used):

1. **Alert contacts (server-push, recommended):** register a `telegram` contact per chat; the server delivers DOWN/UP messages via the Telegram Bot API itself. No webhook infrastructure needed in the bot. Note: this uses the bot token configured on the **server** (`TELEGRAM_BOT_TOKEN`) — currently the same bot. Messages come from the bot, so they appear normal to users.
2. **Per-job webhooks:** set `failure_webhook`/`recovery_webhook`/`success_webhook` to an HTTPS endpoint of the bot (must be public, port 443, SSRF rules apply). Useful for rich formatting/logging. Payloads in §17.4.

### 20.4 Error handling tips

- Always check the `ok` field first; on `false` show `error.message` (they are user-safe) and map `error.code` for i18n.
- `403 QUOTA_EXCEEDED` → tell the user about the 25-job limit.
- `422 URL_INVALID` → the URL is unreachable/private/invalid; suggest a public http(s) URL.
- `422 INTERVAL_TOO_SHORT` → minimum 2 minutes.
- `429` → wait for `Retry-After` seconds.
- Heartbeat monitors: show the `heartbeat_url` to the user with a copy button; it is a secret-ish token (anyone with it can mark the job up).
- Polling cadence: manual-run results usually appear in history within 3–10 seconds; don't poll faster than every 2 s and respect the 120 req/min limit.

### 20.5 Deployment notes for the bot host

- The bot itself does **not** need to run on Render — it only needs outbound HTTPS to `uptime-cron.onrender.com` and (for webhook mode) a public HTTPS endpoint.
- The API's `TELEGRAM_BOT_TOKEN` env var (set on Render) powers server-side Telegram alert delivery; `RESEND_API_KEY`/`RESEND_FROM` would be needed for email alerts (currently unset — email contacts will report "email alerts not configured on the server" when tested).

## 21. Version changelog

- **v1.0.0** — Scheduling core: jobs CRUD, cron/`@every`/object schedules, 10 s tick scheduler, execution history + stats, multi-user `telegram_id` scoping, user keys + dev key, curl import, bulk ops, folders, failure webhooks, `GET /v1/me`, `GET /v1/stats`.
- **v1.1.0** — SSRF protection (create/update + runtime + per-hop), recovery/success webhooks, `auto_disable_after`, timing breakdown, response headers, redirect control (`follow_redirects`, `redirect_is_success`), Basic auth, URL variables (`%date%`, `%time%`, `%timestamp%`, `%job_id%`), header/auth masking.
- **v1.2.0** — Monitor types (`keyword`, `port`, `ssl`, `heartbeat`), monitor state machine + incidents, alert contacts (telegram/email/webhook/discord/slack) with dedupe/delay/repeat, uptime % + response-time series (24h/7d/30d/90d), maintenance windows, public status pages (HTML + JSON), public heartbeat endpoint, CSV history export, `/v1/dashboard`, monitoring-gap tracking, `expected_status`, `max_response_ms`, daily rollups, 90-day incident retention.
