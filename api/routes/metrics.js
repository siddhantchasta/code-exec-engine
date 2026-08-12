'use strict';

const redis = require('../../lib/redis');
const queue = require('../../worker/queue');
const { register, queueDepth, dlqDepth, renderDurationMetric } = require('../../lib/metrics');
const logger = require('../../lib/logger');

// ---------------------------------------------------------------------------
// GET /metrics — Prometheus text exposition format
//
// Mounted BEFORE the auth middleware so Prometheus scrapers need no API key.
//
// On each scrape:
//   1. Refresh exec_queue_depth gauge from live Redis LLEN
//   2. Refresh exec_dlq_depth gauge from live Redis LLEN
//   3. Render exec_execution_duration_ms histogram from Redis cross-process aggregates
//   4. Render the two gauges from prom-client registry
// ---------------------------------------------------------------------------

/**
 * @param {import('express').Router} router
 * @returns {void}
 */
function mount(router) {
  router.get('/metrics', async (_req, res) => {
    try {
      // Refresh live gauges from Redis before rendering
      const [currentQueueDepth, dlqLen] = await Promise.all([
        queue.depth(),
        redis.llen('exec:dlq'),
      ]);
      queueDepth.set(currentQueueDepth);
      dlqDepth.set(dlqLen);

      // Build histogram text from Redis aggregates (cross-process workers)
      const durationText = await renderDurationMetric(redis);

      // Render the two gauges from prom-client registry
      const gaugeText = await register.metrics();

      res.set('Content-Type', register.contentType);
      res.end(durationText + '\n' + gaugeText);
    } catch (/** @type {unknown} */ err) {
      logger.error({ err }, 'failed to collect metrics');
      res.status(500).end('# metrics collection error');
    }
  });
}

module.exports = { mount };
