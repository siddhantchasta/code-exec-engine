'use strict';

const fs = require('fs');
const path = require('path');
const pool = require('../lib/db');
const logger = require('../lib/logger');

/**
 * Initialize PostgreSQL schema from docs/schema.sql.
 * Idempotent: safe to run multiple times.
 */
async function initDb() {
  const schemaPath = path.resolve(__dirname, '../docs/schema.sql');
  logger.info({ schemaPath }, 'reading schema sql file');

  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');

  try {
    logger.info('applying database schema migrations...');
    await pool.query(schemaSql);
    logger.info('database schema successfully applied');
  } catch (err) {
    logger.error({ err }, 'failed to apply database schema');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  initDb().catch((err) => {
    logger.error({ err }, 'unhandled error during database initialization');
    process.exit(1);
  });
}

module.exports = initDb;
