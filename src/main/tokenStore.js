/**
 * Saves the sign-in tokens encrypted with the OS keychain (Electron safeStorage)
 * in the app's userData folder. The renderer never sees them.
 *
 * If the OS offers no encryption (some Linux desktops without a keyring), tokens
 * are kept in memory only and the shop signs in again after a restart.
 */

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const FILE = path.join(app.getPath('userData'), 'session.bin');
let memory = null;

function canEncrypt() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    // "basic_text" on Linux means a hardcoded key: not real protection
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') return false;
    return true;
  } catch {
    return false;
  }
}

function load() {
  if (memory) return memory;
  try {
    if (!canEncrypt() || !fs.existsSync(FILE)) return null;
    const json = safeStorage.decryptString(fs.readFileSync(FILE));
    memory = JSON.parse(json);
    return memory;
  } catch (err) {
    console.warn('Saved sign-in could not be read; please sign in again.', err.message);
    clear();
    return null;
  }
}

function save(session) {
  memory = session;
  if (!canEncrypt()) {
    console.warn('OS encryption is not available: sign-in is kept for this run only.');
    return;
  }
  try {
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(session)), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.error('Failed to save sign-in:', err.message);
  }
}

function clear() {
  memory = null;
  try {
    if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
  } catch (err) {
    console.error('Failed to remove saved sign-in:', err.message);
  }
}

module.exports = { load, save, clear };
