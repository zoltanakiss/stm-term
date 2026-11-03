'use strict';
// Thin desktop shell: makes sure the daemon is running (detached, so closing the window never
// kills your agents), then shows the web UI.
const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const PORT = process.env.STM_PORT || 4790;
const URL = `http://127.0.0.1:${PORT}/`;
const ROOT = path.join(__dirname, '..');

const healthy = () => new Promise((resolve) => {
  http.get(`${URL}api/health`, (res) => { res.resume(); resolve(res.statusCode === 200); }).on('error', () => resolve(false));
});

async function ensureDaemon() {
  if (await healthy()) return;
  const logDir = path.join(os.homedir(), '.stm-term');
  fs.mkdirSync(logDir, { recursive: true });
  const log = fs.openSync(path.join(logDir, 'daemon.log'), 'a');
  // Login shell so the daemon (and every tab) gets your real PATH even when launched from Finder.
  const child = spawn('/bin/zsh', ['-lc', `cd ${JSON.stringify(ROOT)} && exec node --disable-warning=ExperimentalWarning src/server.js`], {
    detached: true, stdio: ['ignore', log, log], env: { ...process.env, STM_PORT: String(PORT) },
  });
  child.unref();
  for (let i = 0; i < 50; i++) { if (await healthy()) return; await new Promise((r) => setTimeout(r, 200)); }
  throw new Error('daemon did not start; see ~/.stm-term/daemon.log');
}

app.whenReady().then(async () => {
  await ensureDaemon();
  const win = new BrowserWindow({
    width: 1440, height: 900, show: process.env.STM_HIDDEN !== '1', // hidden for agent QA backgroundColor: '#16171d', title: 'STM Term', titleBarStyle: 'default',
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  // Never navigate away from the app (e.g. to a file dropped outside the terminal area).
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(URL)) e.preventDefault(); });
  win.loadURL(URL);
});
app.on('window-all-closed', () => app.quit());
