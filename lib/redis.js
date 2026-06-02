'use strict';

const Redis = require('ioredis');
const config = require('./config');
const logger = require('./logger');

const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null, // required for BRPOP (blocking commands)
});

redis.on('connect', () => {
  logger.info('redis connected');
});

redis.on('error', /** @param {unknown} err */ (err) => {
  logger.error({ err }, 'redis connection error');
});

module.exports = redis;
