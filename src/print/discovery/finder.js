'use strict';
const { browse: defaultBrowse } = require('./browse');
const { sweep: defaultSweep } = require('./sweep');
const { mergeServices } = require('./merge');
const { probeDevice: defaultProbe } = require('./probe');
const { findSetUp, computeMoves } = require('./match');

/**
 * Finds printers on the network that are not yet set up on this computer.
 * Each scan: browse -> probe every device (exact properties for IPP printers) -> drop the
 * ones the OS already has -> hand the rest to the registry as `available`.
 */
function createFinder({ registry, canMove = false, log = () => {}, sweep = defaultSweep, browse = defaultBrowse, probe = defaultProbe, browseMs = 3500, ttlMs = 5 * 60_000, now = () => Date.now() }) {
  let scanning = null;
  let found = []; // devices with probe results, set up or not
  let lastScanAt = 0;
  let lastStats = null; // what the last search did, for Settings and the Logs page
  let thorough = false;

  function publish() {
    const printers = registry.snapshot().printers;
    // Every printer found is listed. One already set up here says so (and offers no Add),
    // so a search never looks empty when it did find the shop's printer.
    registry.setAvailable(
      found.map((d) => {
        const setUp = findSetUp(d, printers);
        return {
          id: d.id,
          name: d.name,
          make: d.make,
          model: d.model,
          host: d.host,
          address: d.addresses[0],
          protocol: d.preferred,
          viaIpp: Boolean(d.protocols.ipp || d.protocols.ipps),
          reachable: d.probe.reachable,
          estimated: d.probe.estimated,
          caps: d.probe.caps,
          status: d.probe.status,
          error: d.probe.error,
          security: d.probe.security,
          fingerprint: d.probe.fingerprint,
          setUpAs: setUp ? setUp.displayName || setUp.name : undefined,
        };
      }),
      { scanning: Boolean(scanning), lastScanAt, stats: lastStats }
    );
    registry.setMoves(canMove ? computeMoves(printers, found) : []);
  }

  async function doScan() {
    registry.setAvailable(registry.snapshot().available || [], { scanning: true, lastScanAt, stats: lastStats });
    try {
      const { devices: viaMdns, error, stats } = await browse({ timeoutMs: browseMs });
      let devices = viaMdns;
      let swept = null;
      // No announcements arrived (multicast blocked), or the shop pressed Search: also try every address
      if (!viaMdns.length || thorough) {
        try {
          swept = await sweep({});
          const known = new Set(viaMdns.flatMap((d) => d.addresses));
          const extra = mergeServices(swept.records.filter((r) => !r.addresses.some((a) => known.has(a))));
          devices = [...viaMdns, ...extra];
        } catch (err) {
          swept = { error: err.message };
        }
      }
      lastStats = {
        at: now(),
        adapters: (stats?.adapters || []).map((a) => `${a.name} ${a.address}${a.error ? ` (${a.error})` : ` ${a.answers} answer(s)`}`),
        sharedPort: stats?.shared,
        mdnsFound: viaMdns.length,
        swept: swept ? { subnets: swept.stats?.subnets, open: swept.stats?.open, printers: swept.stats?.printers, error: swept.error } : null,
        found: devices.length,
        error,
      };
      log(`Printer search: ${JSON.stringify(lastStats)}`);
      const probed = await Promise.all(devices.map(async (d) => ({ ...d, probe: await probe(d).catch((e) => ({ reachable: false, estimated: false, caps: null, status: { online: false, message: e.message }, error: e.message })) })));
      found = probed;
      lastScanAt = now();
      registry.setScanError(error || null);
    } finally {
      scanning = null;
      publish();
    }
    return registry.snapshot();
  }

  /** `thorough`: also try every address on the network (the Search button). */
  function scan({ thorough: full = false } = {}) {
    if (!scanning) {
      thorough = full;
      scanning = doScan();
    }
    return scanning;
  }

  // A printer that was just added (or removed) in the OS changes what is "available"
  registry.events.on('changed', () => {
    if (found.length) publish();
  });

  return {
    scan,
    /** Scan unless a recent scan exists. */
    scanIfStale: () => (now() - lastScanAt > ttlMs ? scan() : Promise.resolve(registry.snapshot())),
    device: (id) => found.find((d) => d.id === id),
    stats: () => lastStats,
  };
}

module.exports = { createFinder };
