'use strict';
const net = require('node:net');
const { pickDriver } = require('./cupsSetup');

/**
 * Setting a found network printer up in Windows.
 *
 *   IPP printers  `Add-Printer -Name <n> -IppURL <http(s)://host:631/ipp/print>`: Windows asks the
 *                 printer what it can do and uses its built-in "Microsoft IPP Class Driver".
 *                 No vendor driver. (If that call is refused, the older form with
 *                 -PortName <url> -DriverName "Microsoft IPP Class Driver" is tried.)
 *   Raw 9100/LPD  A Standard TCP/IP port (SNMP status on) plus an installed driver that
 *                 matches the model. Without one: NEEDS_DRIVER.
 *
 * Adding a printer needs an administrator. The app runs ONE fixed script elevated (a UAC
 * prompt) and passes it the details as a JSON file, never as command text.
 */

/** A Windows printer name: letters, digits, space and . - _ ( ) only; unique among `existing`. */
function printerName(device, existing = []) {
  const base =
    String(device.name || device.model || 'Network printer')
      .replace(/[^A-Za-z0-9 ._()-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'Network printer';
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  let name = base;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base} (${i})`;
  return name;
}

/** http(s) form of an IPP URL, which is what Windows wants. Host name first, then address. */
function windowsIppUrls(device) {
  const out = [];
  const add = (u) => u && !out.includes(u) && out.push(u.replace(/^ipps:/, 'https:').replace(/^ipp:/, 'http:'));
  const p = device.protocols.ipps || device.protocols.ipp;
  const scheme = device.protocols.ipps ? 'ipps' : 'ipp';
  const places = [device.host, ...device.addresses.filter(net.isIPv4).slice(0, 3), ...device.addresses.filter(net.isIPv6).slice(0, 1)].filter(Boolean);
  const url = (where, sch) => `${sch}://${net.isIPv6(where) ? `[${where}]` : where}:${p.port}/${p.rp}`;
  for (const where of places) add(url(where, scheme));
  const plain = device.protocols.ipp;
  if (device.protocols.ipps && plain) for (const where of places) add(`ipp://${net.isIPv6(where) ? `[${where}]` : where}:${plain.port}/${plain.rp}`);
  return out;
}

/** Everything the script needs. Validated: host names and addresses only, numbers for ports. */
function buildParams(device, existingNames) {
  const name = printerName(device, existingNames);
  if (device.protocols.ipp || device.protocols.ipps) return { mode: 'ipp', name, urls: windowsIppUrls(device) };
  const host = device.addresses.find(net.isIPv4) || device.addresses[0];
  const raw = device.protocols.socket || device.protocols.lpd;
  if (!host || !raw || !net.isIP(host)) return null;
  return {
    mode: 'raw',
    name,
    host,
    port: device.protocols.socket ? Number(device.protocols.socket.port) || 9100 : 9100,
    make: String(device.make || ''),
    model: String(device.model || ''),
  };
}

/** Pick an installed driver (names from Get-PrinterDriver) for a raw printer. */
function chooseInstalledDriver(driverNames, { make, model }) {
  const hit = pickDriver(driverNames.map((n) => ({ id: n, text: n })), { make, model });
  return hit ? hit.id : null;
}

/** The fixed script. Reads -Params (JSON), writes -Result (JSON). Runs elevated. */
const ADD_PRINTER_SCRIPT = String.raw`
param([string]$Params, [string]$Result)
$ErrorActionPreference = 'Stop'
function Done($ok, $code, $message, $name, $via) {
  @{ ok = $ok; code = $code; message = $message; name = $name; via = $via } | ConvertTo-Json | Set-Content -LiteralPath $Result -Encoding UTF8
  exit 0
}
try {
  $p = Get-Content -LiteralPath $Params -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($p.mode -eq 'ipp') {
    $last = ''
    foreach ($url in $p.urls) {
      try {
        Add-Printer -Name $p.name -IppURL $url
        Done $true '' '' $p.name $url
      } catch { $last = $_.Exception.Message }
      try {
        Add-Printer -Name $p.name -PortName $url -DriverName 'Microsoft IPP Class Driver'
        Done $true '' '' $p.name $url
      } catch { $last = $_.Exception.Message }
    }
    Done $false 'ADD_FAILED' $last '' ''
  }
  if ($p.mode -eq 'raw') {
    $driver = $p.driver
    if (-not $driver) { Done $false 'NEEDS_DRIVER' 'No matching driver is installed.' '' '' }
    $port = 'IP_' + $p.host
    if (-not (Get-PrinterPort -Name $port -ErrorAction SilentlyContinue)) {
      Add-PrinterPort -Name $port -PrinterHostAddress $p.host -PortNumber ([int]$p.port) -SNMP 1 -SNMPCommunity 'public'
    }
    Add-Printer -Name $p.name -PortName $port -DriverName $driver
    Done $true '' '' $p.name $port
  }
  Done $false 'ADD_FAILED' 'Unknown request.' '' ''
} catch {
  Done $false 'ADD_FAILED' $_.Exception.Message '' ''
}
`;

/** The command that starts the script elevated and waits for it (paths quoted for PowerShell). */
function launcherCommand(scriptPath, paramsPath, resultPath) {
  const lit = (v) => `'"${String(v).replace(/'/g, "''")}"'`;
  return (
    `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden ` +
    `-ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',${lit(scriptPath)},'-Params',${lit(paramsPath)},'-Result',${lit(resultPath)})`
  );
}

module.exports = { printerName, windowsIppUrls, buildParams, chooseInstalledDriver, ADD_PRINTER_SCRIPT, launcherCommand };
