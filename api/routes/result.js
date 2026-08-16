'use strict';

const { z } = require('zod');
const repository = require('../../worker/repository');

// ---------------------------------------------------------------------------
// GET /result/:id — full execution result from PostgreSQL
// ---------------------------------------------------------------------------

const uuidSchema = z.string().uuid();

/**
 * @param {import('express').Router} router
 * @returns {void}
 */
function mount(router) {
  router.get('/result/:id', async (req, res) => {
    const parsed = uuidSchema.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid submission ID' });
      return;
    }

    const id = parsed.data;
    const row = await repository.getResult(id);

    if (!row) {
      res.status(404).json({ error: 'Result not found' });
      return;
    }

    res.status(200).json({
      submissionId: row.submission_id,
      status: row.status,
      stdout: row.stdout,
      stderr: row.stderr,
      compileStdout: row.compile_stdout,
      compileStderr: row.compile_stderr,
      exitCode: row.exit_code,
      runtimeMs: row.runtime_ms,
      timedOut: row.timed_out,
    });
  });
}

module.exports = { mount };
