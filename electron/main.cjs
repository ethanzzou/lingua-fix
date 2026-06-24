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
const TOGGLE_SELECTION_POPUP_HOTKEY = 'Control+Shift+S';
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
const SELECTION_CONFIG_POLL_INTERVAL_MS = 1000;
const SELECTION_ACCESSIBILITY_NOTICE_INTERVAL_MS = 60000;
const SELECTION_CARD_WIDTH = 460;
const SELECTION_CARD_MAX_WIDTH = 760;
const SELECTION_CARD_MIN_HEIGHT = 48;
const SELECTION_CARD_MAX_HEIGHT = 640;
const SELECTION_DISMISS_GRACE_MS = 220;

// The Cmd+C clipboard fallback exists only for apps that do not expose AXSelectedText but
// have a reliable native copy command. Restricting it to known apps keeps the clipboard
// dance away from every other context — most importantly screenshot region-drags, whose
// image lands on the clipboard asynchronously and would otherwise be clobbered.
const TERMINAL_BUNDLE_IDS = new Set([
  'com.mitchellh.ghostty',
  'com.googlecode.iterm2',
  'com.apple.Terminal',
  'org.alacritty',
  'net.kovidgoyal.kitty',
  'com.github.wez.wezterm',
  'io.alacritty',
  'dev.warp.Warp-Stable',
  'co.zeit.hyper',
  'com.brave.tilix',
]);
const TERMINAL_NAME_PATTERN = /term|ghostty|iterm|alacritty|kitty|wezterm|warp|hyper|console|tmux/i;
const CLIPBOARD_FALLBACK_BUNDLE_IDS = new Set([
  ...TERMINAL_BUNDLE_IDS,
  'com.openai.codex',
]);

function isTerminalApp(app) {
  if (!app) {
    return false;
  }
  if (app.bundleIdentifier && TERMINAL_BUNDLE_IDS.has(app.bundleIdentifier)) {
    return true;
  }
  return Boolean(app.name && TERMINAL_NAME_PATTERN.test(app.name));
}

function allowsClipboardSelectionFallback(app) {
  if (!app) {
    return false;
  }
  if (app.bundleIdentifier && CLIPBOARD_FALLBACK_BUNDLE_IDS.has(app.bundleIdentifier)) {
    return true;
  }
  return isTerminalApp(app);
}

let mainWindow = null;
let popupWindow = null;
let popupIgnoreBlurUntil = 0;
let popupHelperProcess = null;
let serviceProcess = null;
let ownsServiceProcess = false;
// Once we have confirmed the Rust service answers /health, skip the probe on the hot path
// (every hotkey press went through an extra localhost round trip). Reset whenever the
// service exits or a request actually fails, so a crashed/restarted service is re-probed.
let serviceConfirmedHealthy = false;
let isQuitting = false;
let isRunningSelectionWorkflow = false;
let statusBarItem = null;
let selectionIconWindow = null;
let uIOhook = null;
let UiohookKey = null;
let selectionWatcherRunning = false;
let selectionPopupEnabled = false;
let selectionConfigPollTimer = null;
let selectionMouseDownPoint = null;
let clipboardAtMouseDown = '';
let selectionCaptureTimer = null;
let isCapturingSelection = false;
let pendingSelectionText = '';
let selectionIconDismissTimer = null;
let selectionAccessibilityNoticeAt = 0;
let selectionCardWindow = null;
let selectionCardReady = false;
let pendingCardPayload = null;
let cardSourceText = '';
let cardAnchor = null;
let marked = null;
const selectionHoverState = { icon: false, card: false };
let selectionDismissGraceTimer = null;

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
    serviceConfirmedHealthy = false;
  });
}

async function waitForService() {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 30000) {
    if (await isServiceHealthy()) {
      serviceConfirmedHealthy = true;
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error('Rust service did not start within 30 seconds.');
}

async function ensureRustService() {
  // Fast path: we have already seen the service answer, so skip the localhost round trip.
  if (serviceConfirmedHealthy) {
    return;
  }

  if (await isServiceHealthy()) {
    serviceConfirmedHealthy = true;
    return;
  }

  startRustService();
  await waitForService();
}

async function callService(pathname, options = {}) {
  await ensureRustService();

  const requestInit = {
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  };

  let response;
  try {
    response = await fetch(`${SERVICE_URL}${pathname}`, requestInit);
  } catch (error) {
    // The cached health flag was stale (service crashed or was restarted out from under
    // us). Drop it, make sure the service is back up, and retry the request once.
    serviceConfirmedHealthy = false;
    await ensureRustService();
    response = await fetch(`${SERVICE_URL}${pathname}`, requestInit);
  }

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

// True when the clipboard holds image/non-text content (e.g. a screenshot just taken
// with another tool's shortcut). The selection workflow is text-only, so writing a
// sentinel during a racing screenshot capture could still destroy it — callers must bail
// out instead of touching the clipboard in that case.
function clipboardHoldsNonTextContent() {
  try {
    // readImage() is format-agnostic — macOS screenshots arrive as TIFF/public.* and
    // wouldn't match an "image/" MIME prefix, but readImage() resolves them all.
    const hasImage = !clipboard.readImage().isEmpty();
    if (!hasImage) {
      return false;
    }
    // An image is present; only treat it as "owned by something else" when there's no
    // usable text alongside it (some apps put both image + text on the clipboard).
    return clipboard.readText().trim().length === 0;
  } catch (_) {
    return false;
  }
}

function readClipboardSnapshot() {
  const snapshot = {
    text: '',
    formats: [],
  };

  try {
    snapshot.text = clipboard.readText();
  } catch (_) {
    snapshot.text = '';
  }

  try {
    for (const format of clipboard.availableFormats()) {
      try {
        const data = clipboard.readBuffer(format);
        snapshot.formats.push({
          format,
          data: Buffer.from(data),
        });
      } catch (_) {
        // Ignore individual formats that Electron cannot round-trip.
      }
    }
  } catch (_) {
    snapshot.formats = [];
  }

  return snapshot;
}

function restoreClipboardSnapshot(snapshot) {
  if (!snapshot) {
    return;
  }

  try {
    clipboard.clear();

    if (Array.isArray(snapshot.formats) && snapshot.formats.length > 0) {
      for (const item of snapshot.formats) {
        clipboard.writeBuffer(item.format, Buffer.from(item.data));
      }
      return;
    }

    if (typeof snapshot.text === 'string' && snapshot.text.length > 0) {
      clipboard.writeText(snapshot.text);
    }
  } catch (_) {
    try {
      if (typeof snapshot.text === 'string') {
        clipboard.writeText(snapshot.text);
      }
    } catch (_) {
      // Nothing else to do; clipboard restoration is best-effort.
    }
  }
}

async function readSelectedTextFromMacClipboard(clipboardSnapshot) {
  // Refuse to write the sentinel over an image/non-text clipboard (e.g. a fresh
  // screenshot). Snapshot restoration is best-effort, and image clipboard writes from
  // screenshot tools can still race this workflow, so do not touch that clipboard state.
  if (clipboardHoldsNonTextContent()) {
    return {
      clipboardSnapshot,
      selectedText: '',
    };
  }

  const clipboardSentinel = `__LINGUAFIX_SELECTION__${Date.now()}__`;

  clipboard.writeText(clipboardSentinel);
  await triggerMacSelectionShortcut('c');

  let selectedText = '';

  for (let attempt = 0; attempt < AUTOMATION_COPY_POLL_ATTEMPTS; attempt += 1) {
    await sleep(AUTOMATION_COPY_POLL_DELAY_MS);
    selectedText = clipboard.readText();

    if (selectedText !== clipboardSentinel) {
      return {
        clipboardSnapshot,
        selectedText,
      };
    }
  }

  restoreClipboardSnapshot(clipboardSnapshot);

  return {
    clipboardSnapshot,
    selectedText: '',
  };
}

async function readSelectedTextFromMacApp() {
  const clipboardSnapshot = readClipboardSnapshot();
  const frontmostApp = await getFrontmostMacApp();
  const clipboardSelectionState = await readSelectedTextFromMacClipboard(clipboardSnapshot);

  return {
    ...clipboardSelectionState,
    frontmostApp,
  };
}

async function replaceSelectionInMacApp(text, clipboardSnapshot, frontmostApp) {
  clipboard.writeText(text);

  // Re-focus the original app by pid before pasting. A single `whose unix id is …` filter
  // is one Apple Event, vastly faster than manually iterating every application process by
  // pid, then bundle id, then name (the old triple repeat-loop, each iteration its own
  // round trip, was the slow part). Our own workflow never moves focus between copy and
  // paste, so this is only a safety net; with no pid we fall back to a bare paste.
  if (frontmostApp?.pid) {
    await runAppleScript(`
      tell application "System Events"
        try
          set frontmost of (first application process whose unix id is ${frontmostApp.pid}) to true
        end try
        keystroke "v" using command down
      end tell
    `);
  } else {
    await triggerMacSelectionShortcut('v');
  }

  await sleep(AUTOMATION_PASTE_RESTORE_DELAY_MS);
  restoreClipboardSnapshot(clipboardSnapshot);
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
  let clipboardSnapshot = null;

  try {
    const selectionState = await readSelectedTextFromMacApp();
    clipboardSnapshot = selectionState.clipboardSnapshot;
    const { frontmostApp, selectedText } = selectionState;

    if (!selectedText.trim()) {
      restoreClipboardSnapshot(clipboardSnapshot);
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
      clipboardSnapshot,
      frontmostApp,
    );
    return true;
  } catch (error) {
    restoreClipboardSnapshot(clipboardSnapshot);

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
  let clipboardSnapshot = null;

  try {
    const selectionState = await readSelectedTextFromMacApp();
    clipboardSnapshot = selectionState.clipboardSnapshot;
    const selectedText = selectionState.selectedText.trim();

    if (!selectedText) {
      restoreClipboardSnapshot(clipboardSnapshot);
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

    restoreClipboardSnapshot(clipboardSnapshot);
    showSelectedTextTranslationPopup(selectedText, response.output);
    return true;
  } catch (error) {
    restoreClipboardSnapshot(clipboardSnapshot);

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
    <div id="icon" title="Translate selection">T</div>
    <script>
      const icon = document.getElementById('icon');
      icon.addEventListener('click', () => {
        window.linguafix && window.linguafix.notifySelectionIconClicked();
      });
      icon.addEventListener('mouseenter', () => {
        if (!window.linguafix) return;
        window.linguafix.notifySelectionHoverIn('icon');
        window.linguafix.notifySelectionIconHovered();
      });
      icon.addEventListener('mouseleave', () => {
        window.linguafix && window.linguafix.notifySelectionHoverOut('icon');
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

function isPointInsideSelectionCard(point) {
  if (!selectionCardWindow || selectionCardWindow.isDestroyed() || !selectionCardWindow.isVisible()) {
    return false;
  }

  const bounds = selectionCardWindow.getBounds();
  return (
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
  );
}

function loadMarked() {
  if (marked) {
    return marked;
  }

  try {
    ({ marked } = require('marked'));
  } catch (error) {
    console.log(`[LinguaFix] Markdown renderer unavailable: ${error.message}`);
    marked = null;
  }

  return marked;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Strip script-ish tags and inline event handlers before the HTML reaches the
// card's innerHTML. The card window is sandboxed (contextIsolation, no node, no
// remote content); this closes the <img onerror=...> style vector from model output.
function scrubHtml(html) {
  return String(html)
    .replace(/<\/?(?:script|style|iframe|object|embed|link|meta|base)\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/(href|src)\s*=\s*(["']?)\s*javascript:[^"'>\s]*/gi, '$1=$2#');
}

// Detect content that is *already* a rendered/aligned layout rather than Markdown
// source — e.g. a terminal table with box-drawing borders, or several lines of
// pipe-aligned columns. Re-parsing such text as Markdown turns border rules into
// <hr> and bare pipes into literal text (the broken-table bug). Render it verbatim
// in a monospace <pre> instead so column alignment survives.
function looksLikeRenderedLayout(text) {
  if (/[│─┌┐└┘├┤┬┴┼╭╮╰╯═║╔╗╚╝╠╣╦╩╬]/.test(text)) {
    return true;
  }
  const lines = String(text).split('\n');
  const pipeRows = lines.filter((line) => (line.match(/\|/g) || []).length >= 2).length;
  // A valid GFM table carries a delimiter row (|---|---|); let `marked` render
  // those as real tables. Pipe-aligned text *without* one is a rendered/terminal
  // table that should stay monospaced.
  const hasDelimiterRow = lines.some((line) => /^\s*\|?[\s:|-]*-{2,}[\s:|-]*\|/.test(line));
  return pipeRows >= 2 && !hasDelimiterRow;
}

function renderSelectionMarkdown(text) {
  const source = String(text);

  if (looksLikeRenderedLayout(source)) {
    return `<pre>${escapeHtml(source)}</pre>`;
  }

  const renderer = loadMarked();
  if (!renderer) {
    return `<p>${escapeHtml(source).replace(/\n/g, '<br/>')}</p>`;
  }

  try {
    return scrubHtml(renderer.parse(source, { gfm: true }));
  } catch (_) {
    return `<p>${escapeHtml(source).replace(/\n/g, '<br/>')}</p>`;
  }
}

function selectionCardHtml() {
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
      #card {
        box-sizing: border-box;
        width: 100%;
        height: 100%;
        overflow-y: auto;
        overflow-x: hidden;
        padding: 16px 18px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 14.5px;
        line-height: 1.62;
        color: #1c1c1e;
        background: #ffffff;
        border: 1px solid rgba(0, 0, 0, 0.08);
        border-radius: 12px;
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.24);
        -webkit-user-select: text;
        user-select: text;
      }
      #content {
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      #content.loading { color: #8a8a8e; }
      #content :first-child { margin-top: 0; }
      #content :last-child { margin-bottom: 0; }
      #content p { margin: 0 0 10px; }
      #content ul, #content ol { margin: 0 0 10px; padding-left: 22px; }
      #content li { margin: 3px 0; }
      #content code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12.5px;
        background: rgba(0, 0, 0, 0.06);
        padding: 1px 5px;
        border-radius: 4px;
      }
      #content pre {
        background: rgba(0, 0, 0, 0.06);
        padding: 10px 12px;
        border-radius: 8px;
        overflow-x: auto;
        margin: 0 0 10px;
      }
      #content pre code { background: none; padding: 0; }
      #content h1, #content h2, #content h3 { font-size: 15.5px; font-weight: 650; margin: 12px 0 8px; }
      #content blockquote {
        margin: 0 0 10px;
        padding-left: 12px;
        border-left: 3px solid rgba(0, 0, 0, 0.12);
        color: #5b5b5f;
      }
      #content a { color: #2f6df6; }
      #content table {
        border-collapse: collapse;
        width: 100%;
        margin: 0 0 10px;
        font-size: 13.5px;
      }
      #content th, #content td {
        border: 1px solid rgba(0, 0, 0, 0.14);
        padding: 5px 9px;
        text-align: left;
        vertical-align: top;
      }
      #content th { background: rgba(0, 0, 0, 0.05); font-weight: 650; }
      #content hr { border: none; border-top: 1px solid rgba(0, 0, 0, 0.1); margin: 12px 0; }
      #card::-webkit-scrollbar { width: 8px; }
      #card::-webkit-scrollbar-thumb { background: rgba(0, 0, 0, 0.18); border-radius: 4px; }
    </style>
  </head>
  <body>
    <div id="card"><div id="content" class="loading">Translating…</div></div>
    <script>
      const card = document.getElementById('card');
      const content = document.getElementById('content');

      function reportSize() {
        if (window.linguafix && window.linguafix.reportSelectionCardSize) {
          // content.scrollWidth exceeds the visible width only when something
          // (e.g. a monospace <pre> table) can't wrap; add the card's horizontal
          // chrome (padding 18*2 + border 1*2) so the window can grow to fit it.
          window.linguafix.reportSelectionCardSize({
            height: Math.ceil(card.scrollHeight),
            width: Math.ceil(content.scrollWidth) + 38,
          });
        }
      }

      card.addEventListener('mouseenter', () => {
        window.linguafix && window.linguafix.notifySelectionHoverIn('card');
      });
      card.addEventListener('mouseleave', () => {
        window.linguafix && window.linguafix.notifySelectionHoverOut('card');
      });

      if (window.linguafix && window.linguafix.onSelectionCardContent) {
        window.linguafix.onSelectionCardContent((payload) => {
          if (payload && payload.loading) {
            content.className = 'loading';
            content.textContent = (payload && payload.text) || 'Translating…';
          } else {
            content.className = '';
            content.innerHTML = (payload && payload.html) || '';
          }
          requestAnimationFrame(reportSize);
        });
      }

      requestAnimationFrame(reportSize);
    </script>
  </body>
</html>`;
}

function createSelectionCardWindow() {
  if (selectionCardWindow && !selectionCardWindow.isDestroyed()) {
    return selectionCardWindow;
  }

  selectionCardReady = false;
  selectionCardWindow = new BrowserWindow({
    width: SELECTION_CARD_WIDTH,
    height: SELECTION_CARD_MIN_HEIGHT,
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
    selectionCardWindow.setHiddenInMissionControl(true);
    selectionCardWindow.setAlwaysOnTop(true, 'floating');
    selectionCardWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } else {
    selectionCardWindow.setAlwaysOnTop(true);
  }

  selectionCardWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(selectionCardHtml())}`,
  );

  selectionCardWindow.webContents.on('did-finish-load', () => {
    selectionCardReady = true;
    if (pendingCardPayload) {
      selectionCardWindow.webContents.send('linguafix:selection-card-content', pendingCardPayload);
      pendingCardPayload = null;
    }
  });

  selectionCardWindow.on('closed', () => {
    selectionCardWindow = null;
    selectionCardReady = false;
    pendingCardPayload = null;
  });

  return selectionCardWindow;
}

function applyCardBounds(height, width) {
  if (!selectionCardWindow || selectionCardWindow.isDestroyed() || !cardAnchor) {
    return;
  }

  const display = screen.getDisplayNearestPoint({ x: cardAnchor.x, y: cardAnchor.y });
  const workArea = display.workArea;
  const h = Math.max(
    SELECTION_CARD_MIN_HEIGHT,
    Math.min(height || SELECTION_CARD_MIN_HEIGHT, SELECTION_CARD_MAX_HEIGHT),
  );
  // Grow horizontally to fit non-wrapping content, but never wider than the
  // display's work area or our own cap.
  const w = Math.max(
    SELECTION_CARD_WIDTH,
    Math.min(width || SELECTION_CARD_WIDTH, SELECTION_CARD_MAX_WIDTH, workArea.width),
  );

  let x = Math.min(cardAnchor.x, workArea.x + workArea.width - w);
  x = Math.max(x, workArea.x);

  let y = cardAnchor.y;
  if (y + h > workArea.y + workArea.height) {
    // Flip above the original cursor when there is no room below.
    y = cardAnchor.cy - 8 - h;
  }
  y = Math.max(y, workArea.y);

  selectionCardWindow.setBounds({
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(w),
    height: Math.round(h),
  });
}

function sendSelectionCard(payload) {
  if (!selectionCardWindow || selectionCardWindow.isDestroyed()) {
    return;
  }

  if (!selectionCardReady) {
    pendingCardPayload = payload;
    return;
  }

  selectionCardWindow.webContents.send('linguafix:selection-card-content', payload);
}

function setSelectionCardLoading() {
  sendSelectionCard({ loading: true, text: 'Translating…' });
}

function setSelectionCardContent(html) {
  sendSelectionCard({ html });
}

function showSelectionCard() {
  const cursor = screen.getCursorScreenPoint();
  cardAnchor = { x: cursor.x + 12, y: cursor.y + 16 + SELECTION_ICON_SIZE, cy: cursor.y };

  const window = createSelectionCardWindow();
  applyCardBounds(SELECTION_CARD_MIN_HEIGHT);
  window.showInactive();
  window.moveTop();
}

function hideSelectionCard() {
  cardSourceText = '';
  selectionHoverState.card = false;

  if (selectionCardWindow && !selectionCardWindow.isDestroyed() && selectionCardWindow.isVisible()) {
    selectionCardWindow.hide();
  }
}

function scheduleSelectionDismiss() {
  if (selectionDismissGraceTimer) {
    clearTimeout(selectionDismissGraceTimer);
  }

  selectionDismissGraceTimer = setTimeout(() => {
    selectionDismissGraceTimer = null;
    if (!selectionHoverState.icon && !selectionHoverState.card) {
      hideSelectionCard();
      hideSelectionIcon();
    }
  }, SELECTION_DISMISS_GRACE_MS);
}

function handleSelectionHoverIn(target) {
  if (target === 'icon') {
    selectionHoverState.icon = true;
  } else if (target === 'card') {
    selectionHoverState.card = true;
  }

  if (selectionDismissGraceTimer) {
    clearTimeout(selectionDismissGraceTimer);
    selectionDismissGraceTimer = null;
  }
}

function handleSelectionHoverOut(target) {
  if (target === 'icon') {
    selectionHoverState.icon = false;
  } else if (target === 'card') {
    selectionHoverState.card = false;
  }

  scheduleSelectionDismiss();
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
  if (!selectionPopupEnabled || isCapturingSelection || isRunningSelectionWorkflow || ownWindowIsFocused()) {
    return;
  }

  // A screenshot/region drag from another tool lands an image on the clipboard. Never run
  // the text selection workflow against it — doing so would clobber the screenshot.
  if (clipboardHoldsNonTextContent()) {
    return;
  }

  isCapturingSelection = true;

  try {
    let selectedText = await readSelectionViaAccessibility();

    if (!selectedText) {
      // Terminals (Ghostty/iTerm/etc.) don't expose AXSelectedText, and tmux mouse mode
      // intercepts the drag so there's no native selection for Cmd+C to copy. If the app
      // copied-on-select (e.g. tmux `copy-pipe pbcopy`), the selection is already on the
      // clipboard — pick it up if it changed during this drag, without simulating Cmd+C.
      const current = clipboard.readText();
      if (current && current !== clipboardAtMouseDown && current.trim().length >= SELECTION_MIN_TEXT_LENGTH) {
        selectedText = current.trim();
      }
    }

    if (!selectedText) {
      // The Cmd+C fallback (sentinel write + simulated copy + full clipboard restore) is
      // limited to known apps that need it. Anywhere else — most importantly a screenshot
      // region-drag, whose image is written to the clipboard asynchronously and can't be
      // sampled reliably — we must not touch the clipboard at all.
      const frontmostApp = await getFrontmostMacApp();

      if (!allowsClipboardSelectionFallback(frontmostApp) || clipboardHoldsNonTextContent()) {
        return;
      }

      const selectionState = await readSelectedTextFromMacApp();
      selectedText = selectionState.selectedText.trim();

      restoreClipboardSnapshot(selectionState.clipboardSnapshot);
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

  if (!text || isRunningSelectionWorkflow) {
    return;
  }

  // Already showing (or loading) the card for this exact selection — don't re-fire on
  // repeated hover/click.
  if (cardSourceText === text && selectionCardWindow && selectionCardWindow.isVisible()) {
    return;
  }

  cardSourceText = text;
  isRunningSelectionWorkflow = true;

  // Dismissal is now hover-driven; cancel the icon-only auto-hide so the card can't vanish.
  if (selectionIconDismissTimer) {
    clearTimeout(selectionIconDismissTimer);
    selectionIconDismissTimer = null;
  }

  showSelectionCard();
  setSelectionCardLoading();

  try {
    const response = await callService('/api/process', {
      method: 'POST',
      body: JSON.stringify({
        task: 'translate_english_to_chinese',
        text,
      }),
    });

    if (cardSourceText !== text) {
      return; // Superseded by a newer selection.
    }

    setSelectionCardContent(renderSelectionMarkdown(response.output));
  } catch (error) {
    if (cardSourceText !== text) {
      return;
    }

    const message = error instanceof Error ? error.message : 'Could not translate the selected text.';
    setSelectionCardContent(renderSelectionMarkdown(message));
  } finally {
    isRunningSelectionWorkflow = false;
  }
}

function handleSelectionMouseDown(event) {
  selectionMouseDownPoint = { x: event.x, y: event.y, button: event.button };

  // Snapshot the clipboard so we can detect a copy-on-select (e.g. tmux copy-pipe) that
  // lands new text on the clipboard by the time the drag ends.
  try {
    clipboardAtMouseDown = clipboard.readText();
  } catch (_) {
    clipboardAtMouseDown = '';
  }

  // A click anywhere outside the icon and card dismisses both (outside-click + new-selection).
  const iconVisible = selectionIconWindow && selectionIconWindow.isVisible();
  const cardVisible = selectionCardWindow && selectionCardWindow.isVisible();

  if (iconVisible || cardVisible) {
    const point = screen.getCursorScreenPoint();
    if (!isPointInsideSelectionIcon(point) && !isPointInsideSelectionCard(point)) {
      hideSelectionCard();
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
    ({ uIOhook, UiohookKey } = require('uiohook-napi'));
  } catch (error) {
    console.log(`[LinguaFix] Mouse selection watcher unavailable: ${error.message}`);
    uIOhook = null;
    UiohookKey = null;
  }

  return uIOhook;
}

function handleSelectionKeyDown(event) {
  const escapeKeycode = (UiohookKey && UiohookKey.Escape) || 1;
  if (event.keycode !== escapeKeycode) {
    return;
  }

  const iconVisible = selectionIconWindow && selectionIconWindow.isVisible();
  const cardVisible = selectionCardWindow && selectionCardWindow.isVisible();
  if (iconVisible || cardVisible) {
    hideSelectionCard();
    hideSelectionIcon();
  }
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
  hook.on('keydown', handleSelectionKeyDown);

  try {
    hook.start();
    selectionWatcherRunning = true;
  } catch (error) {
    console.log(`[LinguaFix] Could not start mouse selection watcher: ${error.message}`);
    hook.removeListener('mousedown', handleSelectionMouseDown);
    hook.removeListener('mouseup', handleSelectionMouseUp);
    hook.removeListener('keydown', handleSelectionKeyDown);
  }
}

function stopSelectionMouseWatcher() {
  if (!selectionWatcherRunning || !uIOhook) {
    return;
  }

  uIOhook.removeListener('mousedown', handleSelectionMouseDown);
  uIOhook.removeListener('mouseup', handleSelectionMouseUp);
  uIOhook.removeListener('keydown', handleSelectionKeyDown);

  try {
    uIOhook.stop();
  } catch (_) {
    // Ignore stop failures during teardown.
  }

  selectionWatcherRunning = false;
  hideSelectionCard();
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

  if (statusBarItem) {
    statusBarItem.setContextMenu(buildStatusBarMenu());
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

  globalShortcut.register(TOGGLE_SELECTION_POPUP_HOTKEY, async () => {
    selectionPopupEnabled = !selectionPopupEnabled;
    if (selectionPopupEnabled) {
      startSelectionMouseWatcher();
    } else {
      stopSelectionMouseWatcher();
    }
    if (statusBarItem) {
      statusBarItem.setContextMenu(buildStatusBarMenu());
    }
    try {
      const config = await callService('/config');
      config.selection_popup_enabled = selectionPopupEnabled;
      await callService('/config', { method: 'PUT', body: JSON.stringify(config) });
    } catch (_) {}
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
      label: 'Selection Translation',
      type: 'checkbox',
      checked: selectionPopupEnabled,
      click: async (menuItem) => {
        selectionPopupEnabled = menuItem.checked;
        if (selectionPopupEnabled) {
          startSelectionMouseWatcher();
        } else {
          stopSelectionMouseWatcher();
        }
        try {
          const config = await callService('/config');
          config.selection_popup_enabled = selectionPopupEnabled;
          await callService('/config', { method: 'PUT', body: JSON.stringify(config) });
        } catch (_) {}
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
ipcMain.on('linguafix:selection-icon-hovered', () => {
  void translatePendingSelection();
});
ipcMain.on('linguafix:selection-hover-in', (_event, target) => {
  handleSelectionHoverIn(target);
});
ipcMain.on('linguafix:selection-hover-out', (_event, target) => {
  handleSelectionHoverOut(target);
});
ipcMain.on('linguafix:selection-card-size', (_event, size) => {
  const height = size && typeof size === 'object' ? size.height : size;
  const width = size && typeof size === 'object' ? size.width : undefined;
  applyCardBounds(Number(height) + 2, width != null ? Number(width) : undefined);
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
