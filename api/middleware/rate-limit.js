'use strict';

const redis = require('../../lib/redis');
const config = require('../../lib/config');
const logger = require('../../lib/logger');

// ---------------------------------------------------------------------------
// Token bucket rate limiter — per-IP, Redis-backed, pure JS
//
// Redis key: rl:{ip}  (Hash with fields: tokens, lastRefill)
//
// Known gap: the read-modify-write is NOT atomic. At our scale (one API
// server) this is fine. Documented in project-brief.md.
// ---------------------------------------------------------------------------

const KEY_PREFIX = 'rl:';

/**
 * Build the Redis key for a given IP.
 * @param {string} ip
 * @returns {string}
 */
function bucketKey(ip) {
  return `${KEY_PREFIX}${ip}`;
}

/**
 * Create rate-limiter middleware.
 *
 * @returns {import('express').RequestHandler}
 */
function createRateLimiter() {
  const maxTokens = config.RATE_LIMIT_MAX;
  const windowSec = config.RATE_LIMIT_WINDOW;
  const windowMs = windowSec * 1000;

  /** @type {import('express').RequestHandler} */
  async function rateLimitMiddleware(req, res, next) {
    const ip = req.ip || '0.0.0.0';
    const key = bucketKey(ip);
    const now = Date.now();

    try {
      const bucket = await redis.hgetall(key);

      /** @type {number} */
      let tokens;
      /** @type {number} */
      let lastRefill;

      if (!bucket || !bucket.tokens) {
        // First request from this IP — initialise with full bucket
        tokens = maxTokens;
        lastRefill = now;
      } else {
        tokens = parseFloat(bucket.tokens);
        lastRefill = parseInt(bucket.lastRefill, 10);

        // Refill tokens based on elapsed time
        const elapsed = now - lastRefill;
        const refill = (elapsed / windowMs) * maxTokens;
        tokens = Math.min(maxTokens, tokens + refill);
        lastRefill = now;
      }

      if (tokens < 1) {
        // Not enough tokens — reject
        const retryAfterSec = Math.ceil(((1 - tokens) / maxTokens) * windowSec);
        res.set('Retry-After', String(retryAfterSec));
        logger.warn({ ip, tokens }, 'rate limit exceeded');
        res.status(429).json({ error: 'Too Many Requests' });
        return;
      }

      // Consume one token
      tokens -= 1;
      await redis.hset(key, 'tokens', String(tokens), 'lastRefill', String(lastRefill));

      // Set bucket TTL to 2× the window so stale buckets auto-expire
      await redis.expire(key, windowSec * 2);

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
