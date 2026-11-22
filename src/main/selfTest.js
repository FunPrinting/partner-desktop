'use strict';
/**
 * `FunPrinting Partner --self-test`: checks the installed app can see printers and load
 * what printing needs, prints one JSON line to stdout and exits (0 = ok). Used by CI on the
 * packaged app, and by support: "run it with --self-test and send us the output".
 *
 * Opens no window, does not sign in and changes no settings.
 */
const os = require('node:os');
const path = require('node:path');

async function runSelfTest(app) {
  const report = { ok: false, platform: process.platform, arch: process.arch, version: app.getVersion(), packaged: app.isPackaged };
  try {
    const { createEngine } = require('../print/service');
    const engine = createEngine();
    report.engine = engine.name;
    const printers = await engine.listPrinters();
    report.printers = printers.map((p) => ({ name: p.name, uri: p.uri, driver: p.driver, online: p.status?.online }));
    if (printers[0]) {
      try {
        report.capabilities = { printer: printers[0].name, ...(await engine.capabilities(printers[0].name)) };
      } catch (err) {
        report.capabilitiesError = err.message;
      }
    }
    if (typeof engine.checkPrinting === 'function') report.printing = engine.checkPrinting();
    // Can this app reach each network printer? (macOS Local Network permission, firewalls)
    const { createReach } = require('../print/discovery/reach');
    const reach = createReach();
    report.reach = {};
    for (const p of printers) report.reach[p.name] = await reach(p).catch((err) => ({ error: err.message }));
    const { browse } = require('../print/discovery/browse');
    const found = await browse({ timeoutMs: 2500 });
    report.network = { found: found.devices.map((d) => d.name), error: found.error, stats: found.stats };
    report.ok = true;
  } catch (err) {
    report.error = `${err.code || ''} ${err.message}`.trim();
  }
  report.tmp = os.tmpdir();
  report.appPath = path.normalize(app.getAppPath());
  const line = `${JSON.stringify(report)}\n`;
  process.stdout.write(line);
  // Windows GUI apps often have no console: also write to a file when asked
  const out = process.argv.find((a) => a.startsWith('--self-test-out='));
  if (out) require('node:fs').writeFileSync(out.slice('--self-test-out='.length), line);
  return report.ok ? 0 : 1;
}

module.exports = { runSelfTest };
