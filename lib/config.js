'use strict';

require('dotenv').config();
const { z } = require('zod');

const configSchema = z.object({
  /** Maximum execution time before container is killed (ms) */
  EXECUTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  /** Docker image name for the Python sandbox */
  DOCKER_IMAGE: z.string().default('sandbox-python'),

  /** Pino log level */
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  /** Redis connection URL */
  REDIS_URL: z.string().default('redis://localhost:6380'),

  /** PostgreSQL connection */
  PG_HOST: z.string().default('localhost'),
  PG_PORT: z.coerce.number().int().positive().default(5434),
  PG_USER: z.string().default('postgres'),
  PG_PASSWORD: z.string().default('postgres'),
  PG_DATABASE: z.string().default('code_exec'),

  /** API server */
  API_KEY: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),

  /** Rate limiter — token bucket */
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_WINDOW: z.coerce.number().int().positive().default(60),
});

/** @type {z.infer<typeof configSchema>} */
const config = configSchema.parse(process.env);

module.exports = config;
