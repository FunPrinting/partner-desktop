/**
 * Optional tray / menu-bar icon ("Keep printing when the window is closed").
 * The window hides instead of quitting; the tray reopens it, pauses printing or quits.
 */
const path = require('path');
const { app, Menu, Tray, nativeImage } = require('electron');

let tray = null;

function iconImage() {
  const file = path.join(__dirname, '..', '..', 'build', 'icons', process.platform === 'darwin' ? '16x16.png' : '32x32.png');
  const img = nativeImage.createFromPath(file);
  return img.isEmpty() ? img : img.resize({ width: 16, height: 16 });
}

/**
 * @param {{ show: () => void, isPaused: () => boolean, setPaused: (v: boolean) => void }} actions
 */
function enableTray(actions) {
  if (tray) return refreshTray(actions);
  tray = new Tray(iconImage());
  tray.setToolTip('FunPrinting Partner');
  tray.on('click', () => actions.show());
  refreshTray(actions);
}

function refreshTray(actions) {
  if (!tray) return;
  const paused = actions.isPaused();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open FunPrinting Partner', click: () => actions.show() },
      { type: 'separator' },
      { label: paused ? 'Resume printing' : 'Pause printing', click: () => actions.setPaused(!paused) },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
}

function disableTray() {
  if (tray) tray.destroy();
  tray = null;
}

module.exports = { enableTray, refreshTray, disableTray };
