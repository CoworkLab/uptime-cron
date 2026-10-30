const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

export const config = {
  port: int(process.env.PORT, 8080),
  tursoUrl: process.env.TURSO_DATABASE_URL || '',
  tursoToken: process.env.TURSO_AUTH_TOKEN || '',
  devKey: process.env.DEV_API_KEY || '',
  defaultTimezone: process.env.DEFAULT_TIMEZONE || 'UTC',
  userJobLimit: int(process.env.USER_JOB_LIMIT, 25),
  historyLimit: int(process.env.HISTORY_LIMIT, 50),
  minIntervalSeconds: int(process.env.MIN_INTERVAL_SECONDS, 120),
  tickSeconds: int(process.env.TICK_SECONDS, 10),
  maxConcurrency: int(process.env.MAX_CONCURRENCY, 20),
  rateLimitPerMin: int(process.env.RATE_LIMIT_PER_MIN, 120),
  // v1.2.0 — uptime monitoring
  selfBaseUrl: (process.env.RENDER_EXTERNAL_URL || 'https://uptime-cron.onrender.com').replace(/\/$/, ''),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  resendApiKey: process.env.RESEND_API_KEY || '',
  resendFrom: process.env.RESEND_FROM || '',
  userContactLimit: int(process.env.USER_CONTACT_LIMIT, 10),
  incidentsRetentionDays: int(process.env.INCIDENTS_RETENTION_DAYS, 90),
  version: '1.2.0',
};
