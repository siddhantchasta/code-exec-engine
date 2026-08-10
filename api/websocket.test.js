'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const { WebSocket } = require('ws');
const config = require('../lib/config');
const { attachWebSocket } = require('./websocket');

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const streamChannel = `exec:stream:${JOB_ID}`;

class FakeSubscriber extends EventEmitter {
  async subscribe(channel) {
    this.channel = channel;
  }

  async unsubscribe() {}

  disconnect() {}
}

class FakeRedis {
  constructor() {
    this.result = {};
    this.subscriber = null;
  }

  duplicate() {
    this.subscriber = new FakeSubscriber();
    return this.subscriber;
  }

  async hgetall() {
    return this.result;
  }
}

/** @param {number} milliseconds @returns {Promise<void>} */
function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** @param {FakeRedis} redis @returns {Promise<FakeSubscriber>} */
async function waitForSubscriber(redis) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (redis.subscriber?.channel === streamChannel) return redis.subscriber;
    await sleep(10);
  }
  throw new Error('websocket subscriber was not created');
}

/**
 * @param {string} url
 * @returns {Promise<{ messages: Array<Record<string, unknown>>, closeCode: number }>}
 */
function connect(url) {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url);
    /** @type {Array<Record<string, unknown>>} */
    const messages = [];
    client.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    client.once('close', (closeCode) => resolve({ messages, closeCode }));
    client.once('error', reject);
  });
}

async function run() {
  const redis = new FakeRedis();
  const server = http.createServer();
  const websocketServer = attachWebSocket(server, redis);
  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const baseUrl = `ws://127.0.0.1:${address.port}/ws?id=${JOB_ID}&apiKey=${encodeURIComponent(config.API_KEY)}`;

  try {
    const live = connect(baseUrl);
    const subscriber = await waitForSubscriber(redis);
    subscriber.emit('message', streamChannel, JSON.stringify({ type: 'output', stream: 'stdout', chunk: 'first\\n' }));
    subscriber.emit('message', streamChannel, JSON.stringify({
      type: 'done',
      result: { status: 'done', stdout: 'first\\n', stderr: '', exitCode: 0, runtimeMs: 12, timedOut: false },
    }));
    const liveResult = await live;
    assert.equal(liveResult.closeCode, 1005);
    assert.deepEqual(liveResult.messages.map((message) => message.type), ['output', 'done']);

    redis.result = {
      status: 'done', stdout: 'cached\\n', stderr: '', compileStdout: '', compileStderr: '',
      exitCode: '0', runtimeMs: '19', timedOut: 'false',
    };
    const replayResult = await connect(baseUrl);
    assert.equal(replayResult.closeCode, 1005);
    assert.equal(replayResult.messages.length, 1);
    assert.equal(replayResult.messages[0].type, 'done');
    assert.equal(replayResult.messages[0].result.stdout, 'cached\\n');

    const rejected = await connect(`ws://127.0.0.1:${address.port}/ws?id=${JOB_ID}&apiKey=wrong-key`);
    assert.equal(rejected.closeCode, 1008);
    assert.equal(rejected.messages.length, 0);

    process.stdout.write('websocket tests passed\n');
  } finally {
    await new Promise((resolve) => websocketServer.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((err) => {
  process.stderr.write(`websocket tests failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
