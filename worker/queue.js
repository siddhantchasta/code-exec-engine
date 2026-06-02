'use strict';

const redis = require('../lib/redis');

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
  await redis.lpush('exec:queue', jobId);
}

/**
 * Block-pop the next job ID from the queue.
 * Blocks indefinitely (timeout = 0) until a job is available.
 *
 * @returns {Promise<string>}
 */
async function dequeue() {
  const result = await redis.brpop('exec:queue', 0);
  // brpop returns [key, value]
  return result[1];
}

module.exports = { enqueue, dequeue };
