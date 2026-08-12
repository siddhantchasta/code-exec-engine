'use strict';

const client = require('prom-client');

// ---------------------------------------------------------------------------
// Prometheus metrics registry
//
// Three metrics as specified in AGENTS.md:
//   1. exec_queue_depth           — Gauge     — current LLEN exec:queue
//   2. exec_execution_duration_ms — Histogram — per-job wall-clock ms (language + status)
//   3. exec_dlq_depth             — Gauge     — current LLEN exec:dlq
//
// Multi-process note: this project runs the API server and workers as separate
// Node.js processes. prom-client registries are in-process, so the worker's
// histogram observations are invisible to the API server's registry.
//
// Solution: workers persist aggregated histogram data to Redis hashes after
// each job. The /metrics route reads from Redis and renders the Prometheus text
// exposition format directly — Redis remains the only inter-process channel
// (per AGENTS.md architecture rule 2). In-process gauges (queue depth, DLQ depth)
// are set by the API server itself from live Redis LLEN calls on each scrape.
//
// Redis keys used (read by /metrics route):
//   exec:metrics:duration:{language}:{status}:count  — integer count
//   exec:metrics:duration:{language}:{status}:sum    — total ms (float string)
//   exec:metrics:duration:{language}:{status}:buckets — JSON array of [le, count] pairs
// ---------------------------------------------------------------------------

const register = new client.Registry();

/** Current depth of the FIFO job queue. Set by the API server on each /metrics scrape. */
const queueDepth = new client.Gauge({
  name: 'exec_queue_depth',
  help: 'Number of jobs currently waiting in the execution queue (exec:queue)',
  registers: [register],
});

/** Current depth of the dead-letter queue. Set by the API server on each /metrics scrape. */
const dlqDepth = new client.Gauge({
  name: 'exec_dlq_depth',
  help: 'Number of permanently failed jobs in the dead-letter queue (exec:dlq)',
  registers: [register],
});

/**
 * Wall-clock execution time per job — in-process histogram.
 * Used by the worker process to observe durations locally.
 * The /metrics route also reads raw Redis aggregates (see above).
 * Labels: language ('python'|'javascript'|'cpp'), status ('done'|'failed'|'timeout')
 */
const executionDuration = new client.Histogram({
  name: 'exec_execution_duration_ms',
  help: 'End-to-end job execution duration in milliseconds, by language and terminal status',
  labelNames: /** @type {const} */ (['language', 'status']),
  buckets: [50, 100, 250, 500, 1000, 2000, 5000, 10000],
  registers: [register],
});

/**
 * Bucket upper-bounds used for histogram exposition. Must match the buckets above.
 * @type {number[]}
 */
const HISTOGRAM_BUCKETS = [50, 100, 250, 500, 1000, 2000, 5000, 10000];

/**
 * Redis key prefix for cross-process histogram aggregation.
 * @param {string} language
 * @param {string} status
 * @returns {string}
 */
const durationKey = (language, status) => `exec:metrics:duration:${language}:${status}`;

/**
 * Record one job's execution duration in Redis for cross-process aggregation.
 * Called by the worker after each job completes.
 *
 * @param {import('ioredis').Redis} redis
 * @param {string} language
 * @param {string} status
 * @param {number} durationMs
 * @returns {Promise<void>}
 */
async function recordDuration(redis, language, status, durationMs) {
  const prefix = durationKey(language, status);
  await redis.incrbyfloat(`${prefix}:sum`, durationMs);
  await redis.incr(`${prefix}:count`);
  // Increment each bucket whose upper bound >= durationMs (+Inf always)
  for (const le of HISTOGRAM_BUCKETS) {
    if (durationMs <= le) {
      await redis.incr(`${prefix}:bucket:${le}`);
    }
  }
  await redis.incr(`${prefix}:bucket:+Inf`); // always increment +Inf
}

/**
 * Build Prometheus text exposition for exec_execution_duration_ms by reading
 * Redis aggregates. Called by the /metrics route so data spans all worker replicas.
 *
 * @param {import('ioredis').Redis} redis
 * @returns {Promise<string>}
 */
async function renderDurationMetric(redis) {
  const languages = ['python', 'javascript', 'cpp'];
  const statuses = ['done', 'failed', 'timeout'];

  const lines = [
    '# HELP exec_execution_duration_ms End-to-end job execution duration in milliseconds, by language and terminal status',
    '# TYPE exec_execution_duration_ms histogram',
  ];

  for (const language of languages) {
    for (const status of statuses) {
      const prefix = durationKey(language, status);
      const countRaw = await redis.get(`${prefix}:count`);
      if (!countRaw) continue; // no observations for this label combo yet

      const count = parseInt(countRaw, 10);
      const sumRaw = await redis.get(`${prefix}:sum`);
      const sum = parseFloat(sumRaw || '0');
      const label = `language="${language}",status="${status}"`;

      for (const le of HISTOGRAM_BUCKETS) {
        const bucketCount = parseInt((await redis.get(`${prefix}:bucket:${le}`)) || '0', 10);
        lines.push(`exec_execution_duration_ms_bucket{le="${le}",${label}} ${bucketCount}`);
      }
      lines.push(`exec_execution_duration_ms_bucket{le="+Inf",${label}} ${count}`);
      lines.push(`exec_execution_duration_ms_sum{${label}} ${sum}`);
      lines.push(`exec_execution_duration_ms_count{${label}} ${count}`);
    }
  }

  return lines.join('\n') + '\n';
}

module.exports = {
  register,
  queueDepth,
  dlqDepth,
  executionDuration,
  HISTOGRAM_BUCKETS,
  recordDuration,
  renderDurationMetric,
};
