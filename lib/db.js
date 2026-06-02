'use strict';

const { Pool } = require('pg');
const config = require('./config');
const logger = require('./logger');

const pool = new Pool({
  host: config.PG_HOST,
  port: config.PG_PORT,
  user: config.PG_USER,
  password: config.PG_PASSWORD,
  database: config.PG_DATABASE,
});

pool.on('error', /** @param {unknown} err */ (err) => {
  logger.error({ err }, 'unexpected pg pool error');
});

module.exports = pool;
