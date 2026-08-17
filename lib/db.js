'use strict';

const { Pool } = require('pg');
const config = require('./config');
const logger = require('./logger');

const poolConfig = config.DATABASE_URL
  ? {
      connectionString: config.DATABASE_URL,
      ssl:
        config.NODE_ENV === 'production' ||
        config.DATABASE_URL.includes('sslmode=require') ||
        config.DATABASE_URL.includes('ssl=true')
          ? { rejectUnauthorized: false }
          : false,
    }
  : {
      host: config.PG_HOST,
      port: config.PG_PORT,
      user: config.PG_USER,
      password: config.PG_PASSWORD,
      database: config.PG_DATABASE,
    };

const pool = new Pool(poolConfig);

pool.on('error', /** @param {unknown} err */ (err) => {
  logger.error({ err }, 'unexpected pg pool error');
});

module.exports = pool;
