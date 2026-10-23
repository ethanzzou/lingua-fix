const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');

// Load the real main-process functions without launching Electron or registering hotkeys.
function harness() {
  let text = 'original clipboard';
  let image = false;
  const writes = [];
  const clipboard = {
    readText: () => text,
    readImage: () => { const capturedImage = image; return { isEmpty: () => !capturedImage }; },
    availableFormats: () => [],
    clear: () => { text = ''; image = false; writes.push('clear'); },
    writeText: (value) => { text = value; image = false; writes.push(value); },
    write: (value) => { text = value.text || ''; image = !value.image.isEmpty(); writes.push(value); },
  };
  const electron = {
    clipboard,
    app: { whenReady: () => ({ then() {} }), on() {} },
    ipcMain: { handle() {}, on() {} },
  };
  const context = vm.createContext({
    require: (name) => {
      if (name === 'electron') return electron;
      if (name === 'node:process') return { ...process, platform: 'darwin' };
      return require(name);
    },
    Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval,
    __dirname: path.resolve(__dirname, '..'),
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main.cjs'), 'utf8'), context);
  vm.runInContext('sleep = async () => {};', context);
  return {
    context, clipboard, writes,
    run: (source) => vm.runInContext(source, context),
    setImage: (value) => { image = value; },
  };
}

test('accessibility selection bypasses copy, including with an image clipboard', async () => {
  const h = harness();
  h.setImage(true);
  h.run(`
    getFrontmostMacApp = async () => ({ pid: 123 });
    readSelectionViaAccessibility = async () => 'selected text';
    triggerMacSelectionShortcut = async () => { throw new Error('unexpected copy'); };
  `);
  const result = await h.run('readSelectedTextFromMacApp()');
  assert.equal(result.selectedText, 'selected text');
  assert.equal(result.clipboardSnapshot, null);
  assert.deepEqual(h.writes, []);
});

test('unavailable accessibility falls back to copy and retries delayed copies', async () => {
  const h = harness();
  h.run(`
    getFrontmostMacApp = async () => ({ pid: 123 });
    readSelectionViaAccessibility = async () => '';
    let copyCount = 0;
    triggerMacSelectionShortcut = async () => {
      copyCount += 1;
      if (copyCount === 2) clipboard.writeText('fallback selection');
    };
  `);
  const result = await h.run('readSelectedTextFromMacApp()');
  assert.equal(result.selectedText, 'fallback selection');
  assert.equal(result.clipboardSnapshot.text, 'original clipboard');
  assert.equal(h.run('copyCount'), 2);
});

test('copy failure restores the clipboard even before a snapshot can reach the caller', async () => {
  const h = harness();
  h.run(`triggerMacSelectionShortcut = async () => { throw new Error('copy denied'); };`);
  await assert.rejects(h.run('readSelectedTextFromMacClipboard(readClipboardSnapshot())'), /copy denied/);
  assert.equal(h.clipboard.readText(), 'original clipboard');
});

test('no selection restores the clipboard after bounded retries', async () => {
  const h = harness();
  h.run('triggerMacSelectionShortcut = async () => {};');
  const result = await h.run('readSelectedTextFromMacClipboard(readClipboardSnapshot())');
  assert.equal(result.selectedText, '');
  assert.equal(h.clipboard.readText(), 'original clipboard');
});

test('clipboard fallback leaves a screenshot untouched', async () => {
  const h = harness();
  h.clipboard.writeText('');
  h.writes.length = 0;
  h.setImage(true);
  const result = await h.run('readSelectedTextFromMacClipboard(readClipboardSnapshot())');
  assert.equal(result.clipboardSnapshot, null);
  assert.equal(result.selectedText, '');
  assert.deepEqual(h.writes, []);
});

test('explicit hotkey copies text over an image clipboard and restores the image', async () => {
  const h = harness();
  h.clipboard.writeText('');
  h.setImage(true);
  h.run(`
    getFrontmostMacApp = async () => ({ pid: 123 });
    readSelectionViaAccessibility = async () => '';
    triggerMacSelectionShortcut = async () => clipboard.writeText('selected text');
  `);
  const selection = await h.run('readSelectedTextFromMacApp()');
  assert.equal(selection.selectedText, 'selected text');
  h.context.savedSnapshot = selection.clipboardSnapshot;
  h.run('restoreClipboardSnapshot(savedSnapshot)');
  assert.equal(h.clipboard.readImage().isEmpty(), false);
  assert.equal(h.clipboard.readText(), '');
});

test('failed explicit copy also restores an image clipboard', async () => {
  const h = harness();
  h.clipboard.writeText('');
  h.setImage(true);
  h.run(`triggerMacSelectionShortcut = async () => { throw new Error('copy denied'); };`);
  await assert.rejects(h.run('readSelectedTextFromMacClipboard(readClipboardSnapshot(), { explicitShortcut: true })'), /copy denied/);
  assert.equal(h.clipboard.readImage().isEmpty(), false);
  assert.equal(h.clipboard.readText(), '');
});

test('paste after an accessibility read restores the current clipboard on failure', async () => {
  const h = harness();
  h.run(`triggerMacSelectionShortcut = async () => { throw new Error('paste denied'); };`);
  await assert.rejects(h.run("replaceSelectionInMacApp('translation', null, { pid: 123 })"), /paste denied/);
  assert.equal(h.clipboard.readText(), 'original clipboard');
});

test('explicit workflows wait for mouse capture to restore its clipboard', async () => {
  for (const workflow of ['tryProcessSelectedTextInPlace', 'tryTranslateSelectedTextToChineseInPopup']) {
    const h = harness();
    h.run(`
      isCapturingSelection = true;
      let captureFinished = false;
      let readStarted = false;
      sleep = async () => {
        assertWorkflowClaimed();
        captureFinished = true;
        isCapturingSelection = false;
      };
      notify = () => {};
      readSelectedTextFromMacApp = async () => {
        if (!captureFinished) throw new Error('clipboard race');
        readStarted = true;
        return { selectedText: '', clipboardSnapshot: null };
      };
    `);
    h.context.assertWorkflowClaimed = () => assert.equal(h.run('isRunningSelectionWorkflow'), true);
    await h.run(`${workflow}()`);
    assert.equal(h.run('readStarted'), true);
    assert.equal(h.run('isRunningSelectionWorkflow'), false);
  }
});

test('mouse capture yields its icon when a hotkey claims the workflow', async () => {
  const h = harness();
  h.run(`
    selectionPopupEnabled = true;
    ownWindowIsFocused = () => false;
    readSelectionViaAccessibility = async () => {
      isRunningSelectionWorkflow = true;
      return 'selected text';
    };
    showSelectionIcon = () => { throw new Error('unexpected icon'); };
  `);
  let showedIcon = false;
  h.context.showSelectionIcon = () => { showedIcon = true; };
  await h.run('captureSelection()');
  assert.equal(showedIcon, false);
  assert.equal(h.run('isCapturingSelection'), false);
});

test('native modifier wait handles held keys and ignores Caps Lock without typing', {
  skip: process.platform !== 'darwin',
}, () => {
  const h = harness();
  // Run the actual AppleScript wait, replacing only the flag source and key dispatch.
  // No key events are sent to any user application by this test.
  const script = h.run("buildMacSelectionShortcutScript('c')");
  const flags = [131072, 262144, 524288, 1048576, 65536];
  const safeScript = script
    .replace('set modifiersReleased to false', `set samples to {${flags.join(', ')}}\nset sampleIndex to 0\nset modifiersReleased to false`)
    .replace("(current application's NSEvent's modifierFlags()) as integer", 'item sampleIndex of samples')
    .replace('set modifierFlags to', 'set sampleIndex to sampleIndex + 1\nset modifierFlags to')
    .replace(/tell application "System Events"[\s\S]*end tell/, 'return sampleIndex');
  assert.equal(execFileSync('osascript', ['-e', safeScript], { encoding: 'utf8' }).trim(), '5');
});

test('native modifier wait times out without dispatching copy', { skip: process.platform !== 'darwin' }, () => {
  const h = harness();
  const safeScript = h.run("buildMacSelectionShortcutScript('c')")
    .replace("(current application's NSEvent's modifierFlags()) as integer", '262144')
    .replace('delay 0.02', 'delay 0')
    .replace(/tell application "System Events"[\s\S]*end tell/, 'return "unexpected dispatch"');
  assert.throws(() => execFileSync('osascript', ['-e', safeScript], { stdio: 'pipe' }), /Release the shortcut keys/);
});

test('complete copy and paste scripts compile on macOS without sending keys', {
  skip: process.platform !== 'darwin',
}, () => {
  const h = harness();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'linguafix-selection-'));
  try {
    for (const key of ['c', 'v']) {
      const script = h.run(`buildMacSelectionShortcutScript('${key}', ${key === 'v' ? '123' : 'null'})`);
      execFileSync('osacompile', ['-o', path.join(directory, `${key}.scpt`), '-e', script], { stdio: 'pipe' });
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
