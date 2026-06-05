'use strict';

const { autoUpdater } = require('electron-updater');
const { ipcMain } = require('electron');

/**
 * Wire up auto-updates. Checks GitHub Releases (per the `publish` config in
 * package.json) on launch, downloads any newer version in the background, and
 * tells the renderer when one is ready. The update installs on next quit
 * (or immediately via the 'update:install' IPC).
 *
 * No-ops in dev (the app must be packaged for updates to apply).
 * @param {() => Electron.BrowserWindow | null} getWindow
 */
function initAutoUpdates(getWindow) {
  const tell = (payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('update:status', payload);
  };

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) =>
    tell({ state: 'available', version: info.version })
  );
  autoUpdater.on('update-downloaded', (info) =>
    tell({ state: 'downloaded', version: info.version })
  );
  autoUpdater.on('error', (err) =>
    tell({ state: 'error', message: err?.message || String(err) })
  );

  // Renderer asks to restart and apply a downloaded update now.
  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall();
  });

  // Don't crash the app if there's no network or no publish config yet.
  autoUpdater.checkForUpdates().catch((err) =>
    tell({ state: 'error', message: err?.message || String(err) })
  );
}

module.exports = { initAutoUpdates };
