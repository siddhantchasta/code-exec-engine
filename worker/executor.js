'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const containerManager = require('./container-manager');
const config = require('../lib/config');
const logger = require('../lib/logger');

/**
 * @typedef {Object} ExecutionResult
 * @property {string}  stdout
 * @property {string}  stderr
 * @property {number}  exitCode
 * @property {boolean} timedOut
 * @property {number}  runtimeMs
 */

/**
 * Execute a Python code snippet inside a sandboxed Docker container.
 *
 * Flow:
 *   1. Write code to a temp file on the host.
 *   2. Create + start a container (code bind-mounted read-only).
 *   3. Arm a setTimeout that kills the container after EXECUTION_TIMEOUT_MS.
 *   4. Wait for the container to exit (naturally, by timeout kill, or by OOM kill).
 *   5. Collect stdout/stderr, determine timedOut / OOM, return result.
 *   6. Cleanup: remove container + delete temp file (always, via finally).
 *
 * @param {string}  code         — Python source code to execute
 * @param {string}  [submissionId] — caller-supplied ID for log correlation
 * @returns {Promise<ExecutionResult>}
 */
async function execute(code, submissionId) {
  const id = submissionId ?? randomUUID();
  const codePath = path.join(os.tmpdir(), `${id}.py`);

  logger.info({ submissionId: id }, 'execution started');

  // 1. Write code to host temp file
  fs.writeFileSync(codePath, code, 'utf-8');

  /** @type {import('dockerode').Container | undefined} */
  let container;
  let timedOut = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timeoutHandle;
  const startTime = Date.now();

  try {
    // 2. Create and start container
    container = await containerManager.createContainer(codePath);
    await containerManager.startContainer(container);

    // 3. Arm timeout — kills container after EXECUTION_TIMEOUT_MS
    const containerRef = container; // capture for closure
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      logger.info({ submissionId: id }, 'execution timed out, killing container');
      containerManager.killContainer(containerRef).catch(
        /** @param {unknown} err */ (err) => {
          logger.error({ submissionId: id, err }, 'failed to kill container on timeout');
        },
      );
    }, config.EXECUTION_TIMEOUT_MS);

    // 4. Wait for container to exit
    const waitResult = await containerManager.waitForContainer(container);
    clearTimeout(timeoutHandle);

    const runtimeMs = Date.now() - startTime;

    // 5. Collect logs
    const logs = await containerManager.getContainerLogs(container);

    const exitCode = waitResult.StatusCode;

    logger.info(
      { submissionId: id, exitCode, timedOut, runtimeMs },
      'execution completed',
    );

    return {
      stdout: logs.stdout,
      stderr: logs.stderr,
      exitCode,
      timedOut,
      runtimeMs,
    };
  } finally {
    // 6. Cleanup — always runs
    if (timeoutHandle) clearTimeout(timeoutHandle);

    if (container) {
      try {
        await containerManager.removeContainer(container);
      } catch (/** @type {unknown} */ err) {
        logger.error({ submissionId: id, err }, 'failed to remove container');
      }
    }

    try {
      fs.unlinkSync(codePath);
    } catch (/** @type {unknown} */ err) {
      logger.error({ submissionId: id, err }, 'failed to clean up temp file');
    }
  }
}

module.exports = { execute };
