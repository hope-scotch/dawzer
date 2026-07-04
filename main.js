const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

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
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

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

// Save a project file (.dawzer) — audio + arrangement bundled together.
ipcMain.handle('save-project', async (event, { defaultName, data }) => {
  const docs = app.getPath('documents');
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save project',
    defaultPath: path.join(docs, defaultName || 'Untitled.dawzer'),
    filters: [{ name: 'Dawzer Project', extensions: ['dawzer'] }]
  });
  if (canceled || !filePath) return { ok: false };
  fs.writeFileSync(filePath, Buffer.from(data));
  return { ok: true, filePath, name: path.basename(filePath) };
});

// Open a project file (.dawzer).
ipcMain.handle('open-project', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Open project',
    properties: ['openFile'],
    filters: [{ name: 'Dawzer Project', extensions: ['dawzer'] }]
  });
  if (canceled || !filePaths.length) return { ok: false };
  const data = fs.readFileSync(filePaths[0]);
  return { ok: true, filePath: filePaths[0], name: path.basename(filePaths[0]), data: data.buffer };
});
