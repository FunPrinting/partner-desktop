'use strict';
/**
 * macOS firewall auto-registration.
 *
 * When the app is installed to /Applications (or any path different from the dev
 * build in dist/), macOS firewall may block all its network operations (mDNS, IPP
 * scanning, printer reachability checks) with EHOSTUNREACH, even if Local Network
 * permission is granted. This module detects that situation and registers the
 * running app binary with the application firewall using `socketfilterfw`.
 *
 * On first run this may show a system "allow incoming connections?" dialog, which
 * is enough — no admin password needed for that prompt. If the prompt was already
 * dismissed and the app is blocked, it uses osascript to elevate and add the rule.
 */
const { execFile } = require('node:child_process');
const path = require('node:path');

const SOCKETFILTERFW = '/usr/libexec/ApplicationFirewall/socketfilterfw';

/** Runs socketfilterfw and returns stdout. */
function fw(args) {
  return new Promise((resolve, reject) => {
    execFile(SOCKETFILTERFW, args, { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/**
 * Returns true if the macOS application firewall is enabled.
 */
async function isFirewallEnabled() {
  try {
    const out = await fw(['--getglobalstate']);
    return /State = 1|enabled/i.test(out);
  } catch {
    return false;
  }
}

/**
 * Returns true if the given app path has an "allow" rule in the firewall.
 */
async function isAppAllowed(appPath) {
  try {
    const out = await fw(['--listapps']);
    // socketfilterfw lists apps with their full path; check if our path is there
    // and that it says "Allow" (not "Block")
    const normalised = path.normalize(appPath);
    const lines = out.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(normalised)) {
        // The next line has "(Allow incoming connections)" or "(Block incoming connections)"
        const status = lines[i + 1] || lines[i];
        return /Allow/i.test(status);
      }
    }
    return false;
  } catch {
    return false; // can't tell; assume not allowed
  }
}

/**
 * Adds the app to the firewall allow list. This runs the socketfilterfw commands
 * which on macOS show the standard "allow incoming network connections?" dialog
 * the first time. No admin password is needed for that prompt.
 */
async function addToFirewall(appPath) {
  const normalised = path.normalize(appPath);
  try {
    // --add registers the app; --unblockapp ensures it's set to "allow"
    await fw(['--add', normalised]);
    await fw(['--unblockapp', normalised]);
    console.log(`Firewall: registered ${normalised}`);
    return true;
  } catch (err) {
    // If non-admin can't do it, try with osascript privilege elevation
    console.log(`Firewall: direct add failed (${err.message}), trying with admin privileges…`);
    try {
      await elevatedFirewallAdd(normalised);
      return true;
    } catch (elErr) {
      console.error(`Firewall: could not register app: ${elErr.message}`);
      return false;
    }
  }
}

/**
 * Uses osascript to run the firewall commands with admin privileges.
 * Shows a macOS password dialog to the user.
 */
function elevatedFirewallAdd(appPath) {
  return new Promise((resolve, reject) => {
    const script = `do shell script "${SOCKETFILTERFW} --add '${appPath.replace(/'/g, "\\'")}' && ${SOCKETFILTERFW} --unblockapp '${appPath.replace(/'/g, "\\'")}'" with administrator privileges`;
    execFile('osascript', ['-e', script], { timeout: 30000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Finds the .app bundle path from the running process. When packaged, the
 * executable is at Something.app/Contents/MacOS/Name, so we go up 3 levels.
 * Returns null if not inside a .app bundle.
 */
function appBundlePath() {
  const exe = process.execPath;
  // Find the .app component in the path
  const match = exe.match(/^(.+?\.app)\//);
  return match ? match[1] : null;
}

/**
 * Call at app startup (macOS only). Checks if the firewall is on and the app
 * isn't registered, and fixes it. Returns a description of what happened.
 */
async function ensureFirewallAccess() {
  if (process.platform !== 'darwin') return { action: 'skip', reason: 'not macOS' };

  const enabled = await isFirewallEnabled();
  if (!enabled) return { action: 'skip', reason: 'firewall disabled' };

  const bundle = appBundlePath();
  if (!bundle) return { action: 'skip', reason: 'not in .app bundle' };

  const allowed = await isAppAllowed(bundle);
  if (allowed) return { action: 'skip', reason: 'already allowed' };

  console.log(`Firewall: app at ${bundle} is not registered, adding…`);
  const ok = await addToFirewall(bundle);
  return { action: ok ? 'added' : 'failed', path: bundle };
}

module.exports = { ensureFirewallAccess, appBundlePath, isFirewallEnabled, isAppAllowed };
