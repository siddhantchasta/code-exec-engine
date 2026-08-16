'use strict';

const crypto = require('crypto');
const express = require('express');
const config = require('../lib/config');
const logger = require('../lib/logger');
const { createRateLimiter } = require('./middleware/rate-limit');
const submitRoute = require('./routes/submit');
const statusRoute = require('./routes/status');
const resultRoute = require('./routes/result');
const metricsRoute = require('./routes/metrics');
const redis = require('../lib/redis');
const { attachWebSocket } = require('./websocket');

// ---------------------------------------------------------------------------
// Express 4 API Server
//
// Routes: POST /submit, GET /status/:id, GET /result/:id, GET /metrics
// Auth: single hardcoded API key via x-api-key header (exempt: /metrics)
// Rate limiter: per-IP token bucket, Redis-backed Lua atomic
// requestId middleware: crypto.randomUUID() on every request, propagated to
//   exec:job:{id} hash + x-request-id response header
// ---------------------------------------------------------------------------

const app = express();

// ---------------------------------------------------------------------------
// Pre-auth middleware
// ---------------------------------------------------------------------------

app.use(express.json());

// Serve demo UI from public/ — before auth so HTML loads without API key
app.use(express.static('public'));
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// GET /metrics — mount before auth so Prometheus scraper needs no API key
const preAuthRouter = express.Router();
metricsRoute.mount(preAuthRouter);
app.use(preAuthRouter);

// ---------------------------------------------------------------------------
// requestId middleware — attaches a UUID to every request
// Stored in x-request-id response header.
// On /submit it is also written into exec:job:{id} by the submit route.
// ---------------------------------------------------------------------------

app.use((req, _res, next) => {
  /** @type {string} */
  const requestId = crypto.randomUUID();
  // Make requestId accessible to route handlers
  req.requestId = requestId;
  next();
});

// ---------------------------------------------------------------------------
// Auth — single API key check on all routes below this point
// ---------------------------------------------------------------------------

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
// Authenticated routes
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

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'api server started');
});

attachWebSocket(server, redis);

module.exports = app; // exported for testing
