'use strict';

const redis = require('./lib/redis');
const db = require('./lib/db');
const queue = require('./worker/queue');
const repository = require('./worker/repository');
const logger = require('./lib/logger');

const JOB1_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const JOB2_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12';
const JOB3_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13';

const jobKey = (id) => `exec:job:${id}`;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runStage2Tests() {
  logger.info('--- starting stage 2 integration tests ---');

  try {
    // 1. Clean up old data from Postgres and Redis
    logger.info('cleaning up old database and redis state...');
    await db.query('DELETE FROM execution_results');
    await db.query('DELETE FROM submissions');
    await redis.del('exec:queue');
    await redis.del(jobKey(JOB1_ID));
    await redis.del(jobKey(JOB2_ID));
    await redis.del(jobKey(JOB3_ID));

    // 2. Insert submissions into PostgreSQL
    logger.info('creating submissions in postgres...');
    await repository.createSubmission(JOB1_ID, '127.0.0.1');
    await repository.createSubmission(JOB2_ID, '127.0.0.1');
    await repository.createSubmission(JOB3_ID, '127.0.0.1');

    // 3. Set job hashes in Redis
    logger.info('setting job hashes in redis...');
    const now = new Date().toISOString();
    await redis.hset(jobKey(JOB1_ID), 'status', 'pending', 'code', 'print("job 1 success")', 'createdAt', now);
    await redis.hset(jobKey(JOB2_ID), 'status', 'pending', 'code', 'print("job 2 success")', 'createdAt', now);
    await redis.hset(jobKey(JOB3_ID), 'status', 'pending', 'code', 'print("job 3 success")', 'createdAt', now);

    // 4. Enqueue in FIFO order
    logger.info('enqueuing jobs in FIFO order (1, 2, 3)...');
    await queue.enqueue(JOB1_ID);
    await queue.enqueue(JOB2_ID);
    await queue.enqueue(JOB3_ID);

    logger.info('waiting for worker to process jobs...');
    
    // Poll Redis status until all jobs are processed (not 'pending' or 'running')
    let completed = false;
    let attempts = 0;
    const maxAttempts = 30; // 30 seconds max wait

    while (!completed && attempts < maxAttempts) {
      await sleep(1000);
      attempts++;

      const job1 = await redis.hgetall(jobKey(JOB1_ID));
      const job2 = await redis.hgetall(jobKey(JOB2_ID));
      const job3 = await redis.hgetall(jobKey(JOB3_ID));

      logger.info(
        {
          job1: job1.status,
          job2: job2.status,
          job3: job3.status,
        },
        `poll attempt ${attempts}`
      );

      const terminalStatuses = ['done', 'failed', 'timeout'];
      if (
        terminalStatuses.includes(job1.status) &&
        terminalStatuses.includes(job2.status) &&
        terminalStatuses.includes(job3.status)
      ) {
        completed = true;
      }
    }

    if (!completed) {
      throw new Error('Timeout waiting for worker to process jobs.');
    }

    // 5. Verifications
    logger.info('verifying results...');

    // Gate 4: Verify all 3 statuses end as 'done' in Redis
    const job1 = await redis.hgetall(jobKey(JOB1_ID));
    const job2 = await redis.hgetall(jobKey(JOB2_ID));
    const job3 = await redis.hgetall(jobKey(JOB3_ID));

    if (job1.status !== 'done' || job2.status !== 'done' || job3.status !== 'done') {
      throw new Error(`Unexpected job statuses in Redis: 1=${job1.status}, 2=${job2.status}, 3=${job3.status}`);
    }
    logger.info('✅ Gate 4 Passed: All statuses are done in Redis');

    // Gate 5: Verify PostgreSQL has 3 execution_results rows
    const { rows: results } = await db.query('SELECT * FROM execution_results ORDER BY created_at ASC');
    if (results.length !== 3) {
      throw new Error(`Expected 3 result rows in Postgres, got ${results.length}`);
    }
    logger.info('✅ Gate 5 Passed: PostgreSQL has exactly 3 execution_results rows');

    // Gate 3: Verify worker picks them up in FIFO order (checked via PG insert order)
    const order = results.map(r => r.submission_id);
    logger.info({ order }, 'execution order in Postgres');
    if (order[0] !== JOB1_ID || order[1] !== JOB2_ID || order[2] !== JOB3_ID) {
      throw new Error(`Jobs were not processed in FIFO order. Order was: ${order.join(', ')}`);
    }
    logger.info('✅ Gate 3 Passed: Jobs processed in perfect FIFO order');

    logger.info('🎉 ALL STAGE 2 GATE TESTS PASSED SUCCESSFULLY! 🎉');
    process.exit(0);

  } catch (err) {
    logger.error({ err }, '❌ Stage 2 Integration Tests Failed!');
    process.exit(1);
  }
}

runStage2Tests();
