/**
 * Server addresses. Override for staging or local development:
 *   FP_WEB_URL=http://localhost:3000 FP_WSS_URL=http://localhost:8080 npm start
 */

function trimSlash(url) {
  return String(url).replace(/\/+$/, '');
}

const WEB_URL = trimSlash(process.env.FP_WEB_URL || 'https://www.funprinting.store');
const WSS_URL = trimSlash(process.env.FP_WSS_URL || process.env.WSS_URL || 'https://funprinting-wss.onrender.com');

// Sign-in callback. The web app only accepts this exact address for desktop sign-in.
const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PORT = 4321;
const CALLBACK_URL = `http://${CALLBACK_HOST}:${CALLBACK_PORT}/callback`;

module.exports = { WEB_URL, WSS_URL, CALLBACK_HOST, CALLBACK_PORT, CALLBACK_URL };
