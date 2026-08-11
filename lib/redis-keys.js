'use strict';

const QUEUE = 'exec:queue';
const PROCESSING = 'exec:processing';
const DLQ = 'exec:dlq';

/** @param {string} jobId @returns {string} */
const job = (jobId) => `exec:job:${jobId}`;
/** @param {string} jobId @returns {string} */
const result = (jobId) => `exec:result:${jobId}`;
/** @param {string} jobId @returns {string} */
const stream = (jobId) => `exec:stream:${jobId}`;
/** @param {string} workerId @returns {string} */
const heartbeat = (workerId) => `exec:worker:${workerId}:heartbeat`;
/** @param {string} ip @returns {string} */
const rateLimit = (ip) => `rl:${ip}`;

module.exports = {
  QUEUE,
  PROCESSING,
  DLQ,
  job,
  result,
  stream,
  heartbeat,
  rateLimit,
};
