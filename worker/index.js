'use strict';

const logger = require('../lib/logger');
const redis = require('../lib/redis');
const queue = require('./queue');
const repository = require('./repository');
const executor = require('./executor');

const jobKey = (id) => `exec:job:${id}`;

// ---------------------------------------------------------------------------
// Single async worker loop
//
// Flow per iteration:
//   1. BRPOP next job ID from Redis queue (blocks indefinitely)
//   2. Load code from Redis job hash
//   3. Mark status → running (Redis + PG)
//   4. Execute code in Docker sandbox
//   5. Determine final status (done | failed | timeout)
//   6. Store result in PG, update status in Redis + PG
//
// Known gap: if the worker crashes mid-job, the job stays 'running' forever.
// No watchdog or DLQ — documented honestly in project-brief.md.
// ---------------------------------------------------------------------------

/**
 * Determine the final status based on execution result.
 *
 * @param {{ timedOut: boolean, exitCode: number }} result
 * @returns {'done' | 'failed' | 'timeout'}
 */
function resolveStatus(result) {
  if (result.timedOut) return 'timeout';
  if (result.exitCode !== 0) return 'failed';
  return 'done';
}

/**
 * Process a single job: execute code, store result, update statuses.
 *
 * @param {string} jobId
 * @param {string} code
 * @returns {Promise<void>}
 */
async function processJob(jobId, code) {
  // Mark running in Redis and PostgreSQL
  await redis.hset(jobKey(jobId), 'status', 'running');
  await repository.updateSubmissionStatus(jobId, 'running');

  try {
    const result = await executor.execute(code, jobId);
    const finalStatus = resolveStatus(result);

    await repository.insertResult(jobId, result);
    await repository.updateSubmissionStatus(jobId, finalStatus);
    await redis.hset(jobKey(jobId), 'status', finalStatus);

    logger.info(
      { submissionId: jobId, status: finalStatus, runtimeMs: result.runtimeMs },
      'job completed',
    );
  } catch (/** @type {unknown} */ err) {
    logger.error({ submissionId: jobId, err }, 'job execution failed');
    await redis.hset(jobKey(jobId), 'status', 'failed').catch(/** @param {unknown} e */ (e) => {
      logger.error({ submissionId: jobId, err: e }, 'failed to set failure status in redis');
    });
    await repository.updateSubmissionStatus(jobId, 'failed').catch(/** @param {unknown} e */ (e) => {
      logger.error({ submissionId: jobId, err: e }, 'failed to set failure status in pg');
    });
  }
}

/**
 * Main worker loop — runs forever, one job at a time.
 * @returns {Promise<never>}
 */
async function main() {
  logger.info('worker started');

  while (true) {
    // BRPOP next job ID (blocks indefinitely until item is pushed)
    const jobId = await queue.dequeue();

    logger.info({ submissionId: jobId }, 'job dequeued');

    // Load code from Redis job hash
    const jobData = await redis.hgetall(jobKey(jobId));

    if (!jobData || !jobData.code) {
      logger.error({ submissionId: jobId }, 'job hash missing or has no code field — skipping');
      await redis.hset(jobKey(jobId), 'status', 'failed');
      await repository.updateSubmissionStatus(jobId, 'failed').catch(/** @param {unknown} e */ (e) => {
        logger.error({ submissionId: jobId, err: e }, 'failed to update pg status for missing-code job');
      });
      continue;
    }

    await processJob(jobId, jobData.code);
  }
}

// ---------------------------------------------------------------------------
// Entry point — run when invoked directly: node worker/index.js
// ---------------------------------------------------------------------------

main().catch(/** @param {unknown} err */ (err) => {
  logger.fatal({ err }, 'worker crashed');
  process.exit(1);
});
