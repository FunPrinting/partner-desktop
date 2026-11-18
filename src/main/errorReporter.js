/**
 * Sends errors from the desktop app to the web app's error log (/api/errors,
 * shown in /admin/errors). Uses the partner token when signed in, so reports are
 * tied to the shop. Reporting never throws and never retries.
 *
 * Local limits: the same message at most once a minute, 30 reports an hour.
 */

const os = require('os');
const { app } = require('electron');
const { WEB_URL } = require('./config');

const recent = new Map(); // message -> last sent at
let sentThisHour = 0;
let hourStartedAt = Date.now();
let getToken = () => undefined;

function setTokenProvider(fn) {
  getToken = fn;
}

function allowed(key) {
  const now = Date.now();
  if (now - hourStartedAt > 3600_000) {
    hourStartedAt = now;
    sentThisHour = 0;
    recent.clear();
  }
  if (sentThisHour >= 30) return false;
  const last = recent.get(key);
  if (last && now - last < 60_000) return false;
  recent.set(key, now);
  sentThisHour++;
  return true;
}

/**
 * @param {unknown} error Error or message
 * @param {{ level?: 'error'|'warning', context?: object }} [opts]
 */
function reportError(error, { level = 'error', context } = {}) {
  try {
    if (process.env.ERROR_TRACKING_DISABLED === '1') return;
    const err = error instanceof Error ? error : new Error(String(error));
    const message = String(err.message || 'Unknown error').slice(0, 5000);
    if (!allowed(`${level}:${message}`)) return;
    const token = getToken();
    const body = {
      source: 'desktop',
      level,
      name: err.name,
      message,
      stack: err.stack ? String(err.stack).slice(0, 20000) : undefined,
      appVersion: app.getVersion(),
      platform: `${process.platform}-${os.release()}`.slice(0, 50),
      context,
    };
    fetch(`${WEB_URL}/api/errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
  } catch {
    // never let reporting break the app
  }
}

function installGlobalHandlers() {
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    reportError(err, { context: { kind: 'uncaughtException' } });
  });
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
    reportError(reason, { context: { kind: 'unhandledRejection' } });
  });
}

module.exports = { reportError, installGlobalHandlers, setTokenProvider };
