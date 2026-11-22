'use strict';
/** Lists the printers found on the network: node scripts/discover.js [seconds] */
const { browse } = require('../src/print/discovery/browse');
const { ippUrl } = require('../src/print/discovery/merge');

(async () => {
  const seconds = Number(process.argv[2]) || 4;
  const { devices, error } = await browse({ timeoutMs: seconds * 1000 });
  if (error) console.log('Problem:', error);
  if (!devices.length) console.log('No printers found.');
  for (const d of devices) {
    console.log(`\n${d.name}  [${d.preferred}]`);
    console.log(`  host ${d.host}  addresses ${d.addresses.join(', ')}`);
    console.log(`  protocols ${Object.entries(d.protocols).map(([k, v]) => `${k}:${v.port}`).join('  ')}`);
    console.log(`  announced ${JSON.stringify(d.announced)}`);
    if (ippUrl(d)) console.log(`  url ${ippUrl(d)}`);
  }
  process.exit(0);
})();
