const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');

function harness({ env = {}, packaged = false, spawn, home = '/test-home', existsSync } = {}) {
  const electron = {
    app: {
      isPackaged: packaged,
      getAppPath: () => '/project',
      whenReady: () => ({ then() {} }),
      on() {},
    },
    ipcMain: { handle() {}, on() {} },
  };
  const context = vm.createContext({
    require(name) {
      if (name === 'electron') return electron;
      if (name === 'node:process') return { ...process, env, resourcesPath: '/resources' };
      if (name === 'node:os') return { homedir: () => home };
      if (name === 'node:fs' && existsSync) return { ...fs, existsSync };
      if (name === 'node:child_process') return { ...require(name), spawn };
      return require(name);
    },
    console, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8'), context);
  return (source) => vm.runInContext(source, context);
}

function cargoFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'linguafix-cargo-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, '.cargo', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const cargo = path.join(bin, process.platform === 'win32' ? 'cargo.exe' : 'cargo');
  fs.writeFileSync(cargo, '', { mode: 0o755 });
  return { home, bin, cargo };
}

test('Finder PATH resolves rustup Cargo and supplies its bin folder to the service', (t) => {
  const { home, bin, cargo } = cargoFixture(t);
  const run = harness({ home, env: { PATH: '/usr/bin:/bin' } });
  const service = run('resolveRustCommand()');
  assert.equal(service.command, cargo);
  assert.equal(service.env.PATH.split(path.delimiter)[0], bin);
});

test('custom CARGO_HOME works when PATH is absent', (t) => {
  const { home, cargo } = cargoFixture(t);
  const run = harness({ env: { CARGO_HOME: path.join(home, '.cargo') } });
  assert.equal(run('resolveRustCommand().command'), cargo);
});

test('Cargo already on PATH takes precedence', (t) => {
  const { home, bin, cargo } = cargoFixture(t);
  const run = harness({ env: { PATH: bin, CARGO_HOME: '/missing' }, home });
  assert.equal(run('resolveRustCommand().command'), cargo);
});

test('spawn failure rejects startup, clears ownership, and allows a retry', async () => {
  const children = [];
  const run = harness({ spawn: () => {
    const child = new EventEmitter();
    children.push(child);
    return child;
  } });
  run('resolveRustCommand = () => ({ command: "missing-cargo", args: [], cwd: "/project" })');
  const starting = run('startRustService()');
  children[0].emit('error', Object.assign(new Error('spawn cargo ENOENT'), { code: 'ENOENT' }));
  await assert.rejects(starting, /Rust service could not be started: spawn cargo ENOENT/);
  assert.equal(run('serviceProcess'), null);
  assert.equal(run('ownsServiceProcess'), false);
  await assert.rejects(run('waitForService()'), /spawn cargo ENOENT/);

  const retry = run('startRustService()');
  children[1].emit('spawn');
  await retry;
  assert.equal(run('serviceStartupError'), null);
  assert.equal(run('ownsServiceProcess'), true);
  children[1].emit('exit', 0);
  assert.equal(run('serviceProcess'), null);
});

test('packaged app uses its bundled service without Cargo', () => {
  const run = harness({
    packaged: true,
    existsSync: (candidate) => candidate === '/resources/bin/linguafix',
  });
  assert.equal(run('resolveRustCommand().command'), '/resources/bin/linguafix');
});
