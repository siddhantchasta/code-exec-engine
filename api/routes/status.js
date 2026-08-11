'use strict';

const { z } = require('zod');
const redis = require('../../lib/redis');
const { job } = require('../../lib/redis-keys');

// ---------------------------------------------------------------------------
// GET /status/:id — fast status lookup from Redis hash
// ---------------------------------------------------------------------------

const uuidSchema = z.string().uuid();

/**
 * @param {import('express').Router} router
 * @returns {void}
 */
function mount(router) {
  router.get('/status/:id', async (req, res) => {
    const parsed = uuidSchema.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid submission ID' });
      return;
    }

    const id = parsed.data;
    const status = await redis.hget(job(id), 'status');

    if (!status) {
      res.status(404).json({ error: 'Submission not found' });
      return;
    }

    res.status(200).json({ id, status });
  });
}

module.exports = { mount };
