'use strict';

// ---------------------------------------------------------------------------
// Graceful Shutdown Gate Test
//
// Submits a 6-second sleep job (longer than execution timeout? No — we need
// it to run but be killable cleanly). We submit a 4-second Python sleep,
// then immediately SIGTERM the worker, and verify:
//   1. Worker does NOT exit immediately — it waits for the active job
//   2. Job completes with status 'done' (not 'failed' or 'pending')
//   3. Worker exits 0 after the job finishes (within SHUTDOWN_TIMEOUT_MS)
//
// Usage: PG_PORT=5435 API_KEY=test-api-key-dev-only node test-graceful-shutdown.js
// ---------------------------------------------------------------------------

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const config = require('./lib/config');
const redis = require('./lib/redis');

const API_BASE = 'http://localhost:3000';
const API_KEY = process.env.API_KEY || config.API_KEY || 'test-api-key-dev-only';
const ROOT = path.join(__dirname);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string} method
 * @param {string} urlPath
 * @param {Record<string, string>} [headers]
 * @param {string} [body]
 * @returns {Promise<{ status: number, body: Record<string, unknown> }>}
 */
function request(method, urlPath, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, API_BASE);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: { ...headers },
    };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode || 0, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode || 0, body: { raw: data } }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  console.log('\n=== Graceful Shutdown Gate Test ===\n');

  // Step 1: Start a dedicated worker process we can signal
  console.log('1. Starting dedicated worker process...');
  const worker = spawn('node', ['worker/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PG_PORT: String(config.PG_PORT),
      WORKER_ID: 'worker-shutdown-test',
      SHUTDOWN_TIMEOUT_MS: '30000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const workerLogs = [];
  worker.stdout.on('data', (d) => {
    const line = d.toString().trim();
    workerLogs.push(line);
    console.log('  [worker]', line);
  });
  worker.stderr.on('data', (d) => {
    console.log('  [worker stderr]', d.toString().trim());
  });

  // Wait for worker to connect
  await sleep(1500);

  // Step 2: Submit a 4-second sleep job
  const sleepCode = 'import time\nfor i in range(4):\n    print(f"tick {i}")\n    time.sleep(1)\nprint("done sleeping")\n';
  console.log('\n2. Submitting 4-second sleep job...');
  const submitRes = await request(
    'POST',
    '/submit',
    { 'x-api-key': API_KEY },
    JSON.stringify({ code: sleepCode, language: 'python' }),
  );

  if (submitRes.status !== 202) {
    console.error(`❌ Submit failed: ${submitRes.status}`, submitRes.body);
    worker.kill('SIGKILL');
    await redis.quit();
    process.exit(1);
  }

  const jobId = /** @type {string} */ (submitRes.body.id);
  console.log(`   Job submitted: id=${jobId}`);

  // Step 3: Wait until worker has claimed the job in exec:processing
  console.log('\n3. Waiting for worker-shutdown-test to claim and start the job...');
  let claimed = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const proc = await redis.hget('exec:processing', jobId);
    if (proc && proc.includes('worker-shutdown-test')) {
      claimed = true;
      console.log(`   Job claimed by worker-shutdown-test after ${(i + 1) * 250}ms`);
      break;
    }
  }

  if (!claimed) {
    console.error('❌ FAIL: Job was not claimed by worker-shutdown-test within 10s');
    worker.kill('SIGKILL');
    await redis.quit();
    process.exit(1);
  }

  // Step 4: Send SIGTERM mid-execution
  const sigtermAt = Date.now();
  console.log('\n4. Sending SIGTERM to worker...');
  worker.kill('SIGTERM');

  // Step 5: Wait for worker process to exit
  console.log('5. Waiting for worker to exit (should wait for active job)...');
  const exitCode = await new Promise((resolve) => {
    worker.once('exit', (code) => {
      resolve(code);
    });
    // Safety timeout — if worker hasn't exited after 35s, kill it
    setTimeout(() => {
      console.error('   Safety timeout: worker did not exit in 35s, killing');
      worker.kill('SIGKILL');
      resolve(-1);
    }, 35000);
  });

  const elapsed = Date.now() - sigtermAt;
  console.log(`\n   Worker exited with code ${exitCode} after ${elapsed}ms`);

  if (exitCode !== 0) {
    console.error(`❌ FAIL: worker exited with non-zero code ${exitCode}`);
    process.exit(1);
  }
  if (elapsed < 2000) {
    console.error(`❌ FAIL: worker exited too fast (${elapsed}ms) — it did not wait for the in-flight job`);
    process.exit(1);
  }
  console.log('✅ Worker waited for active job before exiting cleanly');

  // Step 6: Poll for job status — it must be 'done', not 'failed' or 'pending'
  console.log('\n6. Polling for job result...');
  let finalStatus = '';
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const statusRes = await request('GET', `/status/${jobId}`, { 'x-api-key': API_KEY });
    finalStatus = /** @type {string} */ (statusRes.body.status);
    console.log(`   poll ${i + 1}: status=${finalStatus}`);
    if (['done', 'failed', 'timeout'].includes(finalStatus)) break;
  }

  if (finalStatus !== 'done') {
    console.error(`❌ FAIL: job status is '${finalStatus}', expected 'done'`);
    process.exit(1);
  }

  console.log(`\n✅ GRACEFUL SHUTDOWN GATE PASSED`);
  console.log(`   Worker received SIGTERM, drained active job (${elapsed}ms), exited 0`);
  console.log(`   Job completed with status: done\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Test crashed:', err);
  process.exit(1);
});
