const { app, BrowserWindow, clipboard, globalShortcut, ipcMain, screen } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');
const process = require('node:process');
const fs = require('node:fs');

const SERVICE_PORT = Number(process.env.LINGUAFIX_PORT || 8787);
const SERVICE_URL = `http://127.0.0.1:${SERVICE_PORT}`;
const QUICK_TRANSLATE_HOTKEY = 'Control+Shift+L';
const APP_ROLE = process.env.LINGUAFIX_APP_ROLE === 'popup-helper' ? 'popup-helper' : 'main';

let mainWindow = null;
let popupWindow = null;
let popupIgnoreBlurUntil = 0;
let popupHelperProcess = null;
let serviceProcess = null;
let ownsServiceProcess = false;
let isQuitting = false;

function isDev() {
  return !app.isPackaged;
}

function isPopupHelperProcess() {
  return APP_ROLE === 'popup-helper';
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

async function isServiceHealthy() {
  try {
    const response = await fetch(`${SERVICE_URL}/health`);
    return response.ok;
  } catch (_) {
    return false;
  }
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
  ownsServiceProcess = true;

  serviceProcess.on('exit', () => {
    serviceProcess = null;
    ownsServiceProcess = false;
  });
}

async function waitForService() {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 30000) {
    if (await isServiceHealthy()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error('Rust service did not start within 30 seconds.');
}

async function ensureRustService() {
  if (await isServiceHealthy()) {
    return;
  }

  startRustService();
  await waitForService();
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

function resolvePopupHelperLaunch() {
  if (isDev()) {
    return {
      command: process.execPath,
      args: [app.getAppPath()],
      cwd: app.getAppPath(),
    };
  }

  return {
    command: process.execPath,
    args: [],
    cwd: path.dirname(process.execPath),
  };
}

function startPopupHelperProcess() {
  if (isPopupHelperProcess()) {
    return;
  }

  if (popupHelperProcess && !popupHelperProcess.killed) {
    return;
  }

  const helper = resolvePopupHelperLaunch();
  popupHelperProcess = spawn(helper.command, helper.args, {
    cwd: helper.cwd,
    env: {
      ...process.env,
      LINGUAFIX_APP_ROLE: 'popup-helper',
      LINGUAFIX_PORT: String(SERVICE_PORT),
    },
    stdio: isDev() ? 'inherit' : 'ignore',
  });

  popupHelperProcess.on('exit', () => {
    popupHelperProcess = null;

    if (!isQuitting) {
      setTimeout(() => {
        if (!isQuitting) {
          startPopupHelperProcess();
        }
      }, 1000);
    }
  });
}

function stopPopupHelperProcess() {
  if (popupHelperProcess && !popupHelperProcess.killed) {
    popupHelperProcess.kill();
  }

  popupHelperProcess = null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 860,
    minWidth: 980,
    minHeight: 720,
    title: 'LinguaFix',
    backgroundColor: '#efe7d5',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function positionPopupWindowNearCurrentDisplay(window) {
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const workArea = display.workArea;
  const [windowWidth, windowHeight] = window.getSize();
  const x = Math.round(workArea.x + (workArea.width - windowWidth) / 2);
  const y = Math.round(workArea.y + Math.max(48, (workArea.height - windowHeight) / 5));

  window.setPosition(x, y);
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
    backgroundColor: '#efe7d5',
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset',
          type: 'panel',
        }
      : {}),
    acceptFirstMouse: true,
    autoHideMenuBar: true,
    maximizable: false,
    minimizable: false,
    resizable: true,
    fullscreenable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.platform === 'darwin') {
    popupWindow.setHiddenInMissionControl(true);
    popupWindow.setAlwaysOnTop(true, 'floating');
    popupWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
  } else {
    popupWindow.setAlwaysOnTop(true);
  }

  loadRenderer(popupWindow, { popup: 'quick-translate' });

  popupWindow.on('blur', () => {
    if (Date.now() < popupIgnoreBlurUntil) {
      return;
    }

    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.hide();
    }
  });

  popupWindow.on('closed', () => {
    popupWindow = null;
    popupIgnoreBlurUntil = 0;
  });

  return popupWindow;
}

function hideQuickTranslatePopup() {
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.hide();
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'ignore',
      ...options,
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Command exited with code ${code ?? 'unknown'}.`));
    });
  });
}

async function triggerSystemCopyShortcut() {
  if (process.platform === 'darwin') {
    await runCommand('osascript', [
      '-e',
      'tell application "System Events" to keystroke "c" using {command down}',
    ]);
    return;
  }

  if (process.platform === 'win32') {
    await runCommand('powershell.exe', [
      '-NoProfile',
      '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^c")',
    ]);
    return;
  }

  await runCommand('xdotool', ['key', '--clearmodifiers', 'ctrl+c']);
}

async function readSelectedTextOrClipboard() {
  const clipboardBefore = clipboard.readText();

  try {
    await triggerSystemCopyShortcut();
    await new Promise((resolve) => setTimeout(resolve, 180));

    const selectedText = clipboard.readText().trim();

    if (selectedText) {
      if (selectedText !== clipboardBefore) {
        clipboard.writeText(clipboardBefore);
      }

      return selectedText;
    }
  } catch (_) {
    // Fall back to the existing clipboard contents.
  }

  return clipboardBefore.trim();
}

function showQuickTranslatePopup(initialText = '') {
  const window = createPopupWindow();

  if (window.isMinimized()) {
    window.restore();
  }

  positionPopupWindowNearCurrentDisplay(window);
  popupIgnoreBlurUntil = Date.now() + 1000;
  window.show();
  window.moveTop();
  window.webContents.send('linguafix:populate-quick-translate-input', initialText);

  if (process.platform !== 'darwin') {
    window.focus();
  }
}

function toggleQuickTranslatePopup() {
  const window = createPopupWindow();

  if (window.isVisible()) {
    popupIgnoreBlurUntil = 0;
    hideQuickTranslatePopup();
    return;
  }

  showQuickTranslatePopup();
}

function registerGlobalHotkeys() {
  globalShortcut.register(QUICK_TRANSLATE_HOTKEY, async () => {
    const window = createPopupWindow();

    if (window.isVisible()) {
      popupIgnoreBlurUntil = 0;
      hideQuickTranslatePopup();
      return;
    }

    const initialText = await readSelectedTextOrClipboard();
    showQuickTranslatePopup(initialText);
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
  hideQuickTranslatePopup();
});

app.whenReady().then(async () => {
  if (isPopupHelperProcess() && process.platform === 'darwin') {
    app.setActivationPolicy('accessory');
  }

  await ensureRustService();

  if (isPopupHelperProcess()) {
    createPopupWindow();
    registerGlobalHotkeys();
    return;
  }

  createWindow();
  startPopupHelperProcess();

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
    }

    startPopupHelperProcess();
  });
});

app.on('window-all-closed', () => {
  if (isPopupHelperProcess()) {
    return;
  }

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  globalShortcut.unregisterAll();

  if (!isPopupHelperProcess()) {
    stopPopupHelperProcess();
  }

  if (ownsServiceProcess && serviceProcess) {
    serviceProcess.kill();
  }
});
