'use strict';
/**
 * HTTP hardening: security headers, a small in-memory rate limiter and a
 * consistent JSON error format.
 */

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; '));
  next();
}

/* Fixed-window limiter keyed by IP + route. Enough for a single-server install. */
function rateLimit({ windowMs, max, name }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const key = `${name}:${req.ip}`;
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < now) { h = { count: 0, reset: now + windowMs }; hits.set(key, h); }
    h.count++;
    res.setHeader('RateLimit-Remaining', Math.max(0, max - h.count));
    if (h.count > max) {
      res.setHeader('Retry-After', Math.ceil((h.reset - now) / 1000));
      return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests. Please wait a moment and try again.' } });
    }
    next();
  };
}

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const ENGINE_STATUS = { invalid: 400, closed: 409, duplicate: 409, limit: 409, no_bed: 409, not_found: 404, forbidden: 403, unknown_command: 404 };

function errorHandler(log) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'too_large', message: 'Request body is too large' } });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'bad_json', message: 'Request body is not valid JSON' } });
    if (err instanceof HttpError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    if (err.name === 'EngineError') return res.status(ENGINE_STATUS[err.code] || 400).json({ error: { code: err.code, message: err.message } });
    log.error('Unhandled error', err);
    res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong on the server. The error has been logged.' } });
  };
}

module.exports = { securityHeaders, rateLimit, HttpError, errorHandler };
