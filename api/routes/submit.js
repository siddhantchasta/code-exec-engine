'use strict';

const crypto = require('crypto');
const { z } = require('zod');
const redis = require('../../lib/redis');
const logger = require('../../lib/logger');
const config = require('../../lib/config');
const queue = require('../../worker/queue');
const repository = require('../../worker/repository');
const { job } = require('../../lib/redis-keys');

// ---------------------------------------------------------------------------
// POST /submit — accept a supported-language snippet and queue it for execution
// ---------------------------------------------------------------------------

const submitBodySchema = z.object({
  code: z.string().min(1).max(10000),
  language: z.enum(['python', 'javascript', 'cpp']),
});

/**
 * @param {import('express').Router} router
 * @returns {void}
 */
function mount(router) {
  router.post('/submit', async (req, res) => {
    // Validate request body
    const parsed = submitBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { code, language } = parsed.data;
    const id = crypto.randomUUID();
    const ip = req.ip || '0.0.0.0';

    try {
      const queueDepth = await queue.depth();
      if (queueDepth >= config.MAX_QUEUE_DEPTH) {
        res.set('Retry-After', '30');
        logger.warn({ queueDepth, maxQueueDepth: config.MAX_QUEUE_DEPTH, ip }, 'submission rejected: queue full');
        res.status(503).json({ error: 'Queue is full. Please retry later.' });
        return;
      }

      // 1. Insert submission into PostgreSQL
      await repository.createSubmission(id, language, ip);

      // 2. Set Redis job hash
      const now = new Date().toISOString();
      await redis.hset(
        job(id),
        'status', 'pending',
        'code', code,
        'language', language,
        'createdAt', now,
        'retryCount', '0',
      );

      // 3. Enqueue for worker
      await queue.enqueue(id);

      logger.info({ submissionId: id }, 'submission accepted');

      res.status(202).json({
        id,
        statusUrl: `/status/${id}`,
      });
    } catch (/** @type {unknown} */ err) {
      logger.error({ submissionId: id, err }, 'failed to submit job');
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}

module.exports = { mount };
