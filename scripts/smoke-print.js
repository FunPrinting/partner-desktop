'use strict';

/**
 * Windows smoke test (CI): prints a generated PDF through the real engine to a virtual
 * "Microsoft Print to PDF" printer that writes to a file, then checks the result's page
 * count and paper size. Exits non-zero on any failure.
 *
 *   node scripts/smoke-print.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PDFDocument } = require('pdf-lib');
const { createWindowsEngine } = require('../src/print/engines/windowsEngine');
const { buildRequest } = require('../src/print/request');
const { sendRequest } = require('../src/print/sendRequest');

const ps = (script) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });

async function main() {
  if (process.platform !== 'win32') throw new Error('This smoke test runs on Windows only');
  // A plain path: the temp folder's 8.3 short name (RUNNER~1) stops the PDF printer writing there
  const dir = path.join(process.env.SystemDrive ? `${process.env.SystemDrive}\\` : 'C:\\', `fpsmoke${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'printed.pdf');
  const name = 'FP Smoke PDF';

  // A printer that saves to a file instead of asking for a name
  ps(`Add-PrinterPort -Name '${out}' -ErrorAction SilentlyContinue; Add-Printer -Name '${name}' -DriverName 'Microsoft Print To PDF' -PortName '${out}'`);

  const doc = await PDFDocument.create();
  for (let i = 0; i < 4; i++) doc.addPage([595.28, 841.89]).drawText(`Page ${i + 1}`, { x: 60, y: 760, size: 32 });
  const src = path.join(dir, 'in.pdf');
  fs.writeFileSync(src, await doc.save());

  const engine = createWindowsEngine();
  const list = await engine.listPrinters();
  if (!list.some((p) => p.name === name)) throw new Error(`The test printer is not listed: ${list.map((p) => p.name).join(', ')}`);
  console.log('capabilities:', JSON.stringify(await engine.capabilities(name)));

  const request = buildRequest({ pageSize: 'A4', color: 'color', sided: 'single', copies: 1, pages: 4 });
  const started = Date.now();
  const sent = await sendRequest(engine, { printer: name, sourcePath: src, request, title: 'Smoke test' });
  console.log(`spooled ${sent.length} job(s) in ${Date.now() - started} ms`);

  // Wait for the spooler to finish
  for (let i = 0; i < 60; i++) {
    const states = await Promise.all(sent.map((s) => engine.jobStatus(name, s.jobRef)));
    if (states.every((s) => s.state === 'completed')) break;
    if (states.some((s) => s.state === 'failed')) throw new Error(`Job failed: ${JSON.stringify(states)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  for (let i = 0; i < 40 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 250));
  if (!fs.existsSync(out)) {
    const dump = (label, script) => {
      try {
        console.log(`--- ${label}\n${ps(script).trim()}`);
      } catch (e) {
        console.log(`--- ${label} failed: ${e.message}`);
      }
    };
    console.log('--- files in', dir, fs.readdirSync(dir));
    dump('printer', `Get-Printer -Name '${name}' | Format-List Name,DriverName,PortName,PrinterStatus`);
    dump('port', `Get-PrinterPort -Name '${out}' | Format-List *`);
    dump('jobs', `Get-PrintJob -PrinterName '${name}' | Format-List *`);
    dump('events', `Get-WinEvent -LogName 'Microsoft-Windows-PrintService/Operational' -MaxEvents 15 -ErrorAction SilentlyContinue | Format-List TimeCreated,Id,Message`);
    // Control: does this printer work at all on this machine? (plain text through Windows itself)
    dump('clear stuck jobs', `Get-PrintJob -PrinterName '${name}' | Remove-PrintJob -ErrorAction SilentlyContinue; 'cleared'`);
    dump('control Out-Printer', `'control page' | Out-Printer -Name '${name}'; Start-Sleep -Seconds 8; if (Test-Path '${out}') { 'CONTROL WROTE FILE: ' + (Get-Item '${out}').Length } else { 'CONTROL WROTE NO FILE' }; Get-Printer -Name '${name}' | Format-List PrinterStatus`);
    throw new Error('The printer wrote no file');
  }

  const result = await PDFDocument.load(fs.readFileSync(out));
  const page = result.getPage(0);
  const dims = [Math.round(page.getWidth()), Math.round(page.getHeight())];
  console.log(`result: ${result.getPageCount()} pages, ${dims.join(' x ')} pt, ${Date.now() - started} ms in total`);
  if (result.getPageCount() !== 4) throw new Error(`Expected 4 pages, got ${result.getPageCount()}`);
  if (Math.abs(dims[0] - 595) > 3 || Math.abs(dims[1] - 842) > 3) throw new Error(`Expected A4 (595 x 842), got ${dims.join(' x ')}`);

  ps(`Remove-Printer -Name '${name}'; Remove-PrinterPort -Name '${out}' -ErrorAction SilentlyContinue`);
  console.log('Smoke test passed');
}

main().catch((err) => {
  console.error('Smoke test FAILED:', err.stack || err.message);
  process.exit(1);
});
