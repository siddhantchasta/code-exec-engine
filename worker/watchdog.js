'use strict';

const config = require('../lib/config');
const logger = require('../lib/logger');
const redis = require('../lib/redis');
const { PROCESSING, DLQ, heartbeat, job, result } = require('../lib/redis-keys');
const queue = require('./queue');
const repository = require('./repository');

/**
 * @typedef {{ workerId: string, startedAt: number }} ProcessingRecord
 */

/**
 * Recover each job whose owning worker has missed its heartbeat.
 *
 * @param {import('ioredis').default} [redisClient]
 * @param {{ queue: typeof queue, repository: typeof repository }} [dependencies]
 * @returns {Promise<void>}
 */
async function recoverOrphanedJobs(redisClient = redis, dependencies = { queue, repository }) {
  const processing = await redisClient.hgetall(PROCESSING);

  await Promise.all(Object.entries(processing).map(async ([jobId, rawRecord]) => {
    /** @type {ProcessingRecord | null} */
    let record = null;
    try {
      const parsed = JSON.parse(rawRecord);
      if (typeof parsed.workerId === 'string' && typeof parsed.startedAt === 'number') record = parsed;
    } catch {
      logger.error({ jobId }, 'invalid processing record; moving job to DLQ');
    }

    if (!record) {
      await redisClient.hdel(PROCESSING, jobId);
      await redisClient.lpush(DLQ, jobId);
      await dependencies.repository.updateSubmissionStatus(jobId, 'failed');
      return;
    }

    const heartbeatTtl = await redisClient.ttl(heartbeat(record.workerId));
    const ageMs = Date.now() - record.startedAt;
    if (heartbeatTtl > 0 || ageMs < config.STALE_THRESHOLD_SECONDS * 1000) return;

    const cachedResult = await redisClient.exists(result(jobId));
    if (cachedResult === 1) {
      await redisClient.hdel(PROCESSING, jobId);
      logger.info({ jobId, workerId: record.workerId }, 'orphaned processing marker cleared after completed job');
      return;
    }

    const storedRetryCount = Number(await redisClient.hget(job(jobId), 'retryCount') ?? '0');
    const retryCount = (Number.isFinite(storedRetryCount) ? storedRetryCount : 0) + 1;
    await redisClient.hdel(PROCESSING, jobId);

    if (retryCount > config.MAX_RETRIES) {
      await redisClient.multi()
        .hset(job(jobId), 'status', 'failed', 'retryCount', String(retryCount))
        .lpush(DLQ, jobId)
        .exec();
      await dependencies.repository.updateSubmissionStatus(jobId, 'failed');
      logger.warn({ jobId, workerId: record.workerId, retryCount }, 'orphaned job moved to DLQ');
      return;
    }

    await redisClient.hset(job(jobId), 'status', 'pending', 'retryCount', String(retryCount));
    await dependencies.repository.updateSubmissionStatus(jobId, 'pending');
    await dependencies.queue.enqueue(jobId);
    logger.warn({ jobId, workerId: record.workerId, retryCount }, 'orphaned job re-queued');
  }));
}

/** @returns {NodeJS.Timeout} */
function startWatchdog() {
  const interval = setInterval(() => {
    recoverOrphanedJobs().catch(/** @param {unknown} err */ (err) => {
      logger.error({ err }, 'watchdog recovery pass failed');
    });
  }, config.WATCHDOG_INTERVAL_MS);
  interval.unref();
  return interval;
}

async function main() {
  logger.info('watchdog started');
  const interval = startWatchdog();
  await recoverOrphanedJobs();
  const stop = async () => {
    clearInterval(interval);
    await redis.quit();
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (require.main === module) {
  main().catch(/** @param {unknown} err */ (err) => {
    logger.fatal({ err }, 'watchdog crashed');
    process.exit(1);
  });
}

module.exports = { recoverOrphanedJobs, startWatchdog };
