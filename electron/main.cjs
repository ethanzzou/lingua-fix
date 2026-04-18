const { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Notification, screen } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { promisify } = require('node:util');
const process = require('node:process');
const fs = require('node:fs');

const SERVICE_PORT = Number(process.env.LINGUAFIX_PORT || 8787);
const SERVICE_URL = `http://127.0.0.1:${SERVICE_PORT}`;
const IN_PLACE_TRANSLATE_HOTKEY = 'Control+Shift+T';
const QUICK_TRANSLATE_POPUP_HOTKEY = 'Control+Shift+L';
const APP_ROLE = process.env.LINGUAFIX_APP_ROLE === 'popup-helper' ? 'popup-helper' : 'main';
const execFile = promisify(require('node:child_process').execFile);
const AUTOMATION_SHORTCUT_SETTLE_DELAY_MS = 220;
const AUTOMATION_COPY_POLL_ATTEMPTS = 15;
const AUTOMATION_COPY_POLL_DELAY_MS = 100;
const AUTOMATION_PASTE_RESTORE_DELAY_MS = 180;

let mainWindow = null;
let popupWindow = null;
let popupIgnoreBlurUntil = 0;
let popupHelperProcess = null;
let serviceProcess = null;
let ownsServiceProcess = false;
let isQuitting = false;
let isRunningSelectionReplace = false;

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

function buildHistoryPath(query = {}) {
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') {
      continue;
    }

    searchParams.set(key, String(value));
  }

  const suffix = searchParams.toString();
  return suffix ? `/api/history?${suffix}` : '/api/history';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function notify(message) {
  if (Notification.isSupported()) {
    new Notification({
      title: 'LinguaFix',
      body: message,
    }).show();
    return;
  }

  console.log(`[LinguaFix] ${message}`);
}

function appleScriptQuoted(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

async function runAppleScript(script) {
  const { stdout } = await execFile('osascript', ['-e', script]);
  return stdout.trim();
}

async function triggerMacSelectionShortcut(key) {
  await runAppleScript(`
    tell application "System Events"
      keystroke "${key}" using command down
    end tell
  `);
}

async function getFrontmostMacAppName() {
  return runAppleScript(`
    tell application "System Events"
      name of first application process whose frontmost is true
    end tell
  `);
}

async function activateMacApp(appName) {
  if (!appName) {
    return;
  }

  await runAppleScript(`
    tell application ${appleScriptQuoted(appName)}
      activate
    end tell
  `);
}

async function readSelectedTextViaMacAccessibility(appName) {
  if (!appName) {
    return '';
  }

  return runAppleScript(`
    tell application "System Events"
      tell application process ${appleScriptQuoted(appName)}
        try
          set focusedElement to value of attribute "AXFocusedUIElement"
          set selectedText to value of attribute "AXSelectedText" of focusedElement

          if selectedText is missing value then
            return ""
          end if

          return selectedText
        on error
          return ""
        end try
      end tell
    end tell
  `);
}

async function readSelectedRangeViaMacAccessibility(appName) {
  if (!appName) {
    return null;
  }

  const rawRange = await runAppleScript(`
    tell application "System Events"
      tell application process ${appleScriptQuoted(appName)}
        try
          set focusedElement to value of attribute "AXFocusedUIElement"
          set selectedRange to value of attribute "AXSelectedTextRange" of focusedElement

          if selectedRange is missing value then
            return ""
          end if

          return (item 1 of selectedRange as string) & "," & (item 2 of selectedRange as string)
        on error
          return ""
        end try
      end tell
    end tell
  `);

  if (!rawRange) {
    return null;
  }

  const [startText, lengthText] = rawRange.split(',');
  const start = Number.parseInt(startText ?? '', 10);
  const length = Number.parseInt(lengthText ?? '', 10);

  if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length < 0) {
    return null;
  }

  return { start, length };
}

async function readSelectedTextFromMacClipboard(clipboardBackup, appName) {
  const clipboardSentinel = `__LINGUAFIX_SELECTION__${Date.now()}__`;

  clipboard.writeText(clipboardSentinel);
  await activateMacApp(appName);
  await sleep(AUTOMATION_SHORTCUT_SETTLE_DELAY_MS);
  await triggerMacSelectionShortcut('c');

  let selectedText = '';

  for (let attempt = 0; attempt < AUTOMATION_COPY_POLL_ATTEMPTS; attempt += 1) {
    await sleep(AUTOMATION_COPY_POLL_DELAY_MS);
    selectedText = clipboard.readText();

    if (selectedText !== clipboardSentinel) {
      return {
        clipboardBackup,
        selectedText,
      };
    }
  }

  clipboard.writeText(clipboardBackup);

  return {
    clipboardBackup,
    selectedText: '',
  };
}

async function readSelectedTextFromMacApp() {
  const clipboardBackup = clipboard.readText();
  const frontmostAppName = await getFrontmostMacAppName();
  const accessibilitySelectedText = await readSelectedTextViaMacAccessibility(frontmostAppName);
  const accessibilitySelectedRange = await readSelectedRangeViaMacAccessibility(frontmostAppName);

  if (accessibilitySelectedText.trim()) {
    return {
      clipboardBackup,
      frontmostAppName,
      selectedText: accessibilitySelectedText,
      selectedRange: accessibilitySelectedRange,
    };
  }

  const clipboardSelectionState = await readSelectedTextFromMacClipboard(
    clipboardBackup,
    frontmostAppName,
  );
  return {
    ...clipboardSelectionState,
    frontmostAppName,
    selectedRange: accessibilitySelectedRange,
  };
}

async function replaceSelectionViaMacAccessibility(text, appName, selectedRange) {
  if (!appName || !selectedRange || selectedRange.length <= 0) {
    return false;
  }

  const rawResult = await runAppleScript(`
    tell application "System Events"
      tell application process ${appleScriptQuoted(appName)}
        try
          set focusedElement to value of attribute "AXFocusedUIElement"
          set currentValue to value of attribute "AXValue" of focusedElement

          if currentValue is missing value then
            return "false"
          end if

          set rangeStart to ${selectedRange.start}
          set rangeLength to ${selectedRange.length}
          set replacementText to ${appleScriptQuoted(text)}
          set currentLength to length of currentValue
          set prefixText to ""
          set suffixText to ""

          if rangeStart > 0 then
            set prefixText to text 1 thru rangeStart of currentValue
          end if

          if (rangeStart + rangeLength) < currentLength then
            set suffixText to text (rangeStart + rangeLength + 1) thru -1 of currentValue
          end if

          set value of attribute "AXValue" of focusedElement to (prefixText & replacementText & suffixText)

          try
            set value of attribute "AXSelectedTextRange" of focusedElement to {(rangeStart + (length of replacementText)), 0}
          end try

          return "true"
        on error
          return "false"
        end try
      end tell
    end tell
  `);

  return rawResult === 'true';
}

async function replaceSelectionInMacApp(text, clipboardBackup, frontmostAppName, selectedRange) {
  const replacedViaAccessibility = await replaceSelectionViaMacAccessibility(
    text,
    frontmostAppName,
    selectedRange,
  );

  if (replacedViaAccessibility) {
    return;
  }

  clipboard.writeText(text);
  await sleep(AUTOMATION_SHORTCUT_SETTLE_DELAY_MS);
  await triggerMacSelectionShortcut('v');
  await sleep(AUTOMATION_PASTE_RESTORE_DELAY_MS);
  clipboard.writeText(clipboardBackup);
}

async function tryProcessSelectedTextInPlace() {
  if (process.platform !== 'darwin') {
    notify('In-place selection replace is currently supported on macOS only.');
    return true;
  }

  if (isRunningSelectionReplace) {
    return true;
  }

  isRunningSelectionReplace = true;
  let clipboardBackup = null;

  try {
    const selectionState = await readSelectedTextFromMacApp();
    clipboardBackup = selectionState.clipboardBackup;
    const { frontmostAppName, selectedRange, selectedText } = selectionState;

    if (!selectedText.trim()) {
      clipboard.writeText(clipboardBackup);
      notify('Could not read the current text selection.');
      return true;
    }

    const response = await callService('/api/process', {
      method: 'POST',
      body: JSON.stringify({
        task: 'auto_process',
        text: selectedText,
      }),
    });

    await replaceSelectionInMacApp(
      response.output,
      clipboardBackup,
      frontmostAppName,
      selectedRange,
    );
    return true;
  } catch (error) {
    if (typeof clipboardBackup === 'string') {
      clipboard.writeText(clipboardBackup);
    }

    notify(
      error instanceof Error ? error.message : 'Could not process the selected text.',
    );
    return true;
  } finally {
    isRunningSelectionReplace = false;
  }
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

function showQuickTranslatePopup() {
  const window = createPopupWindow();

  if (window.isMinimized()) {
    window.restore();
  }

  positionPopupWindowNearCurrentDisplay(window);
  popupIgnoreBlurUntil = Date.now() + 1000;
  window.show();
  window.moveTop();

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
  globalShortcut.register(IN_PLACE_TRANSLATE_HOTKEY, async () => {
    await tryProcessSelectedTextInPlace();
  });

  globalShortcut.register(QUICK_TRANSLATE_POPUP_HOTKEY, () => {
    toggleQuickTranslatePopup();
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
ipcMain.handle('linguafix:get-history', async (_event, query) => callService(buildHistoryPath(query)));
ipcMain.handle('linguafix:delete-history-record', async (_event, id) =>
  callService(`/api/history/${id}`, {
    method: 'DELETE',
  }),
);
ipcMain.handle('linguafix:update-history-record-tags', async (_event, id, tags) =>
  callService(`/api/history/${id}/tags`, {
    method: 'PUT',
    body: JSON.stringify({ tags }),
  }),
);
ipcMain.handle('linguafix:clear-history', async () =>
  callService('/api/history', {
    method: 'DELETE',
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
