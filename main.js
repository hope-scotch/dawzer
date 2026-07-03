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
