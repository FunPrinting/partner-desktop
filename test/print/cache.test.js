'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createCache } = require('../../src/print/cache');

const PDF = Buffer.from('%PDF-1.7\n% test file\n%%EOF\n');

async function server(handler) {
  const hits = new Map();
  const srv = http.createServer((req, res) => {
    hits.set(req.url, (hits.get(req.url) || 0) + 1);
    handler(req, res, hits.get(req.url));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { base, hits, close: () => new Promise((r) => srv.close(r)) };
}

const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'fp-cache-'));

test('downloads once; later calls and concurrent calls reuse the file', async () => {
  const s = await server((_req, res) => res.end(PDF));
  const cache = createCache({ dir: await tmpDir() });
  const [a, b] = await Promise.all([cache.get(`${s.base}/a.pdf`), cache.get(`${s.base}/a.pdf`)]);
  assert.equal(a, b);
  assert.deepEqual(await fs.readFile(a), PDF);
  await cache.get(`${s.base}/a.pdf`);
  assert.equal(s.hits.get('/a.pdf'), 1);
  await s.close();
});

test('retries server errors and dropped connections, then succeeds', async () => {
  const s = await server((req, res, n) => {
    if (n === 1) return res.writeHead(503).end();
    if (n === 2) return req.socket.destroy();
    res.end(PDF);
  });
  const cache = createCache({ dir: await tmpDir(), backoffMs: 1 });
  assert.deepEqual(await fs.readFile(await cache.get(`${s.base}/b.pdf`)), PDF);
  assert.equal(s.hits.get('/b.pdf'), 3);
  await s.close();
});

test('does not retry a missing file, and rejects files that are not PDFs', async () => {
  const s = await server((req, res) => (req.url === '/gone.pdf' ? res.writeHead(404).end() : res.end('<html>login</html>')));
  const dir = await tmpDir();
  const cache = createCache({ dir, backoffMs: 1 });
  await assert.rejects(cache.get(`${s.base}/gone.pdf`), (e) => e.status === 404 && e.retryable === false);
  assert.equal(s.hits.get('/gone.pdf'), 1);
  await assert.rejects(cache.get(`${s.base}/page.pdf`), /not a PDF/);
  // Nothing half-written is left behind
  assert.deepEqual(await fs.readdir(dir), []);
  await s.close();
});

test('refuses files over the size limit', async () => {
  const s = await server((_req, res) => res.end(Buffer.concat([PDF, Buffer.alloc(2048)])));
  const cache = createCache({ dir: await tmpDir(), maxBytes: 1024 });
  await assert.rejects(cache.get(`${s.base}/big.pdf`), /too large/);
  await s.close();
});

test('prefetch downloads all files two at a time and reports failures per file', async () => {
  let active = 0;
  let peak = 0;
  const s = await server((req, res) => {
    active++;
    peak = Math.max(peak, active);
    setTimeout(() => {
      active--;
      if (req.url === '/bad.pdf') res.writeHead(404).end();
      else res.end(PDF);
    }, 30);
  });
  const cache = createCache({ dir: await tmpDir() });
  const urls = ['/1.pdf', '/2.pdf', '/3.pdf', '/bad.pdf'].map((u) => s.base + u);
  const out = await cache.prefetch(urls, 2);
  assert.equal(peak, 2);
  assert.ok(typeof out.get(urls[0]) === 'string');
  assert.ok(out.get(urls[3]) instanceof Error);
  await s.close();
});

test('prune removes old files and keeps recent ones', async () => {
  const dir = await tmpDir();
  const cache = createCache({ dir });
  await fs.writeFile(path.join(dir, 'old.pdf'), PDF);
  await fs.writeFile(path.join(dir, 'new.pdf'), PDF);
  const old = new Date(Date.now() - 10 * 24 * 3600_000);
  await fs.utimes(path.join(dir, 'old.pdf'), old, old);
  assert.equal(await cache.prune(), 1);
  assert.deepEqual(await fs.readdir(dir), ['new.pdf']);
});
