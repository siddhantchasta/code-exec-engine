'use strict';

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
});

/** @type {z.infer<typeof configSchema>} */
const config = configSchema.parse(process.env);

module.exports = config;
