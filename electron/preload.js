'use strict';
// Expose only one thing to the page: the real filesystem path of a dropped File
// (Electron removed File.path; webUtils is the supported replacement).
const { contextBridge, webUtils } = require('electron');
contextBridge.exposeInMainWorld('stmNative', {
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || null; } catch { return null; } },
});
