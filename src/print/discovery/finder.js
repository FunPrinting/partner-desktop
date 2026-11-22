'use strict';
const { browse: defaultBrowse } = require('./browse');
const { probeDevice: defaultProbe } = require('./probe');
const { findSetUp, computeMoves } = require('./match');

/**
 * Finds printers on the network that are not yet set up on this computer.
 * Each scan: browse -> probe every device (exact properties for IPP printers) -> drop the
 * ones the OS already has -> hand the rest to the registry as `available`.
 */
function createFinder({ registry, canMove = false, browse = defaultBrowse, probe = defaultProbe, browseMs = 3500, ttlMs = 5 * 60_000, now = () => Date.now() }) {
  let scanning = null;
  let found = []; // devices with probe results, set up or not
  let lastScanAt = 0;

  function publish() {
    const printers = registry.snapshot().printers;
    registry.setAvailable(
      found
        .filter((d) => !findSetUp(d, printers))
        .map((d) => ({
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
        })),
      { scanning: Boolean(scanning), lastScanAt }
    );
    registry.setMoves(canMove ? computeMoves(printers, found) : []);
  }

  async function doScan() {
    registry.setAvailable(registry.snapshot().available || [], { scanning: true, lastScanAt });
    try {
      const { devices, error } = await browse({ timeoutMs: browseMs });
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

  function scan() {
    if (!scanning) scanning = doScan();
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
  };
}

module.exports = { createFinder };
