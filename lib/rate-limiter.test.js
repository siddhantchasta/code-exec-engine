'use strict';

const assert = require('node:assert/strict');
const config = require('./config');
const { takeToken } = require('./rate-limiter');

class FakeRedis {
  constructor() {
    this.calls = [];
    this.tokenBucket = async (...args) => {
      this.calls.push(args);
      return [1, '9', 0];
    };
  }

  defineCommand(name, options) {
    assert.equal(name, 'tokenBucket');
    assert.equal(options.numberOfKeys, 1);
    assert.match(options.lua, /HMGET/);
  }
}

async function run() {
  const redis = new FakeRedis();
  const allowed = await takeToken(redis, '203.0.113.10', 1000);
  assert.deepEqual(allowed, { allowed: true, tokens: 9, retryAfterSec: 0 });
  assert.deepEqual(redis.calls[0], [
    'rl:203.0.113.10',
    config.RATE_LIMIT_MAX,
    config.RATE_LIMIT_WINDOW * 1000,
    1000,
    config.RATE_LIMIT_WINDOW * 2,
  ]);

  redis.tokenBucket = async () => [0, '0.25', 5];
  const denied = await takeToken(redis, '203.0.113.10', 1001);
  assert.deepEqual(denied, { allowed: false, tokens: 0.25, retryAfterSec: 5 });
  process.stdout.write('rate limiter tests passed\n');
}

run().catch((err) => {
  process.stderr.write(`rate limiter tests failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
