'use strict';

const logger = require('../lib/logger');
const redis = require('../lib/redis');
const queue = require('./queue');
const repository = require('./repository');
const executor = require('./executor');
const config = require('../lib/config');
const { PROCESSING, heartbeat, job, result, stream } = require('../lib/redis-keys');
const { executionDuration, queueDepth: queueDepthGauge, dlqDepth: dlqDepthGauge, recordDuration } = require('../lib/metrics');

/**
 * Determine the final status based on execution result.
 *
 * @param {{ timedOut: boolean, exitCode: number }} executionResult
 * @returns {'done' | 'failed' | 'timeout'}
 */
function resolveStatus(executionResult) {
  if (executionResult.timedOut) return 'timeout';
  if (executionResult.exitCode !== 0) return 'failed';
  return 'done';
}

/**
 * Process one claimed job and persist its terminal result.
 *
 * @param {string} jobId
 * @param {string} code
 * @param {string} language
 * @param {string} requestId
 * @returns {Promise<void>}
 */
async function processJob(jobId, code, language, requestId) {
  await redis.hset(job(jobId), 'status', 'running');
  await repository.updateSubmissionStatus(jobId, 'running');

  const startTime = Date.now();

  try {
    const executionResult = await executor.execute(code, language, jobId);
    const finalStatus = resolveStatus(executionResult);
    const runtimeMs = Date.now() - startTime;

    // Persist to Redis for cross-process Prometheus aggregation
    await recordDuration(redis, language, finalStatus, runtimeMs);
    // Also observe in-process (for any local tooling / tests)
    executionDuration.observe({ language, status: finalStatus }, runtimeMs);

    await repository.insertResult(jobId, executionResult);
    await repository.updateSubmissionStatus(jobId, finalStatus);
    await redis.hset(job(jobId), 'status', finalStatus);
    await redis.hset(
      result(jobId),
      'status', finalStatus,
      'stdout', executionResult.stdout,
      'stderr', executionResult.stderr,
      'compileStdout', executionResult.compileStdout,
      'compileStderr', executionResult.compileStderr,
      'exitCode', String(executionResult.exitCode),
      'runtimeMs', String(executionResult.runtimeMs),
      'timedOut', String(executionResult.timedOut),
    );
    await redis.publish(
      stream(jobId),
      JSON.stringify({ type: 'done', result: { ...executionResult, status: finalStatus } }),
    );
    logger.info({ requestId, jobId, status: finalStatus, runtimeMs: executionResult.runtimeMs }, 'job completed');
  } catch (/** @type {unknown} */ err) {
    logger.error({ requestId, jobId, err }, 'job execution failed');
    await redis.hset(job(jobId), 'status', 'failed').catch(/** @param {unknown} redisError */ (redisError) => {
      logger.error({ requestId, jobId, err: redisError }, 'failed to set failure status in redis');
    });
    await repository.updateSubmissionStatus(jobId, 'failed').catch(/** @param {unknown} dbError */ (dbError) => {
      logger.error({ requestId, jobId, err: dbError }, 'failed to set failure status in postgres');
    });
  }
}

/** @returns {Promise<void>} */
async function main() {
  let draining = false;
  /** @type {Promise<void> | null} */
  let activeJob = null;

  const sendHeartbeat = async () => {
    await redis.set(heartbeat(config.WORKER_ID), '1', 'EX', config.HEARTBEAT_TTL_SECONDS);
  };
  await sendHeartbeat();
  const heartbeatInterval = setInterval(() => {
    sendHeartbeat().catch(/** @param {unknown} err */ (err) => {
      logger.error({ workerId: config.WORKER_ID, err }, 'failed to refresh worker heartbeat');
    });
  }, config.HEARTBEAT_INTERVAL_MS);

  /** @returns {Promise<void>} */
  const shutdown = async () => {
    if (draining) return;
    draining = true;
    clearInterval(heartbeatInterval);
    logger.info({ workerId: config.WORKER_ID }, 'worker draining after shutdown signal');
    if (activeJob) {
      await Promise.race([
        activeJob,
        new Promise((resolve) => setTimeout(resolve, config.SHUTDOWN_TIMEOUT_MS)),
      ]);
    }
    await redis.del(heartbeat(config.WORKER_ID));
    await redis.quit();
    process.exit(0);
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  logger.info({ workerId: config.WORKER_ID }, 'worker started');

  while (!draining) {
    const jobId = await queue.dequeue(1);
    if (!jobId) continue;
    if (draining) break;

    logger.info({ jobId, workerId: config.WORKER_ID }, 'job dequeued');
    await redis.hset(PROCESSING, jobId, JSON.stringify({ workerId: config.WORKER_ID, startedAt: Date.now() }));
    activeJob = (async () => {
      try {
        const jobData = await redis.hgetall(job(jobId));
        if (!jobData.code) {
          logger.error({ jobId, workerId: config.WORKER_ID }, 'job hash missing or has no code field');
          const fallbackResult = {
            stdout: '',
            stderr: 'Job payload missing or lost in queue',
            compileStdout: '',
            compileStderr: '',
            exitCode: 1,
            timedOut: false,
            runtimeMs: 0,
          };
          await repository.insertResult(jobId, fallbackResult).catch(() => null);
          await repository.updateSubmissionStatus(jobId, 'failed');
          await redis.hset(job(jobId), 'status', 'failed');
          await redis.hset(
            result(jobId),
            'status', 'failed',
            'stdout', fallbackResult.stdout,
            'stderr', fallbackResult.stderr,
            'compileStdout', '',
            'compileStderr', '',
            'exitCode', '1',
            'runtimeMs', '0',
            'timedOut', 'false',
          ).catch(() => null);
          return;
        }
        const requestId = jobData.requestId || 'unknown';
        logger.info({ requestId, jobId, workerId: config.WORKER_ID, language: jobData.language }, 'job processing started');

        // Update queue depth gauge after dequeue
        const currentDepth = await queue.depth();
        queueDepthGauge.set(currentDepth);

        await processJob(jobId, jobData.code, jobData.language ?? 'python', requestId);
      } finally {
        await redis.hdel(PROCESSING, jobId);
        // Update DLQ depth gauge after each job (watchdog may have promoted to DLQ)
        const dlqLen = await redis.llen('exec:dlq');
        dlqDepthGauge.set(dlqLen);
      }
    })();
    await activeJob;
    activeJob = null;
  }
}

if (require.main === module) {
  main().catch(/** @param {unknown} err */ (err) => {
    logger.fatal({ err }, 'worker crashed');
    process.exit(1);
  });
}

module.exports = { main, processJob, resolveStatus };
