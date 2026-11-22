'use strict';
/**
 * CI: runs the packaged app (electron-builder --dir output) with --self-test and fails
 * unless it lists printers and, on Windows, loads PDFium. Catches packaging mistakes
 * (files left inside app.asar, missing DLLs) that tests on the source cannot see.
 *
 *   node scripts/check-packaged.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dist = path.join(__dirname, '..', 'dist');
const exe = {
  win32: () => path.join(dist, 'win-unpacked', 'FunPrinting Partner.exe'),
  darwin: () => {
    const dir = fs.readdirSync(dist).find((d) => d.startsWith('mac'));
    return path.join(dist, dir, 'FunPrinting Partner.app', 'Contents', 'MacOS', 'FunPrinting Partner');
  },
  linux: () => {
    const dir = path.join(dist, 'linux-unpacked');
    const bin = fs.readdirSync(dir).find((f) => !f.includes('.') && fs.statSync(path.join(dir, f)).isFile() && fs.statSync(path.join(dir, f)).mode & 0o111 && !/chrome|crashpad/.test(f));
    return path.join(dir, bin);
  },
}[process.platform]();

const out = path.join(os.tmpdir(), `fp-self-test-${Date.now()}.json`);
const args = ['--self-test', `--self-test-out=${out}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])];
console.log(`running ${exe} ${args.join(' ')}`);
const r = spawnSync(exe, args, { encoding: 'utf8', timeout: 90_000 });
if (r.error) throw r.error;
let report;
try {
  report = JSON.parse(fs.readFileSync(out, 'utf8'));
} catch {
  console.log('stdout:', r.stdout, '\nstderr:', r.stderr);
  throw new Error(`The packaged app wrote no report (exit ${r.status})`);
}
console.log(JSON.stringify(report, null, 2));
const problems = [];
if (!report.ok) problems.push(`self-test failed: ${report.error}`);
if (!report.packaged) problems.push('the app did not run packaged');
if (process.platform === 'win32') {
  if (!report.printers?.length) problems.push('no printers listed (every Windows PC has "Microsoft Print to PDF")');
  if (!report.printing?.pdfium) problems.push('PDFium did not load');
}
if (problems.length) {
  console.error(`Packaged app check FAILED:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('Packaged app check passed');
