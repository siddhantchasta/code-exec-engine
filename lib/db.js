'use strict';

const { Pool } = require('pg');
const config = require('./config');
const logger = require('./logger');

const isLocal =
  (!config.DATABASE_URL && (config.PG_HOST === 'localhost' || config.PG_HOST === 'postgres')) ||
  (config.DATABASE_URL && (config.DATABASE_URL.includes('localhost') || config.DATABASE_URL.includes('127.0.0.1')));

const poolConfig = config.DATABASE_URL
  ? {
      connectionString: config.DATABASE_URL,
      ssl: isLocal ? false : { rejectUnauthorized: false },
    }
  : {
      host: config.PG_HOST,
      port: config.PG_PORT,
      user: config.PG_USER,
      password: config.PG_PASSWORD,
      database: config.PG_DATABASE,
      ssl: isLocal ? false : { rejectUnauthorized: false },
    };

const pool = new Pool(poolConfig);

pool.on('error', /** @param {unknown} err */ (err) => {
  logger.error({ err }, 'unexpected pg pool error');
});

module.exports = pool;
