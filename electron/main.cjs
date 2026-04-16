const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');
const process = require('node:process');
const fs = require('node:fs');

const SERVICE_PORT = Number(process.env.LINGUAFIX_PORT || 8787);
const SERVICE_URL = `http://127.0.0.1:${SERVICE_PORT}`;
const QUICK_TRANSLATE_HOTKEY = 'CommandOrControl+Shift+L';

let mainWindow = null;
let popupWindow = null;
let serviceProcess = null;

function isDev() {
  return !app.isPackaged;
}

function resolveRustCommand() {
  if (isDev()) {
    return {
      command: 'cargo',
      args: ['run', '--quiet'],
      cwd: app.getAppPath(),
    };
  }

  const candidates = [
    path.join(process.resourcesPath, 'bin', 'linguafix'),
    path.join(process.resourcesPath, 'linguafix'),
    path.join(app.getAppPath(), 'target', 'release', 'linguafix'),
  ];

  const binaryPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!binaryPath) {
    throw new Error('Rust service binary was not found.');
  }

  return {
    command: binaryPath,
    args: [],
    cwd: path.dirname(binaryPath),
  };
}

function startRustService() {
  if (serviceProcess) {
    return;
  }

  const service = resolveRustCommand();
  serviceProcess = spawn(service.command, service.args, {
    cwd: service.cwd,
    env: {
      ...process.env,
      LINGUAFIX_PORT: String(SERVICE_PORT),
    },
    stdio: 'inherit',
  });

  serviceProcess.on('exit', () => {
    serviceProcess = null;
  });
}

async function waitForService() {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 30000) {
    try {
      const response = await fetch(`${SERVICE_URL}/health`);
      if (response.ok) {
        return;
      }
    } catch (_) {
      // The service is still starting up.
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error('Rust service did not start within 30 seconds.');
}

async function callService(pathname, options = {}) {
  const response = await fetch(`${SERVICE_URL}${pathname}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || 'Service request failed.');
  }

  return payload;
}

function rendererUrl(search = '') {
  const normalizedSearch = search ? `?${new URLSearchParams(search).toString()}` : '';

  if (isDev()) {
    return `http://127.0.0.1:5173/${normalizedSearch}`;
  }

  return {
    filePath: path.join(app.getAppPath(), 'frontend', 'dist', 'index.html'),
    search: normalizedSearch,
  };
}

function loadRenderer(window, search = '') {
  const target = rendererUrl(search);

  if (typeof target === 'string') {
    window.loadURL(target);
    return;
  }

  window.loadFile(target.filePath, { search: target.search });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 860,
    minWidth: 980,
    minHeight: 720,
    title: 'LinguaFix',
    backgroundColor: '#132227',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  loadRenderer(mainWindow);

  if (isDev()) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function createPopupWindow() {
  if (popupWindow && !popupWindow.isDestroyed()) {
    return popupWindow;
  }

  popupWindow = new BrowserWindow({
    width: 460,
    height: 520,
    minWidth: 420,
    minHeight: 460,
    show: false,
    title: 'Quick Translate',
    backgroundColor: '#132227',
    autoHideMenuBar: true,
    maximizable: false,
    minimizable: false,
    resizable: true,
    fullscreenable: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  loadRenderer(popupWindow, { popup: 'quick-translate' });

  popupWindow.on('blur', () => {
    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.hide();
    }
  });

  popupWindow.on('closed', () => {
    popupWindow = null;
  });

  return popupWindow;
}

function showQuickTranslatePopup() {
  const window = createPopupWindow();

  if (!window.isVisible()) {
    window.show();
  }

  window.focus();
}

function registerGlobalHotkeys() {
  globalShortcut.register(QUICK_TRANSLATE_HOTKEY, () => {
    showQuickTranslatePopup();
  });
}

ipcMain.handle('linguafix:get-config', async () => callService('/config'));
ipcMain.handle('linguafix:save-config', async (_event, config) =>
  callService('/config', {
    method: 'PUT',
    body: JSON.stringify(config),
  }),
);
ipcMain.handle('linguafix:process-text', async (_event, request) =>
  callService('/api/process', {
    method: 'POST',
    body: JSON.stringify(request),
  }),
);
ipcMain.handle('linguafix:hide-popup', async () => {
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.hide();
  }
});

app.whenReady().then(async () => {
  startRustService();
  await waitForService();
  createWindow();
  createPopupWindow();
  registerGlobalHotkeys();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  globalShortcut.unregisterAll();

  if (serviceProcess) {
    serviceProcess.kill();
  }
});
