'use strict';

const express = require('express');
const config = require('../lib/config');
const logger = require('../lib/logger');
const { createRateLimiter } = require('./middleware/rate-limit');
const submitRoute = require('./routes/submit');
const statusRoute = require('./routes/status');
const resultRoute = require('./routes/result');

// ---------------------------------------------------------------------------
// Express 4 API Server
//
// Three routes: POST /submit, GET /status/:id, GET /result/:id
// Auth: single hardcoded API key via x-api-key header
// Rate limiter: per-IP token bucket, Redis-backed
// ---------------------------------------------------------------------------

const app = express();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(express.json());

// Auth — single API key check on all routes
app.use((req, res, next) => {
  if (req.headers['x-api-key'] !== config.API_KEY) {
    logger.warn({ ip: req.ip, path: req.path }, 'unauthorized request');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
});

// Rate limiter — per-IP token bucket
app.use(createRateLimiter());

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const router = express.Router();
submitRoute.mount(router);
statusRoute.mount(router);
resultRoute.mount(router);
app.use(router);

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------

/** @type {import('express').ErrorRequestHandler} */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, _req, res, _next) {
  logger.error({ err }, 'unhandled error');
  res.status(500).json({ error: 'Internal server error' });
}
app.use(errorHandler);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'api server started');
});

module.exports = app; // exported for testing
