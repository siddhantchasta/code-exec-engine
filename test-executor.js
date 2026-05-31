'use strict';

const { execute } = require('./worker/executor');
const logger = require('./lib/logger');

/**
 * @typedef {Object} GateTest
 * @property {string}  name
 * @property {string}  code
 * @property {(r: import('./worker/executor').ExecutionResult) => boolean} check
 */

/** @type {GateTest[]} */
const GATE_TESTS = [
  {
    name: 'hello-world',
    code: 'print("hello world")',
    check: (r) =>
      r.stdout === 'hello world\n' && r.exitCode === 0 && r.timedOut === false,
  },
  {
    name: 'infinite-loop-timeout',
    code: 'while True: pass',
    check: (r) => r.timedOut === true,
  },
  {
    name: 'oom-512mb',
    code: 'x = bytearray(1024*1024*512)',
    check: (r) => r.exitCode === 137 && r.timedOut === false,
  },
  {
    name: 'network-blocked',
    code: 'import urllib.request; urllib.request.urlopen("http://example.com")',
    check: (r) => r.exitCode !== 0 && r.timedOut === false,
  },
  {
    name: 'fork-bomb-pid-limit',
    code: 'import os\n[os.fork() for _ in range(200)]',
    check: (r) => r.exitCode !== 0 && r.timedOut === false,
  },
];

/**
 * Run all gate tests sequentially and report results.
 * @returns {Promise<void>}
 */
async function runGateTests() {
  let passed = 0;
  let failed = 0;

  for (const test of GATE_TESTS) {
    const submissionId = `gate-${test.name}`;
    logger.info({ testName: test.name }, '--- running gate test ---');

    try {
      const result = await execute(test.code, submissionId);
      const ok = test.check(result);

      const summary = {
        testName: test.name,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        runtimeMs: result.runtimeMs,
        stdout: result.stdout.slice(0, 200),
        stderr: result.stderr.slice(0, 200),
      };

      if (ok) {
        passed++;
        logger.info(summary, 'PASSED');
      } else {
        failed++;
        logger.error(summary, 'FAILED');
      }
    } catch (/** @type {unknown} */ err) {
      failed++;
      logger.error({ testName: test.name, err }, 'ERROR');
    }
  }

  logger.info({ passed, failed, total: GATE_TESTS.length }, '--- gate summary ---');
  process.exit(failed > 0 ? 1 : 0);
}

runGateTests();
