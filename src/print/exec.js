'use strict';

const { execFile } = require('node:child_process');

/**
 * Runs a program without a shell (arguments are never parsed by a shell, so file names
 * and printer names can't inject commands), with a timeout, in the C locale so output
 * is the same English text on every machine.
 * Resolves { code, stdout, stderr }; rejects only when the program can't start or times out.
 */
function run(file, args, { timeoutMs = 30_000, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: 'C', LANG: 'C', ...env } },
      (err, stdout, stderr) => {
        if (err && (err.killed || err.signal)) return reject(Object.assign(new Error(`${file} timed out after ${timeoutMs} ms`), { code: 'ETIMEDOUT' }));
        if (err && typeof err.code === 'string') return reject(err); // ENOENT etc.
        resolve({ code: err ? err.code : 0, stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}

module.exports = { run };
