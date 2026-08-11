'use strict';

const redis = require('../lib/redis');
const { QUEUE } = require('../lib/redis-keys');

// ---------------------------------------------------------------------------
// Queue operations (FIFO via LPUSH + BRPOP)
// ---------------------------------------------------------------------------

/**
 * Add a job ID to the back of the queue.
 * LPUSH pushes to the left; BRPOP pops from the right → FIFO.
 *
 * @param {string} jobId
 * @returns {Promise<void>}
 */
async function enqueue(jobId) {
  await redis.lpush(QUEUE, jobId);
}

/**
 * Block-pop the next job ID from the queue.
 * Blocks indefinitely (timeout = 0) until a job is available.
 *
 * @param {number} [timeoutSeconds]
 * @returns {Promise<string | null>}
 */
async function dequeue(timeoutSeconds = 0) {
  const result = await redis.brpop(QUEUE, timeoutSeconds);
  // brpop returns [key, value]
  return result ? result[1] : null;
}

/** @returns {Promise<number>} */
async function depth() {
  return redis.llen(QUEUE);
}

module.exports = { enqueue, dequeue, depth };
