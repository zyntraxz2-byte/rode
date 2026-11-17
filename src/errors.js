'use strict';

/** An error that is safe to show to API clients. */
class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
const bad = (code, message, extra) => new HttpError(400, code, message, extra);
const invalid = (message, field) => new HttpError(422, 'validation_failed', message, field ? { field } : undefined);
const unauthorized = (message = 'Sign in required.', code = 'unauthenticated') => new HttpError(401, code, message);
const forbidden = (message = 'You do not have access to this.') => new HttpError(403, 'forbidden', message);
const notFound = (message = 'Not found.') => new HttpError(404, 'not_found', message);
const conflict = (code, message, extra) => new HttpError(409, code, message, extra);

module.exports = { HttpError, bad, invalid, unauthorized, forbidden, notFound, conflict };
