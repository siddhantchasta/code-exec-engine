'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const { z } = require('zod');
const config = require('../lib/config');
const logger = require('../lib/logger');
const { result, stream } = require('../lib/redis-keys');

const uuidSchema = z.string().uuid();

/**
 * Attach the live-output WebSocket endpoint to the API HTTP server.
 *
 * @param {import('node:http').Server} server
 * @param {import('ioredis').default} redis
 * @returns {WebSocketServer}
 */
function attachWebSocket(server, redis) {
  const websocketServer = new WebSocketServer({ server, path: '/ws' });

  websocketServer.on('connection', (socket, request) => {
    const requestUrl = new URL(request.url ?? '/ws', 'http://localhost');
    const jobId = requestUrl.searchParams.get('id');
    const apiKey = requestUrl.searchParams.get('apiKey');

    if (apiKey !== config.API_KEY || !jobId || !uuidSchema.safeParse(jobId).success) {
      socket.close(1008, 'Unauthorized or invalid job ID');
      return;
    }

    const subscriber = redis.duplicate();
    let closed = false;

    /** @returns {Promise<void>} */
    async function closeConnection() {
      if (closed) return;
      closed = true;
      await subscriber.unsubscribe(stream(jobId)).catch(/** @param {unknown} err */ (err) => {
        logger.error({ submissionId: jobId, err }, 'failed to unsubscribe websocket client');
      });
      subscriber.disconnect();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) socket.close();
    }

    /** @param {Record<string, string>} result */
    function sendReplay(result) {
      if (closed || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({
        type: 'done',
        result: {
          status: result.status,
          stdout: result.stdout,
          stderr: result.stderr,
          compileStdout: result.compileStdout,
          compileStderr: result.compileStderr,
          exitCode: Number(result.exitCode),
          runtimeMs: Number(result.runtimeMs),
          timedOut: result.timedOut === 'true',
        },
      }));
      closeConnection().catch(/** @param {unknown} err */ (err) => {
        logger.error({ submissionId: jobId, err }, 'failed to close replay websocket');
      });
    }

    subscriber.on('message', (channel, message) => {
      if (closed || channel !== stream(jobId) || socket.readyState !== WebSocket.OPEN) return;
      socket.send(message);
      try {
        if (JSON.parse(message).type === 'done') {
          closeConnection().catch(/** @param {unknown} err */ (err) => {
            logger.error({ submissionId: jobId, err }, 'failed to close completed websocket');
          });
        }
      } catch {
        logger.warn({ submissionId: jobId }, 'invalid stream message received');
      }
    });

    socket.once('close', () => {
      closeConnection().catch(/** @param {unknown} err */ (err) => {
        logger.error({ submissionId: jobId, err }, 'failed to clean up websocket client');
      });
    });

    (async () => {
      try {
        await subscriber.subscribe(stream(jobId));
        const cachedResult = await redis.hgetall(result(jobId));
        if (Object.keys(cachedResult).length > 0) sendReplay(cachedResult);
      } catch (/** @type {unknown} */ err) {
        logger.error({ submissionId: jobId, err }, 'websocket subscription failed');
        closeConnection().catch(() => undefined);
      }
    })();
  });

  return websocketServer;
}

module.exports = { attachWebSocket };
