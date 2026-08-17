'use strict';

const assert = require('node:assert/strict');
const config = require('../lib/config');
const { recoverOrphanedJobs } = require('./watchdog');

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const WORKER_ID = 'failed-worker';

class FakeRedis {
  constructor(record, options = {}) {
    this.record = record;
    this.cachedResult = options.cachedResult ?? false;
    this.retryCount = options.retryCount ?? '0';
    this.commands = [];
  }

  async hgetall() { return { [JOB_ID]: this.record }; }
  async ttl() { return -2; }
  async exists() { return this.cachedResult ? 1 : 0; }
  async hget() { return this.retryCount; }
  async hdel(...args) { this.commands.push(['hdel', ...args]); }
  async hset(...args) { this.commands.push(['hset', ...args]); }
  async lpush(...args) { this.commands.push(['lpush', ...args]); }
  multi() {
    const commands = this.commands;
    return {
      hset(...args) { commands.push(['hset', ...args]); return this; },
      lpush(...args) { commands.push(['lpush', ...args]); return this; },
      async exec() {},
    };
  }
}

async function run() {
  const staleRecord = JSON.stringify({ workerId: WORKER_ID, startedAt: Date.now() - 60_000 });
  const statuses = [];
  const enqueued = [];
  const dependencies = {
    queue: { async enqueue(id) { enqueued.push(id); } },
    repository: {
      async updateSubmissionStatus(id, status) { statuses.push([id, status]); },
      async insertResult() {},
    },
  };

  const retryRedis = new FakeRedis(staleRecord);
  await recoverOrphanedJobs(retryRedis, dependencies);
  assert.deepEqual(enqueued, [JOB_ID]);
  assert.deepEqual(statuses, [[JOB_ID, 'pending']]);

  const completedRedis = new FakeRedis(staleRecord, { cachedResult: true });
  await recoverOrphanedJobs(completedRedis, dependencies);
  assert.equal(enqueued.length, 1, 'completed job must not be re-enqueued');

  const dlqRedis = new FakeRedis(staleRecord, { retryCount: String(config.MAX_RETRIES) });
  await recoverOrphanedJobs(dlqRedis, dependencies);
  assert.equal(enqueued.length, 1, 'exhausted job must not be re-enqueued');
  assert(statuses.some(([, status]) => status === 'failed'));
  assert(dlqRedis.commands.some(([command, key]) => command === 'lpush' && key === 'exec:dlq'));
  process.stdout.write('watchdog tests passed\n');
}

run().then(() => process.exit(0)).catch((err) => {
  process.stderr.write(`watchdog tests failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
