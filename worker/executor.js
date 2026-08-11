'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const containerManager = require('./container-manager');
const config = require('../lib/config');
const { getLanguage } = require('../lib/languages');
const logger = require('../lib/logger');
const redis = require('../lib/redis');
const { stream } = require('../lib/redis-keys');

/**
 * @typedef {Object} ExecutionResult
 * @property {string} stdout
 * @property {string} stderr
 * @property {string} compileStdout
 * @property {string} compileStderr
 * @property {number} exitCode
 * @property {boolean} timedOut
 * @property {number} runtimeMs
 */

/**
 * Execute a command and kill the sandbox if it exceeds its phase timeout.
 *
 * @param {import('dockerode').Container} container
 * @param {string[]} command
 * @param {number} timeoutMs
 * @param {string} submissionId
 * @param {'compile' | 'run'} phase
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number, timedOut: boolean }>}
 */
async function executePhase(container, command, timeoutMs, submissionId, phase) {
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    logger.info({ submissionId, phase }, 'execution phase timed out, killing container');
    containerManager.killContainer(container).catch(/** @param {unknown} err */ (err) => {
      logger.error({ submissionId, phase, err }, 'failed to kill container on timeout');
    });
  }, timeoutMs);

  try {
    const result = await containerManager.execInContainer(container, command, {
      tty: phase === 'run',
      onChunk: phase === 'run'
        ? (chunk, outputStream) => {
          redis.publish(
            stream(submissionId),
            JSON.stringify({ type: 'output', stream: outputStream, chunk }),
          ).catch(/** @param {unknown} err */ (err) => {
            logger.error({ submissionId, err }, 'failed to publish output chunk');
          });
        }
        : undefined,
    });
    return { ...result, timedOut };
  } catch (/** @type {unknown} */ err) {
    // A timeout kill can race Docker's exec startup/inspection and produce 409.
    // The phase is still correctly classified as a timeout.
    if (timedOut) {
      return { stdout: '', stderr: '', exitCode: 137, timedOut: true };
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Execute a source snippet inside a language-specific sandbox.
 * The two-argument form remains compatible with existing Python callers:
 * execute(code, submissionId). New callers use execute(code, language, submissionId).
 *
 * @param {string} code
 * @param {string} [languageOrSubmissionId]
 * @param {string} [submissionId]
 * @returns {Promise<ExecutionResult>}
 */
async function execute(code, languageOrSubmissionId, submissionId) {
  const isLanguage = getLanguage(languageOrSubmissionId ?? '') !== null;
  const language = isLanguage ? languageOrSubmissionId : 'python';
  const id = submissionId ?? (isLanguage ? randomUUID() : languageOrSubmissionId) ?? randomUUID();
  const languageConfig = getLanguage(language);

  if (!languageConfig) {
    throw new TypeError(`unsupported language: ${language}`);
  }

  const codePath = path.join(os.tmpdir(), `${id}-${languageConfig.fileName}`);
  fs.writeFileSync(codePath, code, 'utf-8');
  logger.info({ submissionId: id, language }, 'execution started');

  /** @type {import('dockerode').Container | undefined} */
  let container;
  const startTime = Date.now();

  try {
    container = await containerManager.createContainer(codePath, language);
    await containerManager.startContainer(container);

    if (languageConfig.compile) {
      const compileResult = await executePhase(
        container,
        languageConfig.compile,
        config.CPP_COMPILE_TIMEOUT_MS,
        id,
        'compile',
      );

      if (compileResult.timedOut || compileResult.exitCode !== 0) {
        return {
          stdout: '',
          stderr: '',
          compileStdout: compileResult.stdout,
          compileStderr: compileResult.stderr,
          exitCode: compileResult.exitCode,
          timedOut: compileResult.timedOut,
          runtimeMs: Date.now() - startTime,
        };
      }

      const runResult = await executePhase(
        container,
        languageConfig.run,
        config.EXECUTION_TIMEOUT_MS,
        id,
        'run',
      );
      return {
        stdout: runResult.stdout,
        stderr: runResult.stderr,
        compileStdout: compileResult.stdout,
        compileStderr: compileResult.stderr,
        exitCode: runResult.exitCode,
        timedOut: runResult.timedOut,
        runtimeMs: Date.now() - startTime,
      };
    }

    const runResult = await executePhase(
      container,
      languageConfig.run,
      config.EXECUTION_TIMEOUT_MS,
      id,
      'run',
    );
    return {
      stdout: runResult.stdout,
      stderr: runResult.stderr,
      compileStdout: '',
      compileStderr: '',
      exitCode: runResult.exitCode,
      timedOut: runResult.timedOut,
      runtimeMs: Date.now() - startTime,
    };
  } finally {
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
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return;
      logger.error({ submissionId: id, err }, 'failed to clean up temp file');
    }
  }
}

module.exports = { execute };
