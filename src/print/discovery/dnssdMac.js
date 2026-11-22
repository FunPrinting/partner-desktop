'use strict';
/**
 * macOS native Bonjour discovery using dns-sd.
 *
 * macOS sandboxes and application firewalls frequently restrict raw UDP socket
 * multicast on port 5353 for ad-hoc signed or third-party binaries. Apple's
 * built-in `dns-sd` command communicates with mDNSResponder over an internal
 * UNIX domain socket, which is always permitted by the OS without firewall prompts
 * or root elevation.
 *
 * Returns records in the standard shape expected by mergeServices():
 *   { type, name, host, port, addresses, txt }
 */
const { spawn } = require('node:child_process');
const dns = require('node:dns');

function runDnssd(args, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('dns-sd', args);
    } catch {
      return resolve('');
    }
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.on('error', () => resolve(out));
    setTimeout(() => {
      try {
        child.kill();
      } catch {}
      resolve(out);
    }, timeoutMs);
  });
}

async function browseMac({ timeoutMs = 2500 } = {}) {
  if (process.platform !== 'darwin') return [];
  const types = ['_ipps._tcp', '_ipp._tcp', '_pdl-datastream._tcp', '_printer._tcp'];
  const foundInstances = [];

  const browseTimeout = Math.min(1200, Math.floor(timeoutMs * 0.6));
  await Promise.all(
    types.map(async (type) => {
      const out = await runDnssd(['-B', type, 'local'], browseTimeout);
      for (const line of out.split('\n')) {
        const m = line.match(/Add\s+\d+\s+\d+\s+\S+\s+(\S+)\s+(.+)$/);
        if (m && m[1] && m[2]) {
          foundInstances.push({ type, name: m[2].trim() });
        }
      }
    })
  );

  const seen = new Set();
  const instances = foundInstances.filter((i) => {
    const k = `${i.type}:${i.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (!instances.length) return [];

  const lookupTimeout = Math.min(1500, Math.max(800, timeoutMs - browseTimeout));
  const records = [];

  await Promise.all(
    instances.map(async ({ type, name }) => {
      const lookupOut = await runDnssd(['-L', name, type, 'local'], lookupTimeout);
      const reachMatch = lookupOut.match(/can be reached at\s+([^:]+):(\d+)/);
      if (!reachMatch) return;
      const host = reachMatch[1].trim().replace(/\.$/, '');
      const port = parseInt(reachMatch[2], 10);
      if (!host || !port) return;

      const txt = {};
      for (const line of lookupOut.split('\n')) {
        if (line.includes('can be reached at') || line.includes('STARTING') || line.includes('Lookup')) continue;
        const pairs = line.trim().split(/\s+(?=[a-zA-Z0-9_-]+=)/);
        for (const p of pairs) {
          const eq = p.indexOf('=');
          if (eq > 0) {
            const k = p.slice(0, eq).trim();
            const v = p.slice(eq + 1).trim().replace(/\\ /g, ' ');
            txt[k] = v;
          }
        }
      }

      let addresses = [];
      try {
        const look = await new Promise((res, rej) =>
          dns.lookup(host, { all: true }, (err, addrs) => (err ? rej(err) : res(addrs)))
        );
        addresses = (look || []).map((a) => a.address);
      } catch {}

      records.push({ type, name, host, port, addresses, txt });
    })
  );

  return records;
}

module.exports = { browseMac };
