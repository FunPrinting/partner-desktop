'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

/**
 * Local cache of print-ready PDFs. A job's files are downloaded as soon as it is claimed,
 * two at a time, so the printer never waits for the network. A retry reuses the file.
 *
 * Files are keyed by the SHA-256 of their URL (stored files never change at a URL), written
 * to a temp file and renamed only once complete and checked to be a PDF, so a crash or a
 * dropped connection never leaves a half file that looks valid.
 */
const MAX_BYTES = 200 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
const ATTEMPTS = 3;

class DownloadError extends Error {
  constructor(message, { retryable = true, status } = {}) {
    super(message);
    this.name = 'DownloadError';
    this.retryable = retryable;
    this.status = status;
  }
}

function keyFor(url) {
  return crypto.createHash('sha256').update(String(url)).digest('hex');
}

async function isPdf(file) {
  const fh = await fsp.open(file, 'r').catch(() => null);
  if (!fh) return false;
  try {
    const buf = Buffer.alloc(5);
    const { bytesRead } = await fh.read(buf, 0, 5, 0);
    return bytesRead === 5 && buf.toString('latin1') === '%PDF-';
  } finally {
    await fh.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createCache({ dir, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, attempts = ATTEMPTS, maxBytes = MAX_BYTES, backoffMs = 1000 } = {}) {
  if (!dir) throw new TypeError('cache dir is required');
  const inflight = new Map(); // url -> Promise<path>

  const pathFor = (url) => path.join(dir, `${keyFor(url)}.pdf`);

  async function downloadOnce(url, dest) {
    const tmp = `${dest}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.part`;
    let res;
    try {
      res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new DownloadError(`Could not reach the file server: ${err.message}`);
    }
    if (!res.ok) {
      // 404/403: the file is gone or the link is wrong; retrying won't help
      throw new DownloadError(`File download failed (HTTP ${res.status})`, { retryable: res.status >= 500 || res.status === 429, status: res.status });
    }
    const declared = Number(res.headers.get('content-length'));
    if (declared > maxBytes) throw new DownloadError('The file is too large', { retryable: false });
    let size = 0;
    const limit = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        cb(size > maxBytes ? new DownloadError('The file is too large', { retryable: false }) : null, chunk);
      },
    });
    try {
      await fsp.mkdir(dir, { recursive: true });
      await pipeline(Readable.fromWeb(res.body), limit, fs.createWriteStream(tmp));
      if (!(await isPdf(tmp))) throw new DownloadError('The downloaded file is not a PDF', { retryable: false });
      await fsp.rename(tmp, dest);
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err instanceof DownloadError ? err : new DownloadError(`Download interrupted: ${err.message}`);
    }
  }

  async function fetchFile(url) {
    const dest = pathFor(url);
    if (await isPdf(dest)) {
      // Keep recently used files from being pruned
      const now = new Date();
      await fsp.utimes(dest, now, now).catch(() => undefined);
      return dest;
    }
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        await downloadOnce(url, dest);
        return dest;
      } catch (err) {
        lastErr = err;
        if (!err.retryable) break;
        if (i < attempts - 1) await sleep(backoffMs * 4 ** i);
      }
    }
    throw lastErr;
  }

  /** The cached path for a URL, downloading it if needed. Concurrent calls share one download. */
  function get(url) {
    if (!inflight.has(url)) {
      inflight.set(
        url,
        fetchFile(url).finally(() => inflight.delete(url))
      );
    }
    return inflight.get(url);
  }

  /** Downloads all URLs, `concurrency` at a time. Resolves to { url: path | Error }. */
  async function prefetch(urls, concurrency = 2) {
    const results = new Map();
    const queue = [...new Set(urls.filter(Boolean))];
    async function worker() {
      while (queue.length) {
        const url = queue.shift();
        try {
          results.set(url, await get(url));
        } catch (err) {
          results.set(url, err);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    return results;
  }

  /** Deletes files not used for `maxAgeMs` (and stale partial downloads). */
  async function prune(maxAgeMs = 3 * 24 * 3600_000) {
    const names = await fsp.readdir(dir).catch(() => []);
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const name of names) {
      const file = path.join(dir, name);
      const st = await fsp.stat(file).catch(() => null);
      if (!st || !st.isFile()) continue;
      const stalePart = name.endsWith('.part') && st.mtimeMs < Date.now() - 3600_000;
      if (stalePart || st.mtimeMs < cutoff) {
        await fsp.rm(file, { force: true });
        removed++;
      }
    }
    return removed;
  }

  return { get, prefetch, prune, pathFor };
}

module.exports = { createCache, DownloadError, keyFor };
