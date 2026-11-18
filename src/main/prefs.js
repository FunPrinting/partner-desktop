/**
 * User preferences, saved to prefs.json in the app's data folder.
 * Defaults keep the app working exactly as before; everything new is opt-in.
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { app } = require('electron');

const FILE = path.join(app.getPath('userData'), 'prefs.json');

const DEFAULTS = {
  printerName: null, // chosen printer; jobs are only taken when set
  theme: 'system', // system | light | dark
  notifyNewOrders: true, // system notification for orders to accept
  soundNewOrders: false, // chime for orders to accept
  printSummarySheet: true, // order summary page on top of multi-page jobs
  autoReadyForPickup: true, // pickup orders move to "ready for pickup" after printing
  openAtLogin: false,
  keepRunningInTray: false, // closing the window keeps printing in the background
  developerMode: false, // show the system log panel
};

const TYPES = {
  printerName: (v) => v === null || (typeof v === 'string' && v.length <= 300),
  theme: (v) => v === 'system' || v === 'light' || v === 'dark',
};

const events = new EventEmitter();
let prefs = { ...DEFAULTS };

try {
  if (fs.existsSync(FILE)) prefs = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf-8')) };
} catch (err) {
  console.warn('Could not read prefs.json, using defaults:', err.message);
}

function valid(key, value) {
  if (!(key in DEFAULTS)) return false;
  if (TYPES[key]) return TYPES[key](value);
  return typeof value === typeof DEFAULTS[key];
}

function get() {
  return { ...prefs };
}

/** Applies the valid keys of `patch`; returns the new prefs. */
function set(patch) {
  const changed = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (valid(key, value) && prefs[key] !== value) changed[key] = value;
  }
  if (!Object.keys(changed).length) return get();
  prefs = { ...prefs, ...changed };
  try {
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(prefs, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.error('Could not save prefs.json:', err.message);
  }
  events.emit('changed', get(), changed);
  return get();
}

module.exports = { get, set, events, DEFAULTS };
