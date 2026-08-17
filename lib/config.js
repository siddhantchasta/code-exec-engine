'use strict';

require('dotenv').config();
const os = require('node:os');
const { z } = require('zod');

const configSchema = z.object({
  /** Maximum execution time before container is killed (ms) */
  EXECUTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  /** Maximum C++ compilation time before the sandbox is killed (ms) */
  CPP_COMPILE_TIMEOUT_MS: z.coerce.number().int().positive().max(10000).default(10000),

  /** Pino log level */
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  /** Redis connection URL */
  REDIS_URL: z.string().default('redis://localhost:6380'),

  /** Node environment */
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),

  /** PostgreSQL connection */
  DATABASE_URL: z.string().optional(),
  PG_HOST: z.string().default('localhost'),
  PG_PORT: z.coerce.number().int().positive().default(5439),
  PG_USER: z.string().default('postgres'),
  PG_PASSWORD: z.string().default('postgres'),
  PG_DATABASE: z.string().default('code_exec'),

  /** API server */
  API_KEY: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),

  /** Unique identifier for one worker replica */
  WORKER_ID: z.string().min(1).default(`worker-${os.hostname()}`),

  /** Rate limiter — token bucket */
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_WINDOW: z.coerce.number().int().positive().default(60),

  /** Queue admission control */
  MAX_QUEUE_DEPTH: z.coerce.number().int().positive().default(100),

  /** Worker liveness and recovery */
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  HEARTBEAT_TTL_SECONDS: z.coerce.number().int().positive().default(15),
  WATCHDOG_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  STALE_THRESHOLD_SECONDS: z.coerce.number().int().positive().default(15),
  MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
});

/** @type {z.infer<typeof configSchema>} */
const config = configSchema.parse(process.env);

module.exports = config;
