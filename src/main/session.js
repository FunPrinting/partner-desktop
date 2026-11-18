/**
 * Partner sign-in (one-time code + PKCE), token refresh and authenticated API calls.
 * See FunPrinting-Web docs/PARTNER_AUTH.md for the server side.
 *
 * - Access tokens last 15 minutes and are refreshed a minute before they expire,
 *   and once more if the API answers 401.
 * - The refresh token changes on every refresh; only the newest is kept.
 *   Refreshes are single-flight so two callers never spend the same token.
 */

const crypto = require('crypto');
const http = require('http');
const os = require('os');
const { EventEmitter } = require('events');
const { app, shell } = require('electron');
const { WEB_URL, CALLBACK_HOST, CALLBACK_PORT, CALLBACK_URL } = require('./config');
const tokenStore = require('./tokenStore');

const REFRESH_MARGIN_MS = 60_000;
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

const events = new EventEmitter();
let session = null; // { accessToken, accessExpiresAt, refreshToken, refreshExpiresAt, deviceId, partnerId }
let refreshing = null;
let pendingSignIn = null;

class NotSignedInError extends Error {
  constructor(message = 'Not signed in') {
    super(message);
    this.name = 'NotSignedInError';
  }
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function publicState() {
  return session ? { signedIn: true, partnerId: session.partnerId, deviceId: session.deviceId } : { signedIn: false };
}

function setSession(next) {
  session = next;
  if (next) tokenStore.save(next);
  else tokenStore.clear();
  events.emit('changed', publicState());
}

function fromTokenResponse(data) {
  if (!data || typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string') {
    throw new Error('Unexpected sign-in response');
  }
  return {
    accessToken: data.access_token,
    accessExpiresAt: Date.now() + Math.max(60, Number(data.expires_in) || 900) * 1000,
    refreshToken: data.refresh_token,
    refreshExpiresAt: data.refresh_token_expires_at ? new Date(data.refresh_token_expires_at).getTime() : undefined,
    deviceId: data.device_id,
    partnerId: data.partner_id,
  };
}

async function postToken(body) {
  const res = await fetch(`${WEB_URL}/api/partner/device-auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

/** Ends the session on this machine (the server already refused it, or the user signed out). */
function endSession(reason) {
  if (!session) return;
  console.log(`🔒 Signed out: ${reason}`);
  setSession(null);
  events.emit('signed-out', { reason });
}

// ── Startup ────────────────────────────────────────────────────────────

function restore() {
  const saved = tokenStore.load();
  if (saved && saved.refreshToken && (!saved.refreshExpiresAt || saved.refreshExpiresAt > Date.now())) {
    session = saved;
  } else if (saved) {
    tokenStore.clear();
  }
  events.emit('changed', publicState());
  return publicState();
}

// ── Sign-in ────────────────────────────────────────────────────────────

/** Stops waiting for the browser. `reason` rejects the waiting signIn() call. */
function cancelPendingSignIn(reason) {
  if (!pendingSignIn) return;
  const { server, timer, reject } = pendingSignIn;
  pendingSignIn = null;
  clearTimeout(timer);
  try {
    server.close();
  } catch {
    // already closed
  }
  if (reason) reject(new Error(reason));
}

function page(title, text) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
    '<body style="font-family:system-ui,sans-serif;background:#f9fafb;color:#111827;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">' +
    `<div style="text-align:center"><h2>${title}</h2><p>${text}</p></div></body></html>`;
}

/**
 * Opens the browser sign-in page and waits for the one-time code on the local
 * callback. Resolves with the signed-in state, rejects with a readable message.
 */
function signIn() {
  cancelPendingSignIn('A new sign-in was started.');
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(24));

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, CALLBACK_URL);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end('Not found');
        return;
      }
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state') || '';
      if (!code || !safeEqual(returnedState, state)) {
        // Not our sign-in (stale tab or a different request); keep waiting
        res.writeHead(400, { 'Content-Type': 'text/html' }).end(page('Sign-in link expired', 'Start the sign-in again from the FunPrinting Partner app.'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(page('Signed in', 'You can close this tab and return to the FunPrinting Partner app.'));
      cancelPendingSignIn();
      try {
        const { res: tokenRes, data } = await postToken({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          device_name: (os.hostname() || 'Partner desktop').slice(0, 100),
          platform: 'desktop',
          app_version: app.getVersion(),
        });
        if (!tokenRes.ok) throw new Error(data.error_description || data.error || `Sign-in failed (${tokenRes.status})`);
        setSession(fromTokenResponse(data));
        console.log(`🔓 Signed in as shop ${session.partnerId} (device ${session.deviceId})`);
        resolve(publicState());
      } catch (err) {
        reject(new Error(err.message || 'Sign-in failed'));
      }
    });

    server.on('error', (err) => {
      cancelPendingSignIn();
      reject(
        new Error(
          err.code === 'EADDRINUSE'
            ? `Port ${CALLBACK_PORT} is in use. Close other FunPrinting Partner windows and try again.`
            : `Could not start sign-in: ${err.message}`
        )
      );
    });

    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      const timer = setTimeout(() => cancelPendingSignIn('Sign-in timed out. Please try again.'), SIGN_IN_TIMEOUT_MS);
      pendingSignIn = { server, timer, reject };
      const target = new URL(`${WEB_URL}/partner/desktop-auth`);
      target.searchParams.set('callback', CALLBACK_URL);
      target.searchParams.set('state', state);
      target.searchParams.set('code_challenge', challenge);
      target.searchParams.set('code_challenge_method', 'S256');
      shell.openExternal(target.toString());
    });
  });
}

// ── Tokens ─────────────────────────────────────────────────────────────

async function doRefresh() {
  const sent = session.refreshToken;
  let result;
  try {
    result = await postToken({ grant_type: 'refresh_token', refresh_token: sent });
  } catch (err) {
    // Offline or server down: keep the session and try again later
    throw new Error(`Could not refresh sign-in: ${err.message}`);
  }
  const { res, data } = result;
  if (res.ok) {
    setSession(fromTokenResponse(data));
    return session.accessToken;
  }
  if (res.status === 409 && data.error === 'refresh_in_progress') {
    // The server already rotated this token. Use the newest one if we have it.
    const saved = tokenStore.load();
    if (saved && saved.refreshToken !== sent && saved.accessExpiresAt > Date.now()) {
      session = saved;
      return session.accessToken;
    }
    endSession('the sign-in was refreshed elsewhere; please sign in again');
    throw new NotSignedInError();
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    endSession(data.error_description || 'your session has ended');
    throw new NotSignedInError();
  }
  throw new Error(`Could not refresh sign-in (${res.status})`);
}

/** Refreshes now (single-flight). */
function refresh() {
  if (!session) return Promise.reject(new NotSignedInError());
  if (!refreshing) {
    refreshing = doRefresh().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

/** A valid access token, refreshed when it is about to expire. */
async function getAccessToken() {
  if (!session) throw new NotSignedInError();
  if (refreshing) return refreshing;
  if (session.accessExpiresAt - Date.now() > REFRESH_MARGIN_MS) return session.accessToken;
  return refresh();
}

/**
 * fetch() against the web API with the partner token. On 401 refreshes once and
 * retries. Returns { ok, status, data }.
 */
async function apiFetch(path, { method = 'GET', body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const send = async (token) => {
    const res = await fetch(`${WEB_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  };
  let result = await send(await getAccessToken());
  if (result.status === 401 && session) {
    result = await send(await refresh());
  }
  return result;
}

async function signOut() {
  cancelPendingSignIn('Sign-in cancelled.');
  if (!session) return;
  const deviceId = session.deviceId;
  try {
    // Revoke this device on the server so the tokens can't be used again
    await apiFetch('/api/partner/devices', { method: 'DELETE', body: { deviceId }, timeoutMs: 5000 });
  } catch (err) {
    console.warn('Could not reach the server to sign out; signing out locally.', err.message);
  }
  endSession('signed out on this computer');
}

module.exports = {
  events,
  restore,
  signIn,
  signOut,
  refresh,
  getAccessToken,
  apiFetch,
  endSession,
  publicState,
  NotSignedInError,
  getDeviceId: () => session?.deviceId,
  getPartnerId: () => session?.partnerId,
  getAccessTokenSync: () => session?.accessToken,
};
