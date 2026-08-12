'use strict';

// ---------------------------------------------------------------------------
// Benchmark Script — p50 / p95 latency by language
//
// Submits N jobs per language (Python, JavaScript, C++) and measures
// end-to-end wall-clock time from POST /submit to status='done'.
//
// Usage: PG_PORT=5435 API_KEY=test-api-key-dev-only node benchmark.js
//        PG_PORT=5435 API_KEY=test-api-key-dev-only BENCH_N=20 node benchmark.js
// ---------------------------------------------------------------------------

const http = require('http');

const API_BASE = 'http://localhost:3000';
const API_KEY = process.env.API_KEY || 'test-api-key-dev-only';
const N = parseInt(process.env.BENCH_N || '10', 10);  // runs per language

const SNIPPETS = {
  python: 'x = sum(range(1000000))\nprint(f"sum={x}")',
  javascript: 'let x = 0; for (let i = 0; i < 1_000_000; i++) x += i;\nconsole.log("sum=" + x);',
  cpp: `#include <iostream>
int main() {
  long long x = 0;
  for (int i = 0; i < 1000000; i++) x += i;
  std::cout << "sum=" << x << std::endl;
  return 0;
}`,
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

/**
 * Submit one job and wait until it reaches a terminal status.
 * Returns end-to-end wall-clock ms.
 *
 * @param {string} language
 * @returns {Promise<{ ms: number, status: string }>}
 */
async function runOne(language) {
  const start = Date.now();
  const submitRes = await request(
    'POST',
    '/submit',
    { 'x-api-key': API_KEY },
    JSON.stringify({ code: SNIPPETS[language], language }),
  );

  if (submitRes.status === 429) {
    // Rate limited — back off and retry
    await sleep(3000);
    return runOne(language);
  }
  if (submitRes.status !== 202) {
    throw new Error(`Submit failed: ${submitRes.status} ${JSON.stringify(submitRes.body)}`);
  }

  const jobId = /** @type {string} */ (submitRes.body.id);

  // Poll until terminal
  let status = 'pending';
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const r = await request('GET', `/status/${jobId}`, { 'x-api-key': API_KEY });
    status = /** @type {string} */ (r.body.status);
    if (['done', 'failed', 'timeout'].includes(status)) break;
  }

  const ms = Date.now() - start;
  return { ms, status };
}

/**
 * @param {number[]} samples sorted ascending
 * @param {number} p percentile 0–100
 */
function percentile(samples, p) {
  const idx = Math.ceil((p / 100) * samples.length) - 1;
  return samples[Math.max(0, Math.min(idx, samples.length - 1))];
}

async function main() {
  console.log(`\n=== Benchmark: ${N} runs × 3 languages ===\n`);
  console.log('Note: rate limiter max=10/60s. Adding inter-run delays to avoid 429.\n');

  /** @type {Record<string, number[]>} */
  const results = {};

  for (const language of ['python', 'javascript', 'cpp']) {
    console.log(`--- ${language} (${N} runs) ---`);
    const times = [];

    for (let i = 0; i < N; i++) {
      // Small delay between requests to stay under rate limit
      if (i > 0) await sleep(1200);
      try {
        const { ms, status } = await runOne(language);
        times.push(ms);
        console.log(`  run ${String(i + 1).padStart(2)}: ${ms}ms  [${status}]`);
      } catch (/** @type {unknown} */ err) {
        console.error(`  run ${i + 1}: ERROR`, err);
      }
    }

    times.sort((a, b) => a - b);
    results[language] = times;

    const p50 = percentile(times, 50);
    const p95 = percentile(times, 95);
    const min = times[0];
    const max = times[times.length - 1];
    const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    console.log(`  min=${min}ms  avg=${avg}ms  p50=${p50}ms  p95=${p95}ms  max=${max}ms\n`);
  }

  // Summary table
  console.log('\n=== BENCHMARK RESULTS (measured) ===\n');
  console.log('Language     | min  | avg  | p50  | p95  | max');
  console.log('-------------|------|------|------|------|------');
  for (const language of ['python', 'javascript', 'cpp']) {
    const times = results[language];
    if (!times || times.length === 0) continue;
    const p50 = percentile(times, 50);
    const p95 = percentile(times, 95);
    const min = times[0];
    const max = times[times.length - 1];
    const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    const pad = (n) => String(n).padStart(4);
    console.log(`${language.padEnd(12)} | ${pad(min)}ms | ${pad(avg)}ms | ${pad(p50)}ms | ${pad(p95)}ms | ${pad(max)}ms`);
  }
  console.log('\n(p50=median, p95=95th percentile — all wall-clock ms from POST /submit to status=done)\n');
}

main().catch((err) => {
  console.error('Benchmark crashed:', err);
  process.exit(1);
});
