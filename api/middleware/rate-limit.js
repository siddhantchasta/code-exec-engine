'use strict';

const redis = require('../../lib/redis');
const logger = require('../../lib/logger');
const { takeToken } = require('../../lib/rate-limiter');

/**
 * Create rate-limiter middleware.
 *
 * @returns {import('express').RequestHandler}
 */
function createRateLimiter() {

  /** @type {import('express').RequestHandler} */
  async function rateLimitMiddleware(req, res, next) {
    const ip = req.ip || '0.0.0.0';

    try {
      const result = await takeToken(redis, ip);
      if (!result.allowed) {
        res.set('Retry-After', String(result.retryAfterSec));
        logger.warn({ ip, tokens: result.tokens }, 'rate limit exceeded');
        res.status(429).json({ error: 'Too Many Requests' });
        return;
      }

      next();
    } catch (/** @type {unknown} */ err) {
      // If Redis is down, fail open (allow request) — availability over strictness
      logger.error({ err, ip }, 'rate limiter error — failing open');
      next();
    }
  }

  return rateLimitMiddleware;
}

module.exports = { createRateLimiter };
