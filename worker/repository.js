'use strict';

const db = require('../lib/db');

// ---------------------------------------------------------------------------
// All SQL lives here. Parameterised queries only ($1, $2, …).
// ---------------------------------------------------------------------------

/**
 * Create a new submission row (status defaults to 'pending' in schema).
 *
 * @param {string} id    — UUID
 * @param {string} language
 * @param {string} userIp
 * @returns {Promise<void>}
 */
async function createSubmission(id, language, userIp) {
  await db.query(
    `INSERT INTO submissions (id, status, language, user_ip)
     VALUES ($1, 'pending', $2, $3)`,
    [id, language, userIp],
  );
}

/**
 * Update the status of an existing submission.
 *
 * @param {string} id
 * @param {string} status — running | done | failed | timeout
 * @returns {Promise<void>}
 */
async function updateSubmissionStatus(id, status) {
  await db.query(
    `UPDATE submissions SET status = $1 WHERE id = $2`,
    [status, id],
  );
}

/**
 * Insert the execution result for a submission.
 *
 * @param {string} submissionId
 * @param {{ stdout: string, stderr: string, compileStdout: string, compileStderr: string, exitCode: number, runtimeMs: number, timedOut: boolean }} result
 * @returns {Promise<void>}
 */
async function insertResult(submissionId, result) {
  await db.query(
    `INSERT INTO execution_results
       (submission_id, stdout, stderr, compile_stdout, compile_stderr, exit_code, runtime_ms, timed_out)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      submissionId,
      result.stdout,
      result.stderr,
      result.compileStdout,
      result.compileStderr,
      result.exitCode,
      result.runtimeMs,
      result.timedOut,
    ],
  );
}

/**
 * Retrieve the execution result for a submission.
 *
 * @param {string} submissionId
 * @returns {Promise<{ submission_id: string, stdout: string, stderr: string, exit_code: number, runtime_ms: number, timed_out: boolean, created_at: string } | null>}
 */
async function getResult(submissionId) {
  const { rows } = await db.query(
    `SELECT * FROM execution_results WHERE submission_id = $1`,
    [submissionId],
  );
  return rows[0] ?? null;
}

module.exports = { createSubmission, updateSubmissionStatus, insertResult, getResult };
