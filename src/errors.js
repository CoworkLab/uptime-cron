export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const err = {
  unauthorized: (m = 'API key required. Send header: Authorization: Bearer <key>') => new ApiError(401, 'UNAUTHORIZED', m),
  forbidden: (m = 'You are not allowed to perform this action') => new ApiError(403, 'FORBIDDEN', m),
  validation: (m) => new ApiError(422, 'VALIDATION_ERROR', m),
  intervalTooShort: (gap) => new ApiError(422, 'INTERVAL_TOO_SHORT', `Minimum allowed interval is ${gap ?? 120} seconds (2 minutes)`),
  jobNotFound: () => new ApiError(404, 'JOB_NOT_FOUND', 'Job not found or does not belong to you'),
  execNotFound: () => new ApiError(404, 'EXECUTION_NOT_FOUND', 'Execution not found'),
  userNotFound: () => new ApiError(404, 'USER_NOT_FOUND', 'User not found'),
  userExists: () => new ApiError(409, 'USER_ALREADY_EXISTS', 'This telegram_id is already registered'),
  quotaExceeded: (limit) => new ApiError(403, 'QUOTA_EXCEEDED', `Job limit reached (${limit}). Delete a job or ask the admin to raise the limit`),
  urlInvalid: () => new ApiError(422, 'URL_INVALID', 'url must be a valid http(s) URL'),
  // v1.2.0
  contactNotFound: () => new ApiError(404, 'CONTACT_NOT_FOUND', 'Alert contact not found'),
  maintenanceNotFound: () => new ApiError(404, 'MAINTENANCE_NOT_FOUND', 'Maintenance window not found'),
  statusPageNotFound: () => new ApiError(404, 'STATUS_PAGE_NOT_FOUND', 'Status page not found'),
  slugTaken: () => new ApiError(409, 'SLUG_TAKEN', 'This slug is already in use'),
  invalidJobType: (allowed = 'http, keyword, port, ssl, heartbeat') => new ApiError(422, 'INVALID_JOB_TYPE', `type must be one of: ${allowed}`),
};

export function ok(res, data, status = 200) {
  res.status(status).json({ ok: true, data });
}

export function fail(res, status, code, message) {
  res.status(status).json({ ok: false, error: { code, message, status } });
}

export const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
