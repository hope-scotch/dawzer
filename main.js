const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;
let forceClose = false;
let pendingOpenPath = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    title: 'Dawzer',
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#222d30',
    webPreferences: {
      // Local personal app: enable Node in the renderer so we can require
      // the MP3 encoder and save files directly. No remote content is loaded.
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.setMenuBarVisibility(false);

  // If launched by double-clicking a .dz, open it once the UI is ready.
  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingOpenPath) { readAndSendProject(pendingOpenPath); pendingOpenPath = null; }
  });

  // Ask the renderer before actually closing (for unsaved-changes warning).
  mainWindow.on('close', (e) => {
    if (forceClose) return;
    e.preventDefault();
    mainWindow.webContents.send('app-close-request');
  });
}

// Renderer decided it's ok to close.
ipcMain.on('do-close', () => { forceClose = true; if (mainWindow) mainWindow.close(); });

// Three-way unsaved-changes prompt.
ipcMain.handle('confirm-unsaved', async () => {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0, cancelId: 2,
    title: 'Unsaved changes',
    message: 'You have unsaved changes.',
    detail: 'Do you want to save your project before continuing?'
  });
  return response; // 0 = Save, 1 = Don't Save, 2 = Cancel
});

function winAlive() { return mainWindow && !mainWindow.isDestroyed(); }
function readAndSendProject(p) {
  try {
    if (!winAlive()) { pendingOpenPath = p; return; }
    const data = fs.readFileSync(p);
    mainWindow.webContents.send('open-project-file', { name: path.basename(p), data: data.buffer });
  } catch (e) { console.error('open path', e); }
}
function openPath(p) {
  if (!p) return;
  if (winAlive() && !mainWindow.webContents.isLoading()) readAndSendProject(p);
  else { pendingOpenPath = p; if (app.isReady() && !winAlive()) createWindow(); }
}
// macOS: double-clicking a .dz sends an open-file event.
app.on('open-file', (e, p) => { e.preventDefault(); openPath(p); });
// Windows/Linux: the file arrives as a launch argument.
{ const a = process.argv.find((x) => x && x.toLowerCase().endsWith('.dz')); if (a) pendingOpenPath = a; }

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (event, argv) => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
    const p = argv.find((x) => x && x.toLowerCase().endsWith('.dz'));
    if (p) openPath(p);
  });
  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Renderer asks main to pop a native "save file" dialog and write bytes to disk.
ipcMain.handle('save-file', async (event, { defaultName, data }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save recording',
    defaultPath: defaultName
  });
  if (canceled || !filePath) return { ok: false };
  fs.writeFileSync(filePath, Buffer.from(data));
  return { ok: true, filePath };
});

// Renderer asks main to pick a backing track file.
ipcMain.handle('open-audio', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a backing track',
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'flac'] }]
  });
  if (canceled || !filePaths.length) return { ok: false };
  const filePath = filePaths[0];
  const data = fs.readFileSync(filePath);
  return { ok: true, filePath, name: path.basename(filePath), data: data.buffer };
});

// Base library folder, GarageBand-style: Documents/Dawzer, with a subfolder per day.
function dawzerDir(withDate) {
  const base = path.join(app.getPath('documents'), 'Dawzer');
  const dir = withDate ? path.join(base, new Date().toISOString().slice(0, 10)) : base;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

// Save a project file (.dz) — audio + arrangement bundled together.
ipcMain.handle('save-project', async (event, { defaultName, data }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save project',
    defaultPath: path.join(dawzerDir(true), defaultName || 'Untitled.dz'),
    filters: [{ name: 'Dawzer Project', extensions: ['dz'] }]
  });
  if (canceled || !filePath) return { ok: false };
  fs.writeFileSync(filePath, Buffer.from(data));
  return { ok: true, filePath, name: path.basename(filePath) };
});

// Open a project file (.dz).
ipcMain.handle('open-project', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Open project',
    defaultPath: dawzerDir(false),
    properties: ['openFile'],
    filters: [{ name: 'Dawzer Project', extensions: ['dz'] }]
  });
  if (canceled || !filePaths.length) return { ok: false };
  const data = fs.readFileSync(filePaths[0]);
  return { ok: true, filePath: filePaths[0], name: path.basename(filePaths[0]), data: data.buffer };
});
