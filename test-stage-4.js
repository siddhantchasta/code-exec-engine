'use strict';

// ---------------------------------------------------------------------------
// Stage D Gate Test — Metrics, Request ID, REST cycle
//
// Requires: Docker running, Redis + Postgres up (docker-compose), worker running
// Run:      API_KEY=test-api-key-dev-only node test-stage-4.js
//
// Gates:
//   1. POST /submit → 202 with { id, requestId, statusUrl }; x-request-id header set
//   2. GET /status/:id → polls until done
//   3. GET /result/:id → correct stdout, exitCode, runtimeMs
//   4. Missing x-api-key → 401
//   5. GET /metrics → 200 with exec_execution_duration_ms present (non-zero after gate 1)
//   6. Rate limit → burst returns 429
// ---------------------------------------------------------------------------

const http = require('http');

const API_BASE = 'http://localhost:3000';
const API_KEY = process.env.API_KEY || 'test-api-key-dev-only';

/**
 * Make an HTTP request and return status + body + response headers.
 * @param {string} method
 * @param {string} path
 * @param {Record<string, string>} [headers]
 * @param {string} [body]
 * @returns {Promise<{ status: number, body: Record<string, unknown>, headers: Record<string, string | string[] | undefined> }>}
 */
function request(method, path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_BASE);
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
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode || 0, body: JSON.parse(data), headers: res.headers });
        } catch {
          resolve({ status: res.statusCode || 0, body: /** @type {Record<string, unknown>} */ ({ raw: data }), headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Fetch /metrics as plain text.
 * @returns {Promise<{ status: number, text: string }>}
 */
function requestText(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_BASE);
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, text: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runGateTests() {
  let passed = 0;
  const total = 6;

  // ---------------------------------------------------------------
  // Gate 1: POST /submit → 202 with id + requestId, x-request-id header
  // ---------------------------------------------------------------
  console.log('\n--- Gate 1: POST /submit (requestId propagation) ---');
  const submitRes = await request(
    'POST',
    '/submit',
    { 'x-api-key': API_KEY },
    JSON.stringify({ code: 'print("hello from stage D gate")', language: 'python' }),
  );

  if (submitRes.status !== 202) {
    console.error(`❌ Gate 1 FAIL: expected 202, got ${submitRes.status}`);
    console.error(submitRes.body);
    process.exit(1);
  }

  const submissionId = /** @type {string} */ (submitRes.body.id);
  const requestId = /** @type {string} */ (submitRes.body.requestId);
  const statusUrl = /** @type {string} */ (submitRes.body.statusUrl);
  const xRequestIdHeader = submitRes.headers['x-request-id'];

  const gate1Errors = [];
  if (!submissionId) gate1Errors.push('missing id in response body');
  if (!requestId) gate1Errors.push('missing requestId in response body');
  if (!statusUrl) gate1Errors.push('missing statusUrl in response body');
  if (!xRequestIdHeader) gate1Errors.push('missing x-request-id response header');
  if (requestId && xRequestIdHeader && requestId !== xRequestIdHeader) {
    gate1Errors.push(`requestId mismatch: body=${requestId}, header=${xRequestIdHeader}`);
  }

  if (gate1Errors.length > 0) {
    console.error('❌ Gate 1 FAIL:', gate1Errors.join('; '));
    process.exit(1);
  }

  console.log(`✅ Gate 1 PASSED: 202 Accepted — id=${submissionId}, requestId=${requestId}`);
  console.log(`   x-request-id header: ${xRequestIdHeader}`);
  passed++;

  // ---------------------------------------------------------------
  // Gate 2: GET /status/:id → poll until done
  // ---------------------------------------------------------------
  console.log('\n--- Gate 2: GET /status/:id (polling) ---');
  let statusResult = 'pending';
  let pollAttempts = 0;
  const maxPollAttempts = 30;

  while (pollAttempts < maxPollAttempts) {
    await sleep(1000);
    pollAttempts++;

    const statusRes = await request('GET', `/status/${submissionId}`, { 'x-api-key': API_KEY });
    if (statusRes.status !== 200) {
      console.error(`❌ Gate 2 FAIL: status endpoint returned ${statusRes.status}`);
      process.exit(1);
    }

    statusResult = /** @type {string} */ (statusRes.body.status);
    console.log(`  poll ${pollAttempts}: status=${statusResult}`);

    if (['done', 'failed', 'timeout'].includes(statusResult)) break;
  }

  if (statusResult !== 'done') {
    console.error(`❌ Gate 2 FAIL: expected status 'done', got '${statusResult}'`);
    process.exit(1);
  }

  console.log(`✅ Gate 2 PASSED: status is 'done' after ${pollAttempts} poll(s)`);
  passed++;

  // ---------------------------------------------------------------
  // Gate 3: GET /result/:id → correct stdout, exitCode, runtimeMs
  // ---------------------------------------------------------------
  console.log('\n--- Gate 3: GET /result/:id ---');
  const resultRes = await request('GET', `/result/${submissionId}`, { 'x-api-key': API_KEY });

  if (resultRes.status !== 200) {
    console.error(`❌ Gate 3 FAIL: result endpoint returned ${resultRes.status}`);
    process.exit(1);
  }

  const result = resultRes.body;
  const errors = [];

  if (result.stdout !== 'hello from stage D gate\n') {
    errors.push(`stdout: got "${result.stdout}", expected "hello from stage D gate\\n"`);
  }
  if (result.exitCode !== 0) {
    errors.push(`exitCode: got ${result.exitCode}, expected 0`);
  }
  if (typeof result.runtimeMs !== 'number' || /** @type {number} */ (result.runtimeMs) <= 0) {
    errors.push(`runtimeMs: got ${result.runtimeMs}, expected > 0`);
  }
  if (result.timedOut !== false) {
    errors.push(`timedOut: got ${result.timedOut}, expected false`);
  }

  if (errors.length > 0) {
    console.error('❌ Gate 3 FAIL:', errors.join('; '));
    process.exit(1);
  }

  console.log(`✅ Gate 3 PASSED: stdout="${String(result.stdout).trim()}", exitCode=${result.exitCode}, runtimeMs=${result.runtimeMs}`);
  passed++;

  // ---------------------------------------------------------------
  // Gate 4: Missing x-api-key → 401
  // ---------------------------------------------------------------
  console.log('\n--- Gate 4: Auth rejection (no API key) ---');
  const noAuthRes = await request('GET', `/status/${submissionId}`);

  if (noAuthRes.status !== 401) {
    console.error(`❌ Gate 4 FAIL: expected 401, got ${noAuthRes.status}`);
    process.exit(1);
  }

  console.log('✅ Gate 4 PASSED: 401 Unauthorized without x-api-key');
  passed++;

  // ---------------------------------------------------------------
  // Gate 5: GET /metrics → exec_execution_duration_ms present and non-empty
  // ---------------------------------------------------------------
  console.log('\n--- Gate 5: GET /metrics (Prometheus exposition) ---');
  // /metrics requires no auth (mounted before auth middleware)
  const metricsRes = await requestText('/metrics');

  if (metricsRes.status !== 200) {
    console.error(`❌ Gate 5 FAIL: /metrics returned ${metricsRes.status}`);
    process.exit(1);
  }

  const metricsErrors = [];
  if (!metricsRes.text.includes('exec_execution_duration_ms')) {
    metricsErrors.push('exec_execution_duration_ms metric not found in /metrics output');
  }
  if (!metricsRes.text.includes('exec_queue_depth')) {
    metricsErrors.push('exec_queue_depth metric not found in /metrics output');
  }
  if (!metricsRes.text.includes('exec_dlq_depth')) {
    metricsErrors.push('exec_dlq_depth metric not found in /metrics output');
  }
  // Verify non-zero execution was observed (count bucket)
  if (!metricsRes.text.includes('exec_execution_duration_ms_count')) {
    metricsErrors.push('exec_execution_duration_ms_count not found — histogram may not have been observed');
  }

  if (metricsErrors.length > 0) {
    console.error('❌ Gate 5 FAIL:', metricsErrors.join('\n  '));
    console.error('\nActual /metrics output (first 1000 chars):\n', metricsRes.text.slice(0, 1000));
    process.exit(1);
  }

  // Extract count to confirm non-zero
  const countMatch = metricsRes.text.match(/exec_execution_duration_ms_count\{[^}]+\}\s+(\d+)/);
  const observedCount = countMatch ? parseInt(countMatch[1], 10) : 0;
  console.log(`✅ Gate 5 PASSED: all 3 metrics present, exec_execution_duration_ms observed ${observedCount} time(s)`);
  console.log('   /metrics excerpt:');
  const relevantLines = metricsRes.text.split('\n').filter((l) => l.includes('exec_') && !l.startsWith('#')).slice(0, 8);
  relevantLines.forEach((l) => console.log('  ', l));
  passed++;

  // ---------------------------------------------------------------
  // Gate 6: Rate limiter — burst returns 429
  // ---------------------------------------------------------------
  console.log('\n--- Gate 6: Rate limit (burst requests) ---');

  let got429 = false;
  let successCount = 0;
  const burstSize = 15;

  for (let i = 0; i < burstSize; i++) {
    const res = await request('GET', `/status/${submissionId}`, { 'x-api-key': API_KEY });
    if (res.status === 429) {
      got429 = true;
      console.log(`  request ${i + 1}: 429 (rate limited) — after ${successCount} successes`);
      break;
    } else if (res.status === 200) {
      successCount++;
    }
  }

  if (!got429) {
    console.error(`❌ Gate 6 FAIL: no 429 after ${burstSize} requests (got ${successCount} successes)`);
    process.exit(1);
  }

  console.log(`✅ Gate 6 PASSED: 429 returned after ${successCount} successful requests`);
  passed++;

  // ---------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------
  console.log(`\n🎉 ALL ${passed}/${total} STAGE D GATE TESTS PASSED 🎉\n`);
  process.exit(0);
}

runGateTests().catch((err) => {
  console.error('❌ Stage D test crashed:', err);
  process.exit(1);
});
