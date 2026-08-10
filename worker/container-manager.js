'use strict';

const Docker = require('dockerode');
const logger = require('../lib/logger');
const { getLanguage } = require('../lib/languages');

const docker = new Docker();

/** @param {string} output @returns {string} */
function normalizeTtyOutput(output) {
  return output.replace(/\r\n/g, '\n');
}

// ---------------------------------------------------------------------------
// Container lifecycle: create → start → wait → kill → remove
// ---------------------------------------------------------------------------

/**
 * Create a sandbox container with all 8 security flags.
 * The user code file is bind-mounted read-only beneath /code.
 *
 * @param {string} hostCodePath — absolute path to the source file on the host
 * @param {string} language
 * @returns {Promise<import('dockerode').Container>}
 */
async function createContainer(hostCodePath, language) {
  const languageConfig = getLanguage(language);
  if (!languageConfig) {
    throw new TypeError(`unsupported language: ${language}`);
  }

  const container = await docker.createContainer({
    Image: languageConfig.image,
    WorkingDir: '/sandbox',
    User: '65534',
    NetworkDisabled: true,
    HostConfig: {
      Memory: 256 * 1024 * 1024,          // --memory=256m
      MemorySwap: 256 * 1024 * 1024,      // --memory-swap=256m  (disables swap)
      PidsLimit: 50,                       // --pids-limit=50
      NetworkMode: 'none',                 // --network=none
      ReadonlyRootfs: true,                // --read-only
      Tmpfs: { '/sandbox': 'size=16m,mode=1777,exec' }, // writable, executable tmpfs for compiled programs
      CapDrop: ['ALL'],                    // --cap-drop=ALL
      Binds: [`${hostCodePath}:/code/${languageConfig.fileName}:ro`],
    },
  });

  logger.debug({ containerId: container.id }, 'container created');
  return container;
}

/**
 * Run a command inside a running sandbox container and collect its output.
 * A TTY is used for run phases so language runtimes flush output incrementally.
 *
 * @param {import('dockerode').Container} container
 * @param {string[]} command
 * @param {{ tty?: boolean, onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void }} [options]
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
async function execInContainer(container, command, options = {}) {
  const useTty = options.tty ?? false;
  const exec = await container.exec({
    Cmd: command,
    AttachStdout: true,
    AttachStderr: true,
    Tty: useTty,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const chunks = [];
  let pending = Buffer.alloc(0);
  /** @type {boolean | undefined} */
  let multiplexed;

  /** @param {Buffer} data */
  function publishFrames(data) {
    pending = Buffer.concat([pending, data]);

    if (multiplexed === undefined && pending.length >= 8) {
      const declaredSize = pending.readUInt32BE(4);
      multiplexed = (pending.readUInt8(0) === 1 || pending.readUInt8(0) === 2)
        && pending.readUInt8(1) === 0
        && pending.readUInt8(2) === 0
        && pending.readUInt8(3) === 0
        && declaredSize <= 16 * 1024 * 1024;
    }

    if (multiplexed === false) {
      if (pending.length > 0 && options.onChunk) {
        options.onChunk(normalizeTtyOutput(pending.toString('utf-8')), 'stdout');
      }
      pending = Buffer.alloc(0);
      return;
    }

    while (multiplexed && pending.length >= 8) {
      const streamType = pending.readUInt8(0);
      const frameSize = pending.readUInt32BE(4);
      if (pending.length < 8 + frameSize) return;
      const payload = pending.subarray(8, 8 + frameSize);
      if (options.onChunk) {
        options.onChunk(
          normalizeTtyOutput(payload.toString('utf-8')),
          streamType === 2 ? 'stderr' : 'stdout',
        );
      }
      pending = pending.subarray(8 + frameSize);
    }
  }

  await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => {
      const buffer = Buffer.from(chunk);
      chunks.push(buffer);
      if (options.onChunk) publishFrames(buffer);
    });
    stream.once('end', resolve);
    stream.once('error', reject);
  });

  const inspection = await exec.inspect();
  const output = Buffer.concat(chunks);
  const logs = demultiplexLogs(output);
  if (useTty) logs.stdout = normalizeTtyOutput(logs.stdout);
  return { ...logs, exitCode: inspection.ExitCode ?? 1 };
}

/**
 * @param {Buffer} buffer
 * @returns {{ stdout: string, stderr: string }}
 */
function demultiplexLogs(buffer) {
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
    if (streamType === 1) stdoutChunks.push(payload);
    if (streamType === 2) stderrChunks.push(payload);
    offset += frameSize;
  }

  return { stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') };
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
  execInContainer,
  startContainer,
  waitForContainer,
  getContainerLogs,
  killContainer,
  removeContainer,
};
