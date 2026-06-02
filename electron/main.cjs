const { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, nativeImage, Notification, screen, Tray } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { promisify } = require('node:util');
const process = require('node:process');
const fs = require('node:fs');

const SERVICE_PORT = Number(process.env.LINGUAFIX_PORT || 8787);
const SERVICE_URL = `http://127.0.0.1:${SERVICE_PORT}`;
const IN_PLACE_TRANSLATE_HOTKEY = 'Control+Shift+T';
const QUICK_TRANSLATE_POPUP_HOTKEY = 'Control+Shift+L';
const SELECTION_TO_CHINESE_POPUP_HOTKEY = 'Control+Shift+R';
const APP_ROLE = process.env.LINGUAFIX_APP_ROLE === 'popup-helper' ? 'popup-helper' : 'main';
const WINDOW_BACKGROUND_COLOR = '#f5f6f8';
const execFile = promisify(require('node:child_process').execFile);
const AUTOMATION_COPY_POLL_ATTEMPTS = 10;
const AUTOMATION_COPY_POLL_DELAY_MS = 30;
const AUTOMATION_PASTE_RESTORE_DELAY_MS = 80;
const SELECTION_DRAG_THRESHOLD_PX = 6;
const SELECTION_CAPTURE_DEBOUNCE_MS = 250;
const SELECTION_MIN_TEXT_LENGTH = 2;
const SELECTION_ICON_SIZE = 28;
const SELECTION_ICON_TIMEOUT_MS = 4000;
const SELECTION_CONFIG_POLL_INTERVAL_MS = 4000;
const SELECTION_ACCESSIBILITY_NOTICE_INTERVAL_MS = 60000;

let mainWindow = null;
let popupWindow = null;
let popupIgnoreBlurUntil = 0;
let popupHelperProcess = null;
let serviceProcess = null;
let ownsServiceProcess = false;
let isQuitting = false;
let isRunningSelectionWorkflow = false;
let statusBarItem = null;
let selectionIconWindow = null;
let uIOhook = null;
let selectionWatcherRunning = false;
let selectionPopupEnabled = false;
let selectionConfigPollTimer = null;
let selectionMouseDownPoint = null;
let selectionCaptureTimer = null;
let isCapturingSelection = false;
let pendingSelectionText = '';
let selectionIconDismissTimer = null;
let selectionAccessibilityNoticeAt = 0;

function isDev() {
  return !app.isPackaged;
}

function shouldOpenDevTools() {
  return isDev() && process.env.LINGUAFIX_OPEN_DEVTOOLS === '1';
}

function shouldUseDevServer() {
  return isDev() && process.env.LINGUAFIX_USE_DEV_SERVER === '1';
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
  await ensureRustService();

  const response = await fetch(`${SERVICE_URL}${pathname}`, {
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });

  const rawBody = await response.text();
  const contentType = response.headers.get('content-type') || '';
  let payload = null;

  if (rawBody) {
    if (contentType.includes('application/json')) {
      try {
        payload = JSON.parse(rawBody);
      } catch (error) {
        throw new Error(
          `Service returned invalid JSON (${response.status} ${response.statusText}).`,
        );
      }
    } else {
      try {
        payload = JSON.parse(rawBody);
      } catch (_) {
        payload = { error: rawBody.trim() };
      }
    }
  } else {
    payload = {};
  }

  if (!response.ok) {
    const message =
      typeof payload?.error === 'string' && payload.error.trim()
        ? payload.error.trim()
        : `Service request failed (${response.status} ${response.statusText}).`;

    throw new Error(message);
  }

  if (!contentType.includes('application/json') && rawBody) {
    throw new Error(
      `Service returned an unexpected response type (${response.status} ${response.statusText}).`,
    );
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

function parseMacAppIdentity(rawIdentity) {
  const [name = '', bundleIdentifier = '', pidText = ''] = rawIdentity.split('\n');
  const pid = Number.parseInt(pidText, 10);

  return {
    name,
    bundleIdentifier: bundleIdentifier === 'missing value' ? '' : bundleIdentifier,
    pid: Number.isInteger(pid) ? pid : null,
  };
}

async function getFrontmostMacApp() {
  const rawIdentity = await runAppleScript(`
    use framework "AppKit"
    set frontApp to current application's NSWorkspace's sharedWorkspace()'s frontmostApplication()
    set processName to frontApp's localizedName() as text
    set processBundleIdentifier to frontApp's bundleIdentifier() as text
    set processId to frontApp's processIdentifier() as integer
    return processName & linefeed & processBundleIdentifier & linefeed & (processId as text)
  `);

  return parseMacAppIdentity(rawIdentity);
}

function macAppProcessLookupScript(macApp) {
  if (!macApp?.pid && !macApp?.bundleIdentifier && !macApp?.name) {
    return '';
  }

  return `
    set targetProcess to missing value
    repeat with candidateProcess in application processes
      try
        if ${macApp?.pid ? `(unix id of candidateProcess as integer) is ${macApp.pid}` : 'false'} then
          set targetProcess to candidateProcess
          exit repeat
        end if
      end try
    end repeat
    if targetProcess is missing value then
      repeat with candidateProcess in application processes
        try
          if ${macApp?.bundleIdentifier ? `(bundle identifier of candidateProcess as string) is ${appleScriptQuoted(macApp.bundleIdentifier)}` : 'false'} then
            set targetProcess to candidateProcess
            exit repeat
          end if
        end try
      end repeat
    end if
    if targetProcess is missing value then
      repeat with candidateProcess in application processes
        try
          if ${macApp?.name ? `(name of candidateProcess as string) is ${appleScriptQuoted(macApp.name)}` : 'false'} then
            set targetProcess to candidateProcess
            exit repeat
          end if
        end try
      end repeat
    end if
  `;
}

async function readSelectedTextFromMacClipboard(clipboardBackup) {
  const clipboardSentinel = `__LINGUAFIX_SELECTION__${Date.now()}__`;

  clipboard.writeText(clipboardSentinel);
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
  const frontmostApp = await getFrontmostMacApp();
  const clipboardSelectionState = await readSelectedTextFromMacClipboard(clipboardBackup);

  return {
    ...clipboardSelectionState,
    frontmostApp,
  };
}

async function replaceSelectionInMacApp(text, clipboardBackup, frontmostApp) {
  clipboard.writeText(text);
  const processLookup = macAppProcessLookupScript(frontmostApp);

  if (processLookup) {
    await runAppleScript(`
      tell application "System Events"
        try
          ${processLookup}
          if targetProcess is not missing value then
            set frontmost of targetProcess to true
          end if
        end try
        keystroke "v" using command down
      end tell
    `);
  } else {
    await triggerMacSelectionShortcut('v');
  }

  await sleep(AUTOMATION_PASTE_RESTORE_DELAY_MS);
  clipboard.writeText(clipboardBackup);
}

async function tryProcessSelectedTextInPlace() {
  if (process.platform !== 'darwin') {
    notify('In-place selection replace is currently supported on macOS only.');
    return true;
  }

  if (isRunningSelectionWorkflow) {
    return true;
  }

  isRunningSelectionWorkflow = true;
  let clipboardBackup = null;

  try {
    const selectionState = await readSelectedTextFromMacApp();
    clipboardBackup = selectionState.clipboardBackup;
    const { frontmostApp, selectedText } = selectionState;

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
      frontmostApp,
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
    isRunningSelectionWorkflow = false;
  }
}

function rendererUrl(search = '') {
  const normalizedSearch = search ? `?${new URLSearchParams(search).toString()}` : '';

  if (shouldUseDevServer()) {
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
    backgroundColor: WINDOW_BACKGROUND_COLOR,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  loadRenderer(mainWindow);

  if (shouldOpenDevTools()) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
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
    backgroundColor: WINDOW_BACKGROUND_COLOR,
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

function sendPopupSession(session) {
  const window = createPopupWindow();
  const dispatch = () => {
    if (!window.isDestroyed()) {
      window.webContents.send('linguafix:popup-session', session);
    }
  };

  if (window.webContents.isLoading()) {
    window.webContents.once('did-finish-load', dispatch);
    return;
  }

  dispatch();
}

function showQuickTranslatePopup(session = { mode: 'manual' }) {
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

  sendPopupSession(session);
}

function showSelectedTextTranslationPopup(sourceText, output) {
  showQuickTranslatePopup({
    mode: 'selection_translation',
    input: output,
    source_text: sourceText,
  });
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

async function tryTranslateSelectedTextToChineseInPopup() {
  if (process.platform !== 'darwin') {
    notify('Selection translation popup is currently supported on macOS only.');
    return true;
  }

  if (isRunningSelectionWorkflow) {
    return true;
  }

  isRunningSelectionWorkflow = true;
  let clipboardBackup = null;

  try {
    const selectionState = await readSelectedTextFromMacApp();
    clipboardBackup = selectionState.clipboardBackup;
    const selectedText = selectionState.selectedText.trim();

    if (!selectedText) {
      clipboard.writeText(clipboardBackup);
      notify('Could not read the current text selection.');
      return true;
    }

    const response = await callService('/api/process', {
      method: 'POST',
      body: JSON.stringify({
        task: 'translate_english_to_chinese',
        text: selectedText,
      }),
    });

    clipboard.writeText(clipboardBackup);
    showSelectedTextTranslationPopup(selectedText, response.output);
    return true;
  } catch (error) {
    if (typeof clipboardBackup === 'string') {
      clipboard.writeText(clipboardBackup);
    }

    notify(
      error instanceof Error ? error.message : 'Could not translate the selected text.',
    );
    return true;
  } finally {
    isRunningSelectionWorkflow = false;
  }
}

function selectionIconHtml() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: transparent;
      }
      #icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        box-sizing: border-box;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 15px;
        font-weight: 600;
        color: #ffffff;
        background: #2f6df6;
        border-radius: 7px;
        cursor: pointer;
        -webkit-user-select: none;
        user-select: none;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.32);
      }
      #icon:active {
        background: #2257d6;
      }
    </style>
  </head>
  <body>
    <div id="icon" title="Translate selection">译</div>
    <script>
      document.getElementById('icon').addEventListener('click', () => {
        window.linguafix && window.linguafix.notifySelectionIconClicked();
      });
    </script>
  </body>
</html>`;
}

function createSelectionIconWindow() {
  if (selectionIconWindow && !selectionIconWindow.isDestroyed()) {
    return selectionIconWindow;
  }

  selectionIconWindow = new BrowserWindow({
    width: SELECTION_ICON_SIZE,
    height: SELECTION_ICON_SIZE,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.platform === 'darwin') {
    selectionIconWindow.setHiddenInMissionControl(true);
    selectionIconWindow.setAlwaysOnTop(true, 'floating');
    selectionIconWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } else {
    selectionIconWindow.setAlwaysOnTop(true);
  }

  selectionIconWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(selectionIconHtml())}`,
  );

  selectionIconWindow.on('closed', () => {
    selectionIconWindow = null;
  });

  return selectionIconWindow;
}

function isPointInsideSelectionIcon(point) {
  if (!selectionIconWindow || selectionIconWindow.isDestroyed() || !selectionIconWindow.isVisible()) {
    return false;
  }

  const bounds = selectionIconWindow.getBounds();
  return (
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
  );
}

function showSelectionIcon(text) {
  pendingSelectionText = text;

  const window = createSelectionIconWindow();
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const workArea = display.workArea;
  let x = cursor.x + 12;
  let y = cursor.y + 16;
  x = Math.min(x, workArea.x + workArea.width - SELECTION_ICON_SIZE);
  y = Math.min(y, workArea.y + workArea.height - SELECTION_ICON_SIZE);
  window.setPosition(Math.round(x), Math.round(y));
  window.showInactive();
  window.moveTop();

  if (selectionIconDismissTimer) {
    clearTimeout(selectionIconDismissTimer);
  }
  selectionIconDismissTimer = setTimeout(hideSelectionIcon, SELECTION_ICON_TIMEOUT_MS);
}

function hideSelectionIcon() {
  if (selectionIconDismissTimer) {
    clearTimeout(selectionIconDismissTimer);
    selectionIconDismissTimer = null;
  }

  pendingSelectionText = '';

  if (selectionIconWindow && !selectionIconWindow.isDestroyed() && selectionIconWindow.isVisible()) {
    selectionIconWindow.hide();
  }
}

function ownWindowIsFocused() {
  const focused = BrowserWindow.getFocusedWindow();
  if (!focused) {
    return false;
  }

  return focused === popupWindow || focused === selectionIconWindow;
}

function maybeNotifyAccessibilityRequired() {
  const now = Date.now();
  if (now - selectionAccessibilityNoticeAt < SELECTION_ACCESSIBILITY_NOTICE_INTERVAL_MS) {
    return;
  }

  selectionAccessibilityNoticeAt = now;
  notify(
    'Grant Accessibility access to LinguaFix in System Settings → Privacy & Security to read selected text.',
  );
}

async function readSelectionViaAccessibility() {
  try {
    const result = await callService('/api/selection');

    if (result && result.trusted === false) {
      maybeNotifyAccessibilityRequired();
      return '';
    }

    return typeof result?.text === 'string' ? result.text.trim() : '';
  } catch (_) {
    return '';
  }
}

async function captureSelection() {
  if (isCapturingSelection || isRunningSelectionWorkflow || ownWindowIsFocused()) {
    return;
  }

  isCapturingSelection = true;

  try {
    let selectedText = await readSelectionViaAccessibility();

    if (!selectedText) {
      // Fall back to the Cmd+C reader; restore the clipboard afterwards.
      const selectionState = await readSelectedTextFromMacApp();
      selectedText = selectionState.selectedText.trim();

      if (typeof selectionState.clipboardBackup === 'string') {
        clipboard.writeText(selectionState.clipboardBackup);
      }
    }

    if (selectedText.length < SELECTION_MIN_TEXT_LENGTH) {
      return;
    }

    if (selectionIconWindow && selectionIconWindow.isVisible() && selectedText === pendingSelectionText) {
      return;
    }

    showSelectionIcon(selectedText);
  } catch (_) {
    // Selection reads are best-effort; never surface an error from a stray drag.
  } finally {
    isCapturingSelection = false;
  }
}

async function translatePendingSelection() {
  const text = pendingSelectionText;
  hideSelectionIcon();

  if (!text || isRunningSelectionWorkflow) {
    return;
  }

  isRunningSelectionWorkflow = true;

  try {
    const response = await callService('/api/process', {
      method: 'POST',
      body: JSON.stringify({
        task: 'translate_english_to_chinese',
        text,
      }),
    });

    showSelectedTextTranslationPopup(text, response.output);
  } catch (error) {
    notify(
      error instanceof Error ? error.message : 'Could not translate the selected text.',
    );
  } finally {
    isRunningSelectionWorkflow = false;
  }
}

function handleSelectionMouseDown(event) {
  selectionMouseDownPoint = { x: event.x, y: event.y, button: event.button };

  // A click anywhere outside the icon dismisses it (outside-click + new-selection).
  if (selectionIconWindow && selectionIconWindow.isVisible()) {
    if (!isPointInsideSelectionIcon(screen.getCursorScreenPoint())) {
      hideSelectionIcon();
    }
  }
}

function handleSelectionMouseUp(event) {
  const down = selectionMouseDownPoint;
  selectionMouseDownPoint = null;

  if (!down || down.button !== 1 || event.button !== 1) {
    return;
  }

  const movedFarEnough =
    Math.abs(event.x - down.x) >= SELECTION_DRAG_THRESHOLD_PX ||
    Math.abs(event.y - down.y) >= SELECTION_DRAG_THRESHOLD_PX;

  if (!movedFarEnough) {
    return;
  }

  if (selectionCaptureTimer) {
    clearTimeout(selectionCaptureTimer);
  }
  selectionCaptureTimer = setTimeout(() => {
    void captureSelection();
  }, SELECTION_CAPTURE_DEBOUNCE_MS);
}

function loadUiohook() {
  if (uIOhook) {
    return uIOhook;
  }

  try {
    ({ uIOhook } = require('uiohook-napi'));
  } catch (error) {
    console.log(`[LinguaFix] Mouse selection watcher unavailable: ${error.message}`);
    uIOhook = null;
  }

  return uIOhook;
}

function startSelectionMouseWatcher() {
  if (selectionWatcherRunning || process.platform !== 'darwin') {
    return;
  }

  const hook = loadUiohook();
  if (!hook) {
    return;
  }

  hook.on('mousedown', handleSelectionMouseDown);
  hook.on('mouseup', handleSelectionMouseUp);

  try {
    hook.start();
    selectionWatcherRunning = true;
  } catch (error) {
    console.log(`[LinguaFix] Could not start mouse selection watcher: ${error.message}`);
    hook.removeListener('mousedown', handleSelectionMouseDown);
    hook.removeListener('mouseup', handleSelectionMouseUp);
  }
}

function stopSelectionMouseWatcher() {
  if (!selectionWatcherRunning || !uIOhook) {
    return;
  }

  uIOhook.removeListener('mousedown', handleSelectionMouseDown);
  uIOhook.removeListener('mouseup', handleSelectionMouseUp);

  try {
    uIOhook.stop();
  } catch (_) {
    // Ignore stop failures during teardown.
  }

  selectionWatcherRunning = false;
  hideSelectionIcon();
}

async function refreshSelectionPopupEnabled() {
  try {
    const config = await callService('/config');
    selectionPopupEnabled = Boolean(config?.selection_popup_enabled);
  } catch (_) {
    return;
  }

  if (selectionPopupEnabled) {
    startSelectionMouseWatcher();
  } else {
    stopSelectionMouseWatcher();
  }
}

function initSelectionMouseWatcher() {
  if (process.platform !== 'darwin') {
    return;
  }

  void refreshSelectionPopupEnabled();
  selectionConfigPollTimer = setInterval(() => {
    void refreshSelectionPopupEnabled();
  }, SELECTION_CONFIG_POLL_INTERVAL_MS);
}

function registerGlobalHotkeys() {
  globalShortcut.register(IN_PLACE_TRANSLATE_HOTKEY, async () => {
    await tryProcessSelectedTextInPlace();
  });

  globalShortcut.register(QUICK_TRANSLATE_POPUP_HOTKEY, () => {
    toggleQuickTranslatePopup();
  });

  globalShortcut.register(SELECTION_TO_CHINESE_POPUP_HOTKEY, async () => {
    await tryTranslateSelectedTextToChineseInPopup();
  });
}

function resolveStatusBarIconPath() {
  if (isDev()) {
    return path.join(app.getAppPath(), 'electron', 'assets', 'statusbarTemplate.png');
  }

  return path.join(process.resourcesPath, 'statusbarTemplate.png');
}

function resolveAppIconPath() {
  if (isDev()) {
    return path.join(app.getAppPath(), 'electron', 'assets', 'linguafix-app-icon-v2-512.png');
  }

  return path.join(process.resourcesPath, 'linguafix-app-icon-v2-512.png');
}

function setDockIcon() {
  if (process.platform !== 'darwin' || isPopupHelperProcess()) {
    return;
  }

  const icon = nativeImage.createFromPath(resolveAppIconPath());

  if (icon.isEmpty() || !app.dock) {
    return;
  }

  app.dock.setIcon(icon);
}

function buildStatusBarMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Open LinguaFix',
      click: () => {
        showMainWindow();
      },
    },
    {
      label: 'Quick Translate',
      click: () => {
        showQuickTranslatePopup();
      },
    },
    {
      label: 'Translate Selection to Chinese',
      click: async () => {
        await tryTranslateSelectedTextToChineseInPopup();
      },
    },
    {
      label: 'Process Selected Text',
      click: async () => {
        await tryProcessSelectedTextInPlace();
      },
    },
    {
      type: 'separator',
    },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      },
    },
  ]);
}

function createStatusBarItem() {
  if (process.platform !== 'darwin' || isPopupHelperProcess()) {
    return;
  }

  if (statusBarItem) {
    return;
  }

  let icon = nativeImage.createFromPath(resolveStatusBarIconPath());
  const hasIcon = !icon.isEmpty();

  if (!hasIcon) {
    icon = nativeImage.createEmpty();
  }

  statusBarItem = new Tray(icon.resize({ height: 20 }));
  statusBarItem.setToolTip('LinguaFix');

  if (!hasIcon) {
    statusBarItem.setTitle('LF');
  }

  statusBarItem.setContextMenu(buildStatusBarMenu());
  statusBarItem.on('click', () => {
    statusBarItem.popUpContextMenu();
  });
}

function destroyStatusBarItem() {
  if (!statusBarItem) {
    return;
  }

  statusBarItem.destroy();
  statusBarItem = null;
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
ipcMain.handle('linguafix:set-history-record-bookmark', async (_event, id, isBookmarked) =>
  callService(`/api/history/${id}/bookmark`, {
    method: 'PUT',
    body: JSON.stringify({ is_bookmarked: Boolean(isBookmarked) }),
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
ipcMain.on('linguafix:selection-icon-clicked', () => {
  void translatePendingSelection();
});

app.whenReady().then(async () => {
  if (isPopupHelperProcess() && process.platform === 'darwin') {
    app.setActivationPolicy('accessory');
  }

  if (isPopupHelperProcess()) {
    await ensureRustService();
    createPopupWindow();
    registerGlobalHotkeys();
    initSelectionMouseWatcher();
    return;
  }

  setDockIcon();
  createStatusBarItem();
  try {
    await ensureRustService();
  } catch (error) {
    notify(
      error instanceof Error
        ? error.message
        : 'Rust service could not be started.',
    );
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
  destroyStatusBarItem();

  if (selectionConfigPollTimer) {
    clearInterval(selectionConfigPollTimer);
    selectionConfigPollTimer = null;
  }
  stopSelectionMouseWatcher();

  if (!isPopupHelperProcess()) {
    stopPopupHelperProcess();
  }

  if (ownsServiceProcess && serviceProcess) {
    serviceProcess.kill();
  }
});
