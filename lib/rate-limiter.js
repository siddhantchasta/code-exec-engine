'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { rateLimit } = require('./redis-keys');

const lua = fs.readFileSync(path.join(__dirname, 'rate-limit.lua'), 'utf8');
const configuredClients = new WeakSet();

/**
 * Register the sole Lua command used by this application on a Redis client.
 *
 * @param {import('ioredis').default} redis
 * @returns {void}
 */
function defineTokenBucket(redis) {
  if (configuredClients.has(redis)) return;
  redis.defineCommand('tokenBucket', { numberOfKeys: 1, lua });
  configuredClients.add(redis);
}

/**
 * Atomically consume one token from an IP's bucket.
 *
 * @param {import('ioredis').default} redis
 * @param {string} ip
 * @param {number} [now]
 * @returns {Promise<{ allowed: boolean, tokens: number, retryAfterSec: number }>}
 */
async function takeToken(redis, ip, now = Date.now()) {
  defineTokenBucket(redis);
  const response = await redis.tokenBucket(
    rateLimit(ip),
    config.RATE_LIMIT_MAX,
    config.RATE_LIMIT_WINDOW * 1000,
    now,
    config.RATE_LIMIT_WINDOW * 2,
  );
  const [allowed, tokens, retryAfterSec] = response;
  return {
    allowed: Number(allowed) === 1,
    tokens: Number(tokens),
    retryAfterSec: Number(retryAfterSec),
  };
}

module.exports = { defineTokenBucket, takeToken };
