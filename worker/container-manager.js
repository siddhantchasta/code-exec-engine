'use strict';

const Docker = require('dockerode');
const config = require('../lib/config');
const logger = require('../lib/logger');

const docker = new Docker();

// ---------------------------------------------------------------------------
// Container lifecycle: create → start → wait → kill → remove
// ---------------------------------------------------------------------------

/**
 * Create a sandbox container with all 8 security flags.
 * The user code file is bind-mounted read-only at /code/script.py.
 *
 * @param {string} hostCodePath — absolute path to the .py file on the host
 * @returns {Promise<import('dockerode').Container>}
 */
async function createContainer(hostCodePath) {
  const container = await docker.createContainer({
    Image: config.DOCKER_IMAGE,
    Cmd: ['python3', '/code/script.py'],
    WorkingDir: '/sandbox',
    User: '65534',
    NetworkDisabled: true,
    HostConfig: {
      Memory: 256 * 1024 * 1024,          // --memory=256m
      MemorySwap: 256 * 1024 * 1024,      // --memory-swap=256m  (disables swap)
      PidsLimit: 50,                       // --pids-limit=50
      NetworkMode: 'none',                 // --network=none
      ReadonlyRootfs: true,                // --read-only
      Tmpfs: { '/sandbox': 'size=16m' },   // --tmpfs /sandbox:16m
      CapDrop: ['ALL'],                    // --cap-drop=ALL
      Binds: [`${hostCodePath}:/code/script.py:ro`],
    },
  });

  logger.debug({ containerId: container.id }, 'container created');
  return container;
}

/**
 * Start a created container.
 * @param {import('dockerode').Container} container
 * @returns {Promise<void>}
 */
async function startContainer(container) {
  await container.start();
  logger.debug({ containerId: container.id }, 'container started');
}

/**
 * Block until the container exits. Returns the exit status.
 * @param {import('dockerode').Container} container
 * @returns {Promise<{ StatusCode: number }>}
 */
async function waitForContainer(container) {
  const result = await container.wait();
  logger.debug(
    { containerId: container.id, statusCode: result.StatusCode },
    'container finished',
  );
  return result;
}

/**
 * Retrieve stdout and stderr from a stopped container.
 *
 * Docker's log API returns a multiplexed byte stream when Tty is false
 * (the default). Each frame has an 8-byte header:
 *   [stream_type (1 byte), 0, 0, 0, size (4 bytes big-endian), ...payload]
 * stream_type: 1 = stdout, 2 = stderr.
 *
 * @param {import('dockerode').Container} container
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
async function getContainerLogs(container) {
  const rawLogs = await container.logs({
    stdout: true,
    stderr: true,
    follow: false,
  });

  const buffer = Buffer.isBuffer(rawLogs)
    ? rawLogs
    : Buffer.from(String(rawLogs), 'binary');

  /** @type {string[]} */
  const stdoutChunks = [];
  /** @type {string[]} */
  const stderrChunks = [];

  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const streamType = buffer.readUInt8(offset);
    const frameSize = buffer.readUInt32BE(offset + 4);
    offset += 8;

    if (offset + frameSize > buffer.length) break;

    const payload = buffer.subarray(offset, offset + frameSize).toString('utf-8');

    if (streamType === 1) {
      stdoutChunks.push(payload);
    } else if (streamType === 2) {
      stderrChunks.push(payload);
    }

    offset += frameSize;
  }

  return {
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
  };
}

/**
 * Kill a running container. Silently succeeds if already stopped.
 * @param {import('dockerode').Container} container
 * @returns {Promise<void>}
 */
async function killContainer(container) {
  try {
    await container.kill();
    logger.debug({ containerId: container.id }, 'container killed');
  } catch (/** @type {unknown} */ err) {
    // Docker returns 409 when the container is not running
    if (
      err !== null &&
      typeof err === 'object' &&
      'statusCode' in err &&
      /** @type {{ statusCode: number }} */ (err).statusCode === 409
    ) {
      logger.debug({ containerId: container.id }, 'container already stopped');
      return;
    }
    throw err;
  }
}

/**
 * Remove a container (force).
 * @param {import('dockerode').Container} container
 * @returns {Promise<void>}
 */
async function removeContainer(container) {
  await container.remove({ force: true });
  logger.debug({ containerId: container.id }, 'container removed');
}

module.exports = {
  createContainer,
  startContainer,
  waitForContainer,
  getContainerLogs,
  killContainer,
  removeContainer,
};
