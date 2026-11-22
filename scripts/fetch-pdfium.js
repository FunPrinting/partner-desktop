'use strict';

/**
 * Downloads PDFium (bblanchon/pdfium-binaries) for Windows and checks its SHA-256 before
 * extracting pdfium.dll next to the native add-on. Pinned, so builds are repeatable and a
 * tampered download is refused.
 *
 *   node scripts/fetch-pdfium.js [x64|arm64]     (default: the build machine's architecture)
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TAG = 'chromium/8165'; // PDFium 160.0.8165.0
const ARCHIVES = {
  x64: { file: 'pdfium-win-x64.tgz', sha256: 'ca7338ae7779b8b1b82f4580305c4d762d214f8df1d54b47647fe3cc75989ded' },
  arm64: { file: 'pdfium-win-arm64.tgz', sha256: 'd65e405c59cffe6fe36c0935b90d40ddf3ce75ef284f3168a28dcf00d0388131' },
};

async function main() {
  const arch = process.argv[2] || (process.arch === 'arm64' ? 'arm64' : 'x64');
  const a = ARCHIVES[arch];
  if (!a) throw new Error(`Unknown architecture "${arch}" (use x64 or arm64)`);
  const outDir = path.join(__dirname, '..', 'native', 'fp-print');
  const dll = path.join(outDir, 'pdfium.dll');
  const stamp = path.join(outDir, `pdfium.${arch}.sha256`);
  if (fs.existsSync(dll) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === a.sha256) {
    console.log(`pdfium.dll (${arch}) is up to date`);
    return;
  }
  const url = `https://github.com/bblanchon/pdfium-binaries/releases/download/${encodeURIComponent(TAG)}/${a.file}`;
  console.log(`Downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = crypto.createHash('sha256').update(buf).digest('hex');
  if (actual !== a.sha256) throw new Error(`PDFium checksum mismatch.\n  expected ${a.sha256}\n  got      ${actual}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfium-'));
  const archive = path.join(tmp, a.file);
  fs.writeFileSync(archive, buf);
  execFileSync('tar', ['-xzf', archive, '-C', tmp, 'bin/pdfium.dll', 'LICENSE']);
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(path.join(tmp, 'bin', 'pdfium.dll'), dll);
  fs.copyFileSync(path.join(tmp, 'LICENSE'), path.join(outDir, 'PDFIUM-LICENSE.txt'));
  fs.writeFileSync(stamp, `${a.sha256}\n`);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`Installed pdfium.dll (${arch})`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
