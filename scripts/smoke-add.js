'use strict';

/**
 * Windows smoke test (CI): starts a fake IPP printer, sets it up through the engine's
 * addPrinter() (the same call the app's Add button makes), checks that Windows lists it
 * and reads its properties, prints a PDF to it, and checks that the printer received a job.
 *
 *   node scripts/smoke-add.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PDFDocument } = require('pdf-lib');
const { createFakeIppPrinter } = require('../test/fixtures/fakeIppPrinter');
const { createWindowsEngine } = require('../src/print/engines/windowsEngine');
const { buildRequest } = require('../src/print/request');
const { sendRequest } = require('../src/print/sendRequest');
const { trackRuns } = require('../src/print/tracker');

const ps = (script) => {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60_000 }).trim();
  } catch (e) {
    return `(failed: ${String(e.message).split('\n')[0]})`;
  }
};

const lanAddress = () => {
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  return null;
};

async function main() {
  if (process.platform !== 'win32') throw new Error('This smoke test runs on Windows only');
  const fake = createFakeIppPrinter({ name: 'FP Smoke IPP', color: true, duplex: true, media: ['iso_a4_210x297mm', 'iso_a3_297x420mm'] });
  const { port } = await fake.start();
  console.log(`fake IPP printer listening on port ${port}`);

  const addresses = [lanAddress(), '127.0.0.1'].filter(Boolean);
  const device = { name: 'FP Smoke IPP', serviceName: 'FP Smoke IPP', make: 'FunPrinting', model: 'Fake IPP', host: undefined, addresses, protocols: { ipp: { port, rp: 'ipp/print' } }, announced: {}, preferred: 'ipp' };

  const engine = createWindowsEngine();
  console.log('addresses:', addresses.join(', '));
  console.log('spooler:', ps('(Get-Service Spooler).Status'));
  let added;
  try {
    added = await engine.addPrinter(device);
  } catch (err) {
    console.log('addPrinter failed:', err.code, err.message);
    console.log('--- printers\n' + ps('Get-Printer | Format-List Name,DriverName,PortName,PrinterStatus'));
    console.log('--- drivers\n' + ps('Get-PrinterDriver | Select-Object -ExpandProperty Name'));
    throw err;
  }
  console.log('added:', JSON.stringify(added));

  const list = await engine.listPrinters();
  const mine = list.find((p) => p.name === added.name);
  if (!mine) throw new Error(`Windows does not list the new printer. Listed: ${list.map((p) => p.name).join(', ')}`);
  console.log(`listed: port=${mine.uri} driver=${mine.driver} online=${mine.status.online}`);
  const caps = await engine.capabilities(added.name);
  console.log('capabilities:', JSON.stringify(caps));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-smoke-add-'));
  const doc = await PDFDocument.create();
  for (let i = 0; i < 2; i++) doc.addPage([595.28, 841.89]).drawText(`Page ${i + 1}`, { x: 60, y: 760, size: 32 });
  const src = path.join(dir, 'in.pdf');
  fs.writeFileSync(src, await doc.save());
  const request = buildRequest({ pageSize: 'A4', color: 'bw', sided: 'single', copies: 1, pages: 2 });
  const started = Date.now();
  const sent = await sendRequest(engine, { printer: added.name, sourcePath: src, request, title: 'Smoke add' });
  console.log(`spooled in ${Date.now() - started} ms`);
  await trackRuns(engine, added.name, sent, { timeoutMs: 90_000, onUpdate: (u) => console.log('  state:', u.state, u.reason || '') });
  for (let i = 0; i < 40 && !fake.jobs.length; i++) await new Promise((r) => setTimeout(r, 500));
  if (!fake.jobs.length) {
    console.log('--- jobs\n' + ps(`Get-PrintJob -PrinterName '${added.name}' | Format-List *`));
    throw new Error('The printer never received a job');
  }
  const j = fake.jobs[0];
  console.log(`printer received job: ${j.bytes} bytes, format ${j.format}`);
  if (j.bytes < 500) throw new Error(`The job is too small (${j.bytes} bytes)`);

  // Remove, the same call as the Settings button (elevated script, remove mode)
  await engine.removePrinter(added.name);
  if ((await engine.listPrinters()).some((p) => p.name === added.name)) throw new Error('Remove did not delete the printer');
  console.log('removed: the printer is gone from Windows');

  // Search: a fake printer that only answers mDNS questions straight back (like a printer
  // behind Windows Firewall, which drops ordinary multicast answers)
  const dgram = require('node:dgram');
  const packet = require('dns-packet');
  const responder = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  await new Promise((r) => responder.bind(5353, r));
  for (const a of addresses) {
    try {
      responder.addMembership('224.0.0.251', a);
    } catch {
      // loopback cannot join
    }
  }
  responder.on('message', (msg, rinfo) => {
    let q;
    try {
      q = packet.decode(msg);
    } catch {
      return;
    }
    if (q.type !== 'query' || rinfo.port === 5353) return;
    const answers = [];
    for (const question of q.questions) {
      if (question.type === 'PTR' && question.name === '_ipp._tcp.local') {
        answers.push({ name: '_ipp._tcp.local', type: 'PTR', data: 'FP Fake mDNS._ipp._tcp.local' });
        answers.push({ name: 'FP Fake mDNS._ipp._tcp.local', type: 'SRV', data: { target: 'fpfake.local', port } });
        answers.push({ name: 'FP Fake mDNS._ipp._tcp.local', type: 'TXT', data: ['ty=FP Fake mDNS', 'rp=ipp/print', 'UUID=fake-mdns-1', 'Color=T'] });
        answers.push({ name: 'fpfake.local', type: 'A', data: addresses[0] });
      }
    }
    if (answers.length) {
      const out = packet.encode({ type: 'response', id: q.id, answers });
      responder.send(out, 0, out.length, rinfo.port, rinfo.address); // straight back to the asker
    }
  });
  const { browse } = require('../src/print/discovery/browse');
  const r = await browse({ timeoutMs: 3000 });
  responder.close();
  console.log('search stats:', JSON.stringify(r.stats));
  if (!r.devices.some((d) => d.name === 'FP Fake mDNS')) throw new Error(`Search did not find the fake printer: ${JSON.stringify(r.devices.map((d) => d.name))}`);
  console.log('search found the fake printer');

  await fake.stop();
  console.log('Add-printer smoke test passed');
  process.exit(0);
}

main().catch((err) => {
  console.error('Smoke test FAILED:', err.stack || err.message);
  process.exit(1);
});
