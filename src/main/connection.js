/**
 * Socket connection to the WSS relay. The socket only says "something changed"
 * (jobs:available, cancel_print_job); job data always comes from the web API.
 *
 * The server closes the socket when the 15-minute access token expires or the
 * device is signed out. Each (re)connect fetches a fresh token first.
 */

const { io } = require('socket.io-client');
const { WSS_URL } = require('./config');
const session = require('./session');

let socket = null;
let retryTimer = null;
let retryDelay = 2000;
let handlers = { onConnected: () => {}, onJobsChanged: () => {}, onRemoteControl: () => {}, onStatus: () => {} };

function setHandlers(next) {
  handlers = { ...handlers, ...next };
}

function status(connected, message) {
  handlers.onStatus({ connected, message });
}

function scheduleReconnect() {
  if (retryTimer || !socket) return;
  const delay = retryDelay;
  retryDelay = Math.min(retryDelay * 2, 60_000);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (socket && !socket.connected) socket.connect();
  }, delay);
}

function connect() {
  disconnect();
  socket = io(WSS_URL, {
    // Called before every connection attempt, so reconnects use a fresh token
    auth: (cb) => {
      session
        .getAccessToken()
        .then((token) => cb({ token }))
        .catch(() => cb({}));
    },
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 30000,
    timeout: 10000,
  });

  socket.on('connect', () => {
    retryDelay = 2000;
    console.log('🟢 Connected to FunPrinting relay');
    status(true, 'Online');
    handlers.onConnected();
  });

  socket.on('disconnect', (reason) => {
    console.log(`🔴 Relay disconnected (${reason})`);
    status(false, 'Reconnecting…');
    // The server closed it (token expiry or sign-out): socket.io won't retry by itself
    if (reason === 'io server disconnect') {
      session
        .refresh()
        .then(() => scheduleReconnect())
        .catch((err) => {
          if (!(err instanceof session.NotSignedInError)) scheduleReconnect();
        });
    }
  });

  socket.on('connect_error', (err) => {
    console.log(`🔴 Relay connection error: ${err.message}`);
    status(false, 'Offline, retrying…');
    // Rejected by the auth check: socket.io stops retrying, so refresh and retry
    if (!socket.active) {
      session
        .refresh()
        .then(() => scheduleReconnect())
        .catch((e) => {
          if (!(e instanceof session.NotSignedInError)) scheduleReconnect();
        });
    }
  });

  socket.on('jobs:available', () => handlers.onJobsChanged('jobs:available'));
  socket.on('cancel_print_job', () => handlers.onJobsChanged('cancel_print_job'));
  socket.on('signed_out', () => {
    // Revoked on the server: the refresh fails and ends the session
    session.refresh().catch(() => undefined);
  });
  socket.on('remote_control_action', (data) => {
    if (data && (data.action === 'pause' || data.action === 'resume')) handlers.onRemoteControl(data.action);
  });
}

function disconnect() {
  clearTimeout(retryTimer);
  retryTimer = null;
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
}

function isConnected() {
  return Boolean(socket && socket.connected);
}

module.exports = { connect, disconnect, isConnected, setHandlers };
