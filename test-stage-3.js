'use strict';

const redis = require('./lib/redis');
const db = require('./lib/db');
const queue = require('./worker/queue');
const repository = require('./worker/repository');
const logger = require('./lib/logger');

// 5 unique UUIDs for the gate test
const JOB_IDS = [
  'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
  'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a02',
  'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a03',
  'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a04',
  'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a05',
];

// 5 different Python snippets — each produces distinct, verifiable output
const SNIPPETS = [
  { code: 'print("gate-test-1")',       expectedStdout: 'gate-test-1\n',       expectedExit: 0 },
  { code: 'print(2 + 3)',               expectedStdout: '5\n',                 expectedExit: 0 },
  { code: 'print("hello " * 3)',        expectedStdout: 'hello hello hello \n', expectedExit: 0 },
  { code: 'import sys; print(sys.version_info.major)', expectedStdout: '3\n',  expectedExit: 0 },
  { code: 'print(list(range(5)))',      expectedStdout: '[0, 1, 2, 3, 4]\n',   expectedExit: 0 },
];

const jobKey = (id) => `exec:job:${id}`;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runStage3Gate() {
  logger.info('=== STAGE 3 GATE TEST — 5 end-to-end executions ===');

  try {
    // ---------------------------------------------------------------
    // 1. Clean slate — remove any old data
    // ---------------------------------------------------------------
    logger.info('cleaning up old data...');
    await db.query('DELETE FROM execution_results');
    await db.query('DELETE FROM submissions');
    await redis.del('exec:queue');
    for (const id of JOB_IDS) {
      await redis.del(jobKey(id));
    }

    // ---------------------------------------------------------------
    // 2. Create submissions in PG + set Redis job hashes + enqueue
    // ---------------------------------------------------------------
    const now = new Date().toISOString();
    for (let i = 0; i < 5; i++) {
      const id = JOB_IDS[i];
      const { code } = SNIPPETS[i];

      await repository.createSubmission(id, '127.0.0.1');
      await redis.hset(jobKey(id), 'status', 'pending', 'code', code, 'createdAt', now);
      await queue.enqueue(id);
      logger.info({ submissionId: id, snippet: code }, 'job enqueued');
    }

    // ---------------------------------------------------------------
    // 3. Poll until all 5 reach a terminal status
    // ---------------------------------------------------------------
    logger.info('waiting for worker to process all 5 jobs...');
    const terminalStatuses = ['done', 'failed', 'timeout'];
    let attempts = 0;
    const maxAttempts = 60; // 60 seconds max (5 sequential container starts)

    while (attempts < maxAttempts) {
      await sleep(1000);
      attempts++;

      const statuses = [];
      for (const id of JOB_IDS) {
        const s = await redis.hget(jobKey(id), 'status');
        statuses.push(s);
      }

      logger.info({ statuses, attempt: attempts }, 'polling');

      if (statuses.every((s) => terminalStatuses.includes(s))) break;
    }

    // Final status check
    const finalStatuses = [];
    for (const id of JOB_IDS) {
      finalStatuses.push(await redis.hget(jobKey(id), 'status'));
    }

    if (!finalStatuses.every((s) => terminalStatuses.includes(s))) {
      throw new Error(`Timeout — not all jobs finished: ${JSON.stringify(finalStatuses)}`);
    }

    // ---------------------------------------------------------------
    // Gate 1: SELECT * FROM execution_results → 5 rows
    // ---------------------------------------------------------------
    const { rows: results } = await db.query(
      'SELECT * FROM execution_results ORDER BY created_at ASC'
    );
    if (results.length !== 5) {
      throw new Error(`Gate 1 FAIL: expected 5 execution_results rows, got ${results.length}`);
    }
    logger.info('✅ Gate 1 PASSED: execution_results has exactly 5 rows');

    // ---------------------------------------------------------------
    // Gate 2: Each row has correct stdout, exit_code, runtime_ms
    // ---------------------------------------------------------------
    let gate2Passed = true;
    for (let i = 0; i < 5; i++) {
      const row = results[i];
      const expected = SNIPPETS[i];
      const errors = [];

      if (row.stdout !== expected.expectedStdout) {
        errors.push(`stdout: got "${row.stdout}", expected "${expected.expectedStdout}"`);
      }
      if (row.exit_code !== expected.expectedExit) {
        errors.push(`exit_code: got ${row.exit_code}, expected ${expected.expectedExit}`);
      }
      if (typeof row.runtime_ms !== 'number' || row.runtime_ms <= 0) {
        errors.push(`runtime_ms: got ${row.runtime_ms}, expected > 0`);
      }

      if (errors.length > 0) {
        logger.error({ submissionId: JOB_IDS[i], errors }, 'Gate 2 FAIL for job');
        gate2Passed = false;
      } else {
        logger.info(
          { submissionId: JOB_IDS[i], stdout: row.stdout.trim(), exitCode: row.exit_code, runtimeMs: row.runtime_ms },
          'Gate 2 OK'
        );
      }
    }
    if (!gate2Passed) throw new Error('Gate 2 FAIL: one or more rows have incorrect data');
    logger.info('✅ Gate 2 PASSED: all rows have correct stdout, exit_code, runtime_ms');

    // ---------------------------------------------------------------
    // Gate 3: submissions table — all 5 have status = 'done'
    // ---------------------------------------------------------------
    const { rows: submissions } = await db.query(
      "SELECT id, status FROM submissions ORDER BY created_at ASC"
    );
    if (submissions.length !== 5) {
      throw new Error(`Gate 3 FAIL: expected 5 submissions rows, got ${submissions.length}`);
    }
    const allDone = submissions.every((s) => s.status === 'done');
    if (!allDone) {
      const statusMap = submissions.map((s) => `${s.id.slice(0, 8)}=${s.status}`).join(', ');
      throw new Error(`Gate 3 FAIL: not all submissions are 'done': ${statusMap}`);
    }
    logger.info('✅ Gate 3 PASSED: all 5 submissions have status = done');

    // ---------------------------------------------------------------
    // Summary
    // ---------------------------------------------------------------
    logger.info('');
    logger.info('🎉 ALL STAGE 3 GATE CRITERIA PASSED 🎉');
    logger.info('  ✅ 5 complete end-to-end executions');
    logger.info('  ✅ execution_results: 5 rows with correct stdout, exit_code, runtime_ms');
    logger.info('  ✅ submissions: all 5 with status = done');

    process.exit(0);
  } catch (/** @type {unknown} */ err) {
    logger.error({ err }, '❌ STAGE 3 GATE FAILED');
    process.exit(1);
  }
}

runStage3Gate();
