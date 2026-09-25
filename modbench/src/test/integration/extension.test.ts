import * as assert from 'assert';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { before, after, beforeEach, afterEach, describe, it } from 'mocha';
import type { BackendStatus, MEditClient, PluginMetadata } from '../../client';
import type { ActivateExports } from '../../extension';
import { DownloadNode, type DownloadsTreeNode } from '../../downloads/DownloadsProvider';
import { present } from '../../ports/present';
import { isRecord } from '../manifest';
import { MODS_KEY_ARGS } from '../../mods/gestureEntry';

const TEST_PORT = 15172;
let mockBackend: http.Server;
let ext: vscode.Extension<ActivateExports> | undefined;

// The Instance's own read model (ADR-0015): a test that writes plugins.txt and then reads the
// Plugins tree awaits past a sequence with this, rather than assuming the write is visible the
// instant the write call returns.
type InstanceLike = NonNullable<ActivateExports['instance']>;
const instanceExport = () => ext?.exports.instance;
function pastSequence(instance: InstanceLike, sequence: number): Promise<void> {
  if (instance.sequence > sequence) return Promise.resolve();
  return new Promise((resolve) => {
    const subscription = instance.subscribe((_value, seq) => {
      if (seq <= sequence) return;
      subscription.dispose();
      resolve();
    });
  });
}
// Snapshots the current sequence, runs `write` (a plugins.txt/config change), then awaits the
// Instance's next landed recompute — the row-provider-visible equivalent of the write completing.
async function writeAndAwaitInstance(write: () => void): Promise<void> {
  const instance = instanceExport();
  const before = instance?.sequence ?? 0;
  write();
  if (instance) await pastSequence(instance, before);
}

// A setting edit is a recompute trigger of its own, so its landing is awaited like a file
// write's; a later write would otherwise await past the setting's recompute, not its own.
async function setGameDirectory(dir: string | undefined): Promise<void> {
  const instance = instanceExport();
  const before = instance?.sequence ?? 0;
  await vscode.workspace.getConfiguration('modbench').update(
    'mods.gameDirectory', dir, vscode.ConfigurationTarget.Workspace);
  if (instance) await pastSequence(instance, before);
}

// The backend launches with the extension, so tests drive the lifecycle through activate()'s
// test-API exports: a launch failure is logged-and-swallowed after tearing editing down.
const editingApi = () => ext?.exports;
async function enterEditing(): Promise<void> {
  try {
    await editingApi()?.enterEditing?.();
  } catch {
    editingApi()?.exitEditing();
  }
}
function exitEditing(): void {
  editingApi()?.exitEditing();
}

// The same label-and-deadline shape as waitFor() below, for a push-based status transition
// rather than a polled condition.
function awaitStatus(client: MEditClient, status: BackendStatus, label: string, timeoutMs = 10_000): Promise<void> {
  if (client.status === status) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`timed out waiting for ${label}`)); }, timeoutMs);
    const off = client.onStatusChanged((s) => {
      if (s !== status) return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });
}

// Models the real backend: GET /plugins fails with 503 until PUT /load-order arrives. The
// response body IS the wire, so a body the backend could not produce is not a legal fixture.

// The load order holds every plugins.txt line, so a disabled one is browsable but never wins.
type MockPlugin = PluginMetadata;
function mockPlugin(over: Partial<PluginMetadata> & Pick<PluginMetadata, 'name' | 'path' | 'origin' | 'participates'>): MockPlugin {
  return {
    isLight: false, isMaster: false, masters: [], recordCount: 0, isImmutable: false,
    inLoadOrder: true, enabled: true, winning: true, masterIssues: [], hasMatchingRecords: true,
    isTracked: false,
    hasParseFailure: false,
    ...over,
  };
}
const MOCK_PLUGINS: MockPlugin[] = [
  mockPlugin({ name: 'Fallout4.esm', path: '/data/Fallout4.esm', origin: 'Data', participates: true }),
  mockPlugin({ name: 'TestMod.esp', path: '/data/TestMod.esp', origin: 'Data', participates: true }),
  mockPlugin({ name: 'Other.esp', path: '/data/Other.esp', origin: 'Data', participates: false }),
  // A plugins.txt line the backend reports read-only for editing, exercising the composite's
  // tooltip decoration end-to-end — distinct from ImplicitMasterNode's own lock icon.
  mockPlugin({ name: 'Immutable.esm', path: '/data/Immutable.esm', origin: 'Data', participates: true, isImmutable: true }),
  // ADR-0017: a plugin the backend flags with a directly-missing master. Every other entry carries
  // an empty `masterIssues`, which is what the backend sends when all masters resolved.
  mockPlugin({
    name: 'MissingMaster.esp', path: '/data/MissingMaster.esp', origin: 'Data', participates: true,
    masterIssues: [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' }],
  }),
];
const MOCK_RECORD_TYPES = [{ type: 'weap', count: 3, displayName: 'Weapon' }];
let loadOrderHeld = false;
const requestLog: string[] = [];
const putLoadOrders: string[][] = [];
// Each POST /records/{formKey}/edit the extension sends: the FormKey and the body, as mEdit gets them.
const recordEdits: { formKey: string; body: unknown }[] = [];

function pluginNamesOf(body: string): string[] {
  const parsed: unknown = JSON.parse(body);
  const plugins = typeof parsed === 'object' && parsed !== null && 'plugins' in parsed ? parsed.plugins : undefined;
  if (!Array.isArray(plugins)) throw new Error(`expected a PUT /load-order body with a plugins array, got: ${body}`);
  return plugins.map((p: unknown) => (typeof p === 'object' && p !== null && 'name' in p ? String(p.name) : '?'));
}
// Lets a test change what the *next* load reports without touching MOCK_PLUGINS itself —
// simulates a plugin's decoration-worthy state (a master issue, a load failure) changing between
// one load and a reload of the same load order.
let mockPluginsOverride: MockPlugin[] | null = null;
// GET /implicit-masters: the plugins this install loads with no plugins.txt line. Empty by
// default, so a suite's Data/ stubs are presence without being forced on.
let mockImplicitMasters: string[] = [];
// Makes GET /implicit-masters fail, so the client answers that mEdit cannot say.
let implicitMastersShouldFail = false;
// Makes the next PUT /load-order fail the way a bad game directory would. ADR-0013's contract
// disposes the previous scope first, so the mock must not set loadOrderHeld on this path.
let putLoadOrderShouldFail = false;
// Makes the next POST /index/rebuild fail the way another window holding the index would (423).
let rebuildIndexShouldFail = false;
// Makes the next GET /plugins fail the way a transient backend hiccup would mid-session —
// distinct from the 503 "no load order held" answer, which is a normal state, not a failure.
let getPluginsShouldFail = false;
// Mutable per-test so a suite can script a load landing one plugin at a time. `state` is carried
// even though the mEdit client drops it: it is non-nullable on the wire.
type MockLoadOrderStatus = {
  state: 'None' | 'Reconciling' | 'Ready' | 'HeldElsewhere' | 'Failed';
  totalPlugins: number;
  indexedPlugins: { name: string; origin: string }[];
  conflictsComputed: boolean;
  failures: { name: string; origin: string; reason: string }[];
  version: number;
  message?: string;
};
const NO_LOAD_ORDER_STATUS: MockLoadOrderStatus =
  { state: 'None', totalPlugins: 0, indexedPlugins: [], conflictsComputed: false, failures: [], version: 0 };
let loadOrderStatus: MockLoadOrderStatus = { ...NO_LOAD_ORDER_STATUS };
// The real Holder's counter: one higher per PUT, on the response and every tick answering it.
// Never reset, since a real mEdit numbers its versions from 1 only when it restarts.
let loadOrderVersion = 0;
// When set, PUT /load-order does not answer until the test releases it — the real backend's load
// blocks for the whole indexing run, and the progressive-load assertions are about that window.
let releasePutLoadOrder: (() => void) | null = null;
let holdPutLoadOrder = false;
// A test that holds PUT /load-order (holdPutLoadOrder = true) must release it — this fires the
// release, naming the precondition when the test forgot to hold it in the first place.
function releasePut(): void {
  if (!releasePutLoadOrder) throw new Error('expected PUT /load-order to be held (holdPutLoadOrder must be set) before releasing it');
  releasePutLoadOrder();
}
// The client's `start()` gates on GET /health, so holding it parks a launch in its first
// phase — the window a mid-load close also has to survive. One-shot: releasing clears the hold.
let releaseHealth: (() => void) | null = null;
let holdHealth = false;

// ADR-0014 invariant 2: the mock's SSE half. Pushed only where the real backend would publish
// (the PUT /load-order handler below), never on connect, which would reach no listener yet.
const sseClients: http.ServerResponse[] = [];

function writeSseFrame(res: http.ServerResponse, kind: string, payload: Record<string, unknown>): void {
  const data = JSON.stringify({ kind, plugin: '', origin: '', keys: [], sequence: 0, ...payload });
  res.write(`event: ${kind}\ndata: ${data}\n\n`);
}

function pushLoadOrderStatus(): void {
  for (const res of sseClients) writeSseFrame(res, 'load-order-status', { loadOrderStatus });
}

// The reset ends the mock's streams, and a stream the client reopens while attached is a connect
// that puts the load order again. A launch left attached by an earlier suite is stopped first.
async function resetMockBackendDetached(): Promise<void> {
  const client = ext?.exports.client;
  if (client?.status === 'attached') {
    exitEditing();
    await awaitStatus(client, 'stopped', 'the earlier launch to stop');
  }
  resetMockBackend();
}

function resetMockBackend(): void {
  loadOrderStatus = { ...NO_LOAD_ORDER_STATUS };
  loadOrderHeld = false;
  requestLog.length = 0;
  putLoadOrders.length = 0;
  recordEdits.length = 0;
  mockPluginsOverride = null;
  mockImplicitMasters = [];
  implicitMastersShouldFail = false;
  putLoadOrderShouldFail = false;
  rebuildIndexShouldFail = false;
  getPluginsShouldFail = false;
  holdPutLoadOrder = false;
  releasePutLoadOrder?.();
  releasePutLoadOrder = null;
  holdHealth = false;
  releaseHealth?.();
  releaseHealth = null;
  for (const res of sseClients.splice(0)) res.end();
}

// `conflictsComputed` stays false until a test says so: the winner sweep is a load's last step.
function setIndexed(names: string[], extra: Partial<MockLoadOrderStatus> = {}): void {
  loadOrderStatus = {
    state: 'Reconciling',
    totalPlugins: Math.max(names.length, loadOrderStatus.totalPlugins),
    indexedPlugins: names.map((name) => ({ name, origin: 'Data' })),
    conflictsComputed: false,
    failures: [],
    version: loadOrderVersion,
    ...extra,
  };
  pushLoadOrderStatus();
}

function createMockBackend(): http.Server {
  return http.createServer((req, res) => {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';
    requestLog.push(`${method} ${url}`);
    if (url === '/health') {
      const answer = () => { res.writeHead(200); res.end(); };
      if (!holdHealth) return answer();
      holdHealth = false; // one-shot — only the launch's first probe is parked
      releaseHealth = () => { releaseHealth = null; answer(); };
      return;
    }
    if (method === 'POST' && url === '/index/rebuild') {
      req.on('data', () => {});
      req.on('end', () => {
        if (rebuildIndexShouldFail) {
          res.writeHead(423, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ detail: 'This instance\'s index is open in another Modbench window.' }));
          return;
        }
        res.writeHead(204);
        res.end();
        // The real rebuild answers once the index is empty, then refills it against the load order
        // it holds, as a cold load does: dropped, reconciling, then Ready at the version held.
        if (!loadOrderHeld) return;
        const held = loadOrderStatus;
        for (const state of ['None', 'Reconciling'] as const) {
          loadOrderStatus = { ...held, state, indexedPlugins: [], conflictsComputed: false };
          pushLoadOrderStatus();
        }
        loadOrderStatus = { ...held, state: 'Ready', conflictsComputed: true };
        pushLoadOrderStatus();
      });
      return;
    }
    if (method === 'PUT' && url === '/load-order') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        putLoadOrders.push(pluginNamesOf(body));
        // ADR-0013: a failed PUT leaves whatever the backend already held in place — nothing is
        // torn down — so `loadOrderHeld` is not touched here.
        if (putLoadOrderShouldFail) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'simulated load failure' }));
          return;
        }
        // One higher per PUT, like the real Holder's own Apply — carried on the wire response
        // and on every status tick answering for it.
        loadOrderVersion += 1;
        const version = loadOrderVersion;
        // The real load publishes its progress from the moment it starts, which is why the
        // extension subscribes before the PUT.
        loadOrderStatus = { ...loadOrderStatus, version };
        pushLoadOrderStatus();

        // The real load blocks for the whole indexing run. Held open so a test can observe
        // the tree mid-load; answered immediately otherwise, as most suites expect.
        const answer = () => {
          loadOrderHeld = true;
          // The real PUT answers before the sweep, which runs on Load order state's own
          // subscriber — modeled here as the terminal tick this answer publishes alongside it.
          loadOrderStatus = { ...loadOrderStatus, state: 'Ready', conflictsComputed: true, version };
          pushLoadOrderStatus();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ applied: true, version }));
        };
        // One-shot, like the health hold: the first PUT is the launch's cold reconcile and is
        // parked; a follow-up snapshot (a watcher event coalesced behind it) is the real backend's
        // no-op reconcile and answers at once.
        if (!holdPutLoadOrder) return answer();
        holdPutLoadOrder = false;
        // The real backend's first tick lands once Reconcile is under way, after this PUT lands —
        // which is also after HttpMEditClient.putLoadOrder has subscribed.
        pushLoadOrderStatus();
        releasePutLoadOrder = () => { releasePutLoadOrder = null; answer(); };
      });
      return;
    }
    // Answers 200 in every state including "no load order" — reporting the absence of
    // a load order is this endpoint's job, not a failure to do it (LoadOrderEndpoints.cs).
    if (url === '/load-order/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(loadOrderStatus));
      return;
    }
    if (url === '/load-order/filter') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sql: null }));
      return;
    }
    if (url === '/notifications/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': connected\n\n');
      sseClients.push(res);
      req.on('close', () => {
        const i = sseClients.indexOf(res);
        if (i >= 0) sseClients.splice(i, 1);
      });
      return;
    }
    if (url === '/plugins') {
      if (!loadOrderHeld) {
        res.writeHead(503);
        res.end('No load order has been received.');
        return;
      }
      if (getPluginsShouldFail) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'simulated plugin-list failure' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mockPluginsOverride ?? MOCK_PLUGINS));
      return;
    }
    // Answered from the game directory alone, with no load order held — the Plugins rows and
    // plugin sync both ask it before any PUT (ADR-0016).
    if (url.startsWith('/implicit-masters')) {
      if (implicitMastersShouldFail) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'simulated implicit-masters failure' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mockImplicitMasters));
      return;
    }
    const edit = /^\/records\/([^/]+)\/edit$/.exec(url);
    if (method === 'POST' && edit) {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        recordEdits.push({ formKey: decodeURIComponent(edit[1] ?? ''), body: JSON.parse(body) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ applied: true }));
      });
      return;
    }
    // A plugin row's children come from here once the backend is running.
    if (/^\/plugins\/[^/]+\/record-types$/.test(url)) {
      res.writeHead(loadOrderHeld ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(loadOrderHeld ? JSON.stringify(MOCK_RECORD_TYPES) : 'No load order has been received.');
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

// Start a mock backend that answers GET /health → 200 so the extension reaches
// 'attached'. /plugins is load-order-gated (see above). Uses port 15172 (set via
// workspace settings).
before(async function () {
  this.timeout(15000);

  // The mock backend must be up before the extension activates so
  // the client's first health poll succeeds.
  mockBackend = createMockBackend();
  await new Promise<void>(r => mockBackend.listen(TEST_PORT, '127.0.0.1', () => r()));

  // The extension must auto-activate via onStartupFinished (no manual
  // activate() call here) — that's the behavior under test. Poll rather than
  // assume, since activation timing after workbench restore isn't instant.
  // packageJSON's type is `any`; isRecord narrows it.
  ext = vscode.extensions.all.find(e => isRecord(e.packageJSON) && e.packageJSON.name === 'modbench');
  const deadline = Date.now() + 5000;
  while (ext && !ext.isActive && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
  }

  // The client polls the mock backend's health on its own schedule; wait for the transition
  // itself rather than guessing how long a poll cycle takes.
  const client = ext?.exports.client;
  if (client) await awaitStatus(client, 'attached', 'the client to reach attached');
});

after(async () => {
  // A PUT a test held open and then abandoned client-side leaves its keep-alive socket parked on
  // the server; close() would wait on it forever.
  mockBackend.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    mockBackend.close(err => (err ? reject(err) : resolve()))
  );
});

// ── Activation ───────────────────────────────────────────────────────────────────

describe('modbench activation', () => {
  it('auto-activates on startup without any explicit activate() call', () => {
    assert.ok(ext?.isActive, 'expected the extension to auto-activate via onStartupFinished');
  });

  it('answers the instance check for an instance folder: instance', () => {
    assert.strictEqual(ext?.exports.folder, 'instance');
  });

  it('marks the first read once the Instance lands a value', async () => {
    await pastSequence(present(instanceExport(), 'the Instance export'), 0);
    assert.strictEqual(ext?.exports.instanceRead(), true);
  });

  // The pre-activation welcome flash is not testable: it lives between workspace open and
  // activation, and no API exposes whether `viewsWelcome` is showing. Manual check only.
});

// ── Build integrity ────────────────────────────────────────────────────────────
// The harness loads out/extension.js, a bundle from a separate esbuild step; nothing forces it
// to be current, so freshness is asserted from inside the process that loaded it.

describe('the loaded extension bundle is not older than its sources', () => {
  it('out/extension.js is at least as new as every file under src/', () => {
    // Compiled location is out/test/integration/extension.test.js — three levels under
    // the modbench package root.
    const pkgRoot = path.join(__dirname, '..', '..', '..');
    const srcDir = path.join(pkgRoot, 'src');
    const bundlePath = path.join(pkgRoot, 'out', 'extension.js');
    // The workspace fixture is live — other suites write into it mid-run, so its mtimes churn
    // independently of any bundle-affecting source edit. It is not part of the bundle either.
    const excluded = path.join(srcDir, 'test', 'integration', 'workspace');

    let newestMtimeMs = -Infinity;
    let newestFile = '';
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (full === excluded) continue;
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          const mtimeMs = fs.statSync(full).mtimeMs;
          if (mtimeMs > newestMtimeMs) {
            newestMtimeMs = mtimeMs;
            newestFile = full;
          }
        }
      }
    };
    walk(srcDir);

    const bundleMtimeMs = fs.statSync(bundlePath).mtimeMs;
    assert.ok(
      bundleMtimeMs >= newestMtimeMs,
      `out/extension.js (mtime ${new Date(bundleMtimeMs).toISOString()}) is older than ` +
      `${newestFile} (mtime ${new Date(newestMtimeMs).toISOString()}) — the harness ran ` +
      `against a stale bundle`,
    );
  });
});

// ── Output channel ──────────────────────────────────────────────────────────────

describe('Modbench output channel', () => {
  it('is created as a leveled LogOutputChannel, not a plain text channel', () => {
    const channel = ext?.exports.outputChannel;
    assert.ok(channel, 'activate() should return { outputChannel }');
    // A plain vscode.OutputChannel has none of these — only { log: true } adds them.
    assert.strictEqual(typeof channel.debug, 'function', 'expected a .debug() method');
    assert.strictEqual(typeof channel.info, 'function', 'expected an .info() method');
    assert.strictEqual(typeof channel.warn, 'function', 'expected a .warn() method');
    assert.strictEqual(typeof channel.error, 'function', 'expected an .error() method');
    assert.ok('logLevel' in channel, "expected VS Code's native level filter to apply (logLevel)");
  });
});

// ── Command registration ───────────────────────────────────────────────────────

// This file's one parse point for package.json's contributed commands: proves the shape this
// suite reads rather than handing back an unproven one.
function commandsManifest(raw: unknown): { contributes: { commands: { command: string }[] } } {
  if (
    !isRecord(raw) || !isRecord(raw.contributes) || !Array.isArray(raw.contributes.commands)
    || !raw.contributes.commands.every((c: unknown): c is { command: string } => isRecord(c) && typeof c.command === 'string')
  ) {
    throw new Error("expected package.json to have a contributes.commands array of { command }");
  }
  return { contributes: { commands: raw.contributes.commands } };
}

describe('modbench command registration', () => {
  // Derived from package.json rather than hand-copied, so a contributed command that was never
  // registered fails here instead of matching a hand-written list that forgot it too. __dirname is
  // three levels under the package root once compiled.
  const pkg = commandsManifest(JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
  ));
  const EXPECTED_COMMANDS = pkg.contributes.commands.map((c) => c.command);

  it('registers all expected commands on activation', async () => {
    // A derived list can go silently empty (renamed contributes.commands) in a way a hand-typed
    // array could not, leaving the loop below asserting nothing while still passing.
    assert.ok(EXPECTED_COMMANDS.length > 0, 'derived command list is empty — the manifest shape changed');
    const all = await vscode.commands.getCommands(/* filterInternal */ true);
    for (const cmd of EXPECTED_COMMANDS) {
      assert.ok(all.includes(cmd), `Command not registered: ${cmd}`);
    }
  });
});

// commands.md, The system commands: mod sync takes the instance value as its Argument.
describe('modbench.mod.sync syncs the instance value it is handed', () => {
  // A profile the landed value does not name, so no run of the trigger writes its modlist.txt.
  const PROFILE = 'Handed Profile';
  const root = present(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, 'the workspace folder');
  const profileDir = path.join(root, 'profiles', PROFILE);

  after(() => fs.rmSync(profileDir, { recursive: true, force: true }));

  it('drops the line of a gone folder from the profile the handed value names', async () => {
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'modlist.txt'), '+Gone Mod\r\n');
    const instance = present(instanceExport(), "the activated extension's instance export");

    await vscode.commands.executeCommand('modbench.mod.sync', { ...instance.value, activeProfile: PROFILE });

    assert.strictEqual(fs.readFileSync(path.join(profileDir, 'modlist.txt'), 'utf8'), '');
  });
});

// ── openEditor ────────────────────────────────────────────────────────────────

const openTabs = () => vscode.window.tabGroups.all.flatMap(g => g.tabs);

describe('modbench.openEditor', () => {
  it('opens a new webview tab when no panel exists', async () => {
    const tabsBefore = openTabs().length;

    await vscode.commands.executeCommand('modbench.openEditor', {
      formKey: 'Fallout4.esm:000001',
      label: 'Test Record',
    });

    const tabsAfter = await waitFor('a new tab after openEditor', () => {
      const count = openTabs().length;
      return count > tabsBefore ? count : undefined;
    });
    assert.ok(tabsAfter > tabsBefore, 'Expected a new tab to be opened by modbench.openEditor');
  });

  it('reuses the existing panel on a second call', async () => {
    const tabsAfterFirst = openTabs().length;

    await vscode.commands.executeCommand('modbench.openEditor', {
      formKey: 'Fallout4.esm:000002',
      label: 'Another Record',
    });

    // The reused panel's own title update is what proves the call landed at all.
    await waitFor('the reused panel to retitle', () => openTabs().some(t => t.label === 'Another Record') || undefined);

    const tabsAfterSecond = openTabs().length;
    assert.strictEqual(
      tabsAfterSecond,
      tabsAfterFirst,
      'Second modbench.openEditor call should reuse the existing panel, not open a new tab'
    );
  });

  it('updates the panel title when opened for a different record', async () => {
    await vscode.commands.executeCommand('modbench.openEditor', {
      formKey: 'Fallout4.esm:000010',
      label: 'First Record',
    });
    await waitFor('the panel titled "First Record"', () => openTabs().some(t => t.label === 'First Record') || undefined);

    await vscode.commands.executeCommand('modbench.openEditor', {
      formKey: 'Fallout4.esm:000011',
      label: 'Second Record',
    });
    await waitFor('the panel to retitle to "Second Record"', () => openTabs().some(t => t.label === 'Second Record') || undefined);

    const tabs = openTabs();
    const editTab = tabs.find(t => t.label.startsWith('First Record') || t.label.startsWith('Second Record'));
    assert.ok(editTab, 'Expected an mEdit tab to exist');
    assert.strictEqual(editTab.label, 'Second Record', 'Panel title should update to the most recently opened record');
  });
});

// ── modbench.openEditorBeside ───────────────────────────────────────────────────
// Reachable from the Referenced By tree's group rows (plain {formKey,label} shape) and
// from the Plugins tree's record/placed-reference rows (RecordNode/PlacedNode
// shapes, single or multi-selected).

describe('modbench.openEditorBeside', () => {
  it('opens a plain {formKey,label}-shaped target as a genuinely new tab, never retargeting the singleton', async () => {
    // Seed the singleton with a known title first: an implementation that routed through the
    // singleton/retarget path would retarget this panel instead of opening a new tab.
    await vscode.commands.executeCommand('modbench.openEditor', { formKey: 'Fallout4.esm:000020', label: 'Seed Record' });
    await waitFor('the seed panel', () => openTabs().some(t => t.label === 'Seed Record') || undefined);

    const tabsBefore = openTabs().length;

    await vscode.commands.executeCommand('modbench.openEditorBeside', { formKey: 'Fallout4.esm:000021', label: 'Beside Record' });
    await waitFor('the Beside-opened tab', () => openTabs().some(t => t.label === 'Beside Record') || undefined);

    const tabs = openTabs();
    assert.strictEqual(tabs.length, tabsBefore + 1, 'expected a genuinely new tab, not a retarget of the existing singleton');
    assert.ok(tabs.some(t => t.label === 'Seed Record'), 'the singleton panel must still show its own record, untouched');
    assert.ok(tabs.some(t => t.label === 'Beside Record'), 'expected a new tab for the Beside-opened record');
  });

  it('resolves a Plugins-tree RecordNode-shaped argument to its own record', async () => {
    const tabsBefore = openTabs().length;

    await vscode.commands.executeCommand('modbench.openEditorBeside', {
      kind: 'record',
      record: { formKey: 'Fallout4.esm:000030', plugin: 'Fallout4.esm', editorId: 'TestRecord' },
      origin: 'Data',
      label: 'TestRecord [Fallout4.esm:000030]',
    });
    await waitFor('the RecordNode-opened tab',
      () => openTabs().some(t => t.label === 'TestRecord [Fallout4.esm:000030]') || undefined);

    const tabs = openTabs();
    assert.strictEqual(tabs.length, tabsBefore + 1, 'expected exactly one new tab');
    assert.ok(
      tabs.some(t => t.label === 'TestRecord [Fallout4.esm:000030]'),
      "expected the tab to carry the RecordNode's own label, not a blank/mEdit placeholder"
    );
  });

  it('resolves a Plugins-tree PlacedNode-shaped argument (placed-reference row) to its own record', async () => {
    const tabsBefore = openTabs().length;

    await vscode.commands.executeCommand('modbench.openEditorBeside', {
      kind: 'placed',
      placed: { formKey: 'Fallout4.esm:000040', recordType: 'refr', editorId: 'TestRef' },
      origin: 'Data',
      label: 'TestRef [REFR:000040]',
    });
    await waitFor('the PlacedNode-opened tab', () => openTabs().some(t => t.label === 'TestRef [REFR:000040]') || undefined);

    const tabs = openTabs();
    assert.strictEqual(tabs.length, tabsBefore + 1, 'expected exactly one new tab');
    assert.ok(
      tabs.some(t => t.label === 'TestRef [REFR:000040]'),
      "expected the tab to carry the PlacedNode's own label, not a blank/mEdit placeholder"
    );
  });

  it('two sequential single-target opens land as two separate tabs — neither retargets the other', async () => {
    const tabsBefore = openTabs().length;

    await vscode.commands.executeCommand('modbench.openEditorBeside', { formKey: 'Fallout4.esm:000050', label: 'First Beside' });
    await waitFor('the first Beside tab', () => openTabs().some(t => t.label === 'First Beside') || undefined);
    await vscode.commands.executeCommand('modbench.openEditorBeside', { formKey: 'Fallout4.esm:000051', label: 'Second Beside' });
    await waitFor('the second Beside tab', () => openTabs().some(t => t.label === 'Second Beside') || undefined);

    const tabs = openTabs();
    assert.strictEqual(tabs.length, tabsBefore + 2, 'expected two separate new tabs');
    assert.ok(tabs.some(t => t.label === 'First Beside'), 'first Beside panel should still show its own record');
    assert.ok(tabs.some(t => t.label === 'Second Beside'), 'second Beside panel should show its own record');
  });

  it('a multi-selection opens one panel per record, all landing in a single new editor group beside the active one', async () => {
    const groupsBefore = vscode.window.tabGroups.all.length;
    const tabsBefore = openTabs().length;

    const selection = [
      { formKey: 'Fallout4.esm:000060', label: 'Multi A' },
      { formKey: 'Fallout4.esm:000061', label: 'Multi B' },
      { formKey: 'Fallout4.esm:000062', label: 'Multi C' },
    ];
    await vscode.commands.executeCommand('modbench.openEditorBeside', selection[0], selection);
    // Both conditions: a tab can carry its label before the group it landed in finishes
    // settling, and settling into one group (not one per record) is the behavior under test.
    await waitFor('every multi-selected tab in one new group', () =>
      (selection.every((s) => openTabs().some((t) => t.label === s.label))
        && vscode.window.tabGroups.all.length === groupsBefore + 1) || undefined);

    const groupsAfter = vscode.window.tabGroups.all.length;
    const tabs = openTabs();
    assert.strictEqual(groupsAfter, groupsBefore + 1, 'expected exactly one new editor group, not one per record');
    assert.strictEqual(tabs.length, tabsBefore + 3, 'expected three new tabs, one per selected record');
    for (const s of selection) {
      assert.ok(tabs.some(t => t.label === s.label), `expected a tab for ${s.label}`);
    }
  });
});

// ── modbench.openHeader reachable from every plugin-bearing row ─────────────────
// The implicit-master row is a different class with a different contextValue and no `.plugin`
// field, so the handler's node-shape handling, not package.json's `when`, keeps it working.
import { PluginNode as PluginListPluginNode, ImplicitMasterNode } from '../../plugins/PluginsTreeProvider';
import { ImplicitMasterDecorationProvider } from '../../plugins/ImplicitMasterDecorationProvider';
import { publishLoadDiagnoses } from '../../medit/loadDiagnostics';
// esbuild bundles the running extension's own `PluginTreeProvider` inline, so a class imported
// here from source is a distinct constructor — `.kind` is what identifies a node across that
// boundary, the same discriminant `PluginsTreeProvider.ts` switches on internally.
function nodeKind(node: unknown): unknown {
  const fields: { kind?: unknown } = typeof node === 'object' && node !== null ? node : {};
  return fields.kind;
}

describe('modbench.openHeader reachable from every plugin-bearing row of the merged tree', () => {
  it('opens a header tab from an ordinary plugin row (PluginsTreeProvider.PluginNode)', async () => {
    const node = new PluginListPluginNode({ name: 'TestMod.esp', enabled: true });
    await vscode.commands.executeCommand('modbench.openHeader', node);
    await waitFor('a header tab for TestMod.esp', () => openTabs().some(t => t.label === 'TestMod.esp') || undefined);
  });

  it('opens a header tab from an implicit-master row (PluginsTreeProvider.ImplicitMasterNode)', async () => {
    const node = new ImplicitMasterNode('Fallout4.esm');
    await vscode.commands.executeCommand('modbench.openHeader', node);
    await waitFor('a header tab for Fallout4.esm', () => openTabs().some(t => t.label === 'Fallout4.esm') || undefined);
  });
});

// plugins.md, A plugin the game loads with no line: the row table draws a greyed label and no
// Problems badge, and VS Code badges any tree row whose resourceUri carries diagnostics.
describe('the locked row is greyed and carries no Problems badge', () => {
  const dataFolder = path.join(os.tmpdir(), 'locked-row-game', 'Data');
  const node = new ImplicitMasterNode('Fallout4.esm', path.join(dataFolder, 'Fallout4.esm'));
  const collection = vscode.languages.createDiagnosticCollection('locked-row-test');
  after(() => collection.dispose());

  it('holds none of the diagnostics published on its plugin file', () => {
    publishLoadDiagnoses(collection, () => dataFolder, [{ plugin: 'Fallout4.esm', origin: 'Data', defectClass: 'malformed', message: 'malformed', text: 'malformed' }]);

    const rowUri = present(node.resourceUri, 'the locked row\'s resourceUri');
    assert.deepStrictEqual(vscode.languages.getDiagnostics(rowUri), []);
  });

  it('is greyed', () => {
    const rowUri = present(node.resourceUri, 'the locked row\'s resourceUri');
    const provider = new ImplicitMasterDecorationProvider(() => new Set([rowUri.toString()]));

    assert.deepStrictEqual(provider.provideFileDecoration(rowUri)?.color, new vscode.ThemeColor('disabledForeground'));
    assert.strictEqual(provider.provideFileDecoration(vscode.Uri.file(path.join(dataFolder, 'Fallout4.esm'))), undefined);
  });
});

// ── modbench.downloads tree ─────────────────────────────────────────────────

// Longer than the Instance's 200 ms settle: every write restarts that settle, so probes written
// any faster would hold every recompute off.
const PROBE_SPACING_MS = 1000;
function nextLandingWithin(instance: InstanceLike, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      subscription.dispose();
      resolve();
    };
    const timer = setTimeout(done, ms);
    const subscription = instance.subscribe(done);
  });
}

// A row this tree does not own (an ErrorNode) carries no archive name — undefined, not thrown.
const archiveNameOf = (row: DownloadsTreeNode): string | undefined =>
  row instanceof DownloadNode ? row.row.name : undefined;

describe('modbench.downloads tree', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const downloadsDir = root ? path.join(root, 'downloads') : '';
  const provider = () => present(ext?.exports.downloadsProvider, "the activated extension's downloadsProvider export");
  const instance = () => present(instanceExport(), 'the Instance activate() exports');
  const iniPath = root ? path.join(root, 'ModOrganizer.ini') : '';

  // Past the rebind, its extra recompute and any recompute queued behind them, only a watcher
  // event lands a new value, so a row that appears later is the watcher's doing.
  async function repointDownloads(iniText: string, dir: string): Promise<void> {
    fs.writeFileSync(iniPath, iniText);
    const rebound = await waitFor(`the Instance to resolve downloads to ${dir}`,
      () => (instance().value.paths.downloadsDir === dir ? instance().sequence : undefined));
    await pastSequence(instance(), rebound);
    for (let landed = instance().sequence; ; landed = instance().sequence) {
      await nextLandingWithin(instance(), PROBE_SPACING_MS);
      if (instance().sequence === landed) return;
    }
  }

  // A just-bound watch arms some time after it is created and nothing reports when, so a probe
  // written before then is lost and another follows it.
  async function probeUntilListed(dir: string, prefix: string): Promise<void> {
    const written = new Set<string>();
    await waitFor(`a file written into ${dir} to reach the Downloads tree through the watcher`, async () => {
      const name = `${prefix}-${written.size}.zip`;
      written.add(name);
      fs.writeFileSync(path.join(dir, name), 'data');
      await nextLandingWithin(instance(), PROBE_SPACING_MS);
      const rows = await provider().getChildren();
      return rows.some((r) => written.has(archiveNameOf(r) ?? '')) || undefined;
    }, 35000);
  }

  // The committed test workspace fixture has no downloads/ folder — created and torn down
  // here (mirrors the Overwrite suite's overwriteDir cleanup).
  after(() => {
    if (!root) return;
    fs.rmSync(downloadsDir, { recursive: true, force: true });
  });

  it('exposes the live DownloadsProvider from activate()', () => {
    assert.ok(provider(), 'activate() should return { downloadsProvider } for the open workspace');
  });

  // Rows come from the Instance value (ADR-0015): written through writeAndAwaitInstance and
  // read back with no direct call to the provider's own invalidate().
  it('renders one row per archive, .meta sidecars suppressed', async () => {
    await writeAndAwaitInstance(() => {
      fs.mkdirSync(downloadsDir, { recursive: true });
      fs.writeFileSync(path.join(downloadsDir, 'foo.zip'), 'data');
      fs.writeFileSync(path.join(downloadsDir, 'foo.zip.meta'), '[General]\r\n');
    });

    const rows = await provider().getChildren();
    assert.deepStrictEqual(rows.map((r) => archiveNameOf(r)), ['foo.zip']);
  });

  it('reflects a new archive dropped into downloads/ via the file-watcher, with no manual refresh', async () => {
    fs.writeFileSync(path.join(downloadsDir, 'bar.zip'), 'data');

    // The watcher debounces 200ms before calling invalidate() itself, so poll for the row rather
    // than sleeping a fixed time. Never calls invalidate() directly: the watcher must do it alone.
    const rows = await waitFor('bar.zip via the watcher', async () => {
      const found = await provider().getChildren();
      return found.some((r) => archiveNameOf(r) === 'bar.zip') ? found : undefined;
    }, 10000);
    assert.ok(rows.some((r) => archiveNameOf(r) === 'bar.zip'), 'expected bar.zip among the watcher-refreshed rows');
  });

  // downloads.md, story 1: `download_directory` can name a folder outside the instance. This
  // proves VS Code's real watcher fires for one, not just that it was asked to.
  it('scans and watches a downloads folder ModOrganizer.ini points outside the instance', async function () {
    this.timeout(40000);
    if (!root) throw new Error('no open workspace');
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-external-downloads-'));
    const originalIni = fs.readFileSync(iniPath, 'utf8');
    try {
      fs.writeFileSync(path.join(external, 'external-preexisting.zip'), 'data');
      await repointDownloads(`${originalIni}[Settings]\r\ndownload_directory=${external}\r\n`, external);

      const scanned = await provider().getChildren();
      assert.ok(
        scanned.some((r) => archiveNameOf(r) === 'external-preexisting.zip'),
        'expected the file already in the external folder to be scanned once the ini named it',
      );

      await probeUntilListed(external, 'external-new');
    } finally {
      await repointDownloads(originalIni, downloadsDir);
      fs.rmSync(external, { recursive: true, force: true });
    }
  });

  // The ruling's own ENOENT-is-empty state applies before the folder exists at all, not only
  // once MO2 has created it — this proves the watch survives that gap too.
  it('watches a downloads folder ModOrganizer.ini points at before it exists on disk', async function () {
    this.timeout(40000);
    if (!root) throw new Error('no open workspace');
    const container = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-notyet-downloads-'));
    const notYetCreated = path.join(container, 'NotYetCreated');
    const originalIni = fs.readFileSync(iniPath, 'utf8');
    try {
      await repointDownloads(`${originalIni}[Settings]\r\ndownload_directory=${notYetCreated}\r\n`, notYetCreated);

      const beforeCreate = await provider().getChildren();
      assert.strictEqual(beforeCreate.filter((r) => archiveNameOf(r) !== undefined).length, 0,
        'expected no rows before the configured folder even exists');

      fs.mkdirSync(notYetCreated);
      await probeUntilListed(notYetCreated, 'created');
    } finally {
      await repointDownloads(originalIni, downloadsDir);
      fs.rmSync(container, { recursive: true, force: true });
    }
  });
});

// ── Overwrite row ──────────────────────────────────────────────────────────────

describe('Overwrite row', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const overwriteDir = root ? path.join(root, 'overwrite') : '';
  const provider = () => present(ext?.exports.modListProvider, "the activated extension's modListProvider export");

  // The pinned Overwrite row is appended only once the modlist loads (it sits
  // after the mod roots). The committed test workspace fixture is
  // already a minimal valid MO2 instance — only the suite-scoped overwrite/
  // dir needs cleanup here.
  after(() => {
    if (!root) return;
    fs.rmSync(overwriteDir, { recursive: true, force: true });
  });

  it('exposes the live ModListProvider from activate()', () => {
    assert.ok(provider(), 'activate() should return { modListProvider } for the open workspace');
  });

  it('shows a pinned Overwrite row (last, outside grouping) when overwrite/ is non-empty', async () => {
    // The count is a field of the Instance value now (ADR-0015) — awaited past a sequence,
    // rather than assuming a fresh disk read the instant invalidate() is called.
    await writeAndAwaitInstance(() => {
      fs.mkdirSync(overwriteDir, { recursive: true });
      fs.writeFileSync(path.join(overwriteDir, 'f4se.log'), 'x');
    });

    const roots = await provider().getChildren();
    const last = present(roots[roots.length - 1], 'the last root');
    assert.strictEqual(last.kind, 'overwrite', 'Overwrite row should be the very last root');
    assert.strictEqual(last.label, 'Overwrite');
  });

  it('reveal action resolves against the overwrite folder without throwing', async () => {
    const p = provider();
    const roots = await p.getChildren();
    const node = roots.find((n) => n.kind === 'overwrite');
    assert.ok(node, 'expected an Overwrite node to reveal');
    await vscode.commands.executeCommand('modbench.mod.openFolder', node);
  });

  it('keeps the Overwrite row, with no count, once overwrite/ is emptied', async () => {
    await writeAndAwaitInstance(() => {
      fs.rmSync(overwriteDir, { recursive: true, force: true });
    });
    const roots = await provider().getChildren();
    const overwrite = present(roots.find((n) => n.kind === 'overwrite'), 'the Overwrite row');
    assert.strictEqual(overwrite.description, undefined);
  });
});

// ── A Mods gesture's write reaches the view through the watch alone ──────────────

// VS Code's delete-to-trash on Linux writes the freedesktop.org Trash; the extension's trash
// cannot be doubled, since `vscode.workspace.fs.delete` cannot be redefined. Elsewhere a run leaves
// its trashed folder in the OS trash.
const xdgTrash = path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'Trash');
const trashInfoDir = path.join(xdgTrash, 'info');
const TRASH_INFO = '.trashinfo';

function trashInfoNames(): ReadonlySet<string> {
  return new Set(fs.existsSync(trashInfoDir) ? fs.readdirSync(trashInfoDir) : []);
}

// Takes each entry trashed from `original` since `before` out of the OS trash, answering how many.
function takeFromTrash(original: string, before: ReadonlySet<string>): number {
  let taken = 0;
  for (const info of trashInfoNames()) {
    if (before.has(info) || !info.endsWith(TRASH_INFO)) continue;
    const pathLine = fs.readFileSync(path.join(trashInfoDir, info), 'utf8').split('\n').find((l) => l.startsWith('Path='));
    if (pathLine === undefined || decodeURIComponent(pathLine.slice('Path='.length)) !== original) continue;
    fs.rmSync(path.join(xdgTrash, 'files', info.slice(0, -TRASH_INFO.length)), { recursive: true, force: true });
    fs.rmSync(path.join(trashInfoDir, info));
    taken++;
  }
  return taken;
}

// ADR-0015 invariant 2: the gesture writes modlist.txt and returns, and the view follows the value
// the watch lands, as it would a change from MO2.
describe('A Mods gesture\'s write reaches the Mods view through the watch alone', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const modlistPath = root ? path.join(root, 'profiles', 'Default', 'modlist.txt') : '';
  const provider = () => present(ext?.exports.modListProvider, "the activated extension's modListProvider export");
  const instance = () => present(instanceExport(), 'the Instance activate() exports');
  const separatorRow = async (name: string) =>
    (await provider().getChildren()).find((n) => n.kind === 'separator' && n.label === name);
  const doomedDir = root ? path.join(root, 'mods', 'Doomed_separator') : '';
  let original = '';
  let trashedBefore: ReadonlySet<string> = new Set();

  before(async () => {
    if (!root) return;
    trashedBefore = trashInfoNames();
    original = fs.readFileSync(modlistPath, 'utf8');
    await writeAndAwaitInstance(() => {
      fs.mkdirSync(doomedDir, { recursive: true });
      fs.writeFileSync(modlistPath, '-Doomed_separator\r\n');
    });
  });

  after(async () => {
    if (!root) return;
    takeFromTrash(doomedDir, trashedBefore);
    await writeAndAwaitInstance(() => {
      fs.rmSync(doomedDir, { recursive: true, force: true });
      fs.writeFileSync(modlistPath, original);
    });
  });

  it('delete separator asks for no refresh, and its row goes when the watch lands the new value', async function () {
    if (!root) this.skip();
    const doomed = present(await separatorRow('Doomed'), 'the Doomed separator row');
    let refreshes = 0;
    const listening = provider().onDidChangeTreeData(() => { refreshes++; });
    const before = instance().sequence;

    try {
      await vscode.commands.executeCommand('modbench.separator.delete', doomed);

      assert.ok(!fs.readFileSync(modlistPath, 'utf8').includes('Doomed'), 'the delete should have written modlist.txt');
      assert.ok(!fs.existsSync(doomedDir), 'the delete should have taken the separator\'s folder from mods/');
      if (process.platform === 'linux') {
        assert.strictEqual(takeFromTrash(doomedDir, trashedBefore), 1, 'the separator\'s folder should be in the OS trash');
      }
      assert.strictEqual(instance().sequence, before, 'the watch landed a value before the gesture returned; nothing is proved');
      assert.strictEqual(refreshes, 0, 'the gesture asked the view for a refresh after its write');

      await pastSequence(instance(), before);
      assert.strictEqual(await separatorRow('Doomed'), undefined, 'the watch\'s value should have taken the row away');
    } finally {
      listening.dispose();
    }
  });
});

// ── The Mods tree's expansion in a running host ──────────────────────────────

// Which rows VS Code shows expanded is observable only as the children it asks the provider for:
// a collapsed separator's children are never asked for.
describe('The Mods tree\'s expansion, as VS Code renders it', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const modlistPath = root ? path.join(root, 'profiles', 'Default', 'modlist.txt') : '';
  const modDirs = root ? ['Armor Pack', 'Weapons', 'Late Armor'].map((name) => path.join(root, 'mods', name)) : [];
  // Mod sync drops a separator line whose folder is gone, as it does a mod's.
  const gearDir = root ? path.join(root, 'mods', 'Gear_separator') : '';
  const provider = () => present(ext?.exports.modListProvider, "the activated extension's modListProvider export");
  let original = '';
  let asked: string[] = [];
  let restore = () => {};

  const gearExpanded = () => asked.includes('separator:Gear');
  const renderAfter = async (change: () => unknown): Promise<void> => {
    asked = [];
    await change();
    await waitFor('the view to ask for its roots', () => asked.includes('root'));
    await new Promise((r) => setTimeout(r, 750));
  };
  const onTheSeparator = async (command: 'list.expand' | 'list.collapse') => {
    await vscode.commands.executeCommand('modbench.modList.focus');
    await vscode.commands.executeCommand('list.focusFirst');
    await vscode.commands.executeCommand(command);
  };

  before(async () => {
    if (!root) return;
    original = fs.readFileSync(modlistPath, 'utf8');
    const p = provider();
    const getChildren = p.getChildren.bind(p);
    p.getChildren = (element) => {
      asked.push(element?.id ?? 'root');
      return getChildren(element);
    };
    restore = () => { p.getChildren = getChildren; };
    await writeAndAwaitInstance(() => {
      for (const dir of [...modDirs.slice(0, 2), gearDir]) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(modlistPath, '+Armor Pack\r\n+Weapons\r\n-Gear_separator\r\n');
    });
  });

  after(async () => {
    restore();
    provider().setFilter('', true);
    if (!root) return;
    await writeAndAwaitInstance(() => {
      fs.writeFileSync(modlistPath, original);
      for (const dir of [...modDirs, gearDir]) fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  it('renders a separator collapsed on a fresh view', async function () {
    if (!root) this.skip();
    await renderAfter(() => vscode.commands.executeCommand('modbench.modList.focus'));
    assert.ok(!gearExpanded(), `a fresh view expanded the separator: ${JSON.stringify(asked)}`);
  });

  it('expands a separator it already rendered collapsed, while a filter shows it for its matching mods', async function () {
    if (!root) this.skip();
    await renderAfter(() => provider().setFilter('armor', true));
    assert.ok(gearExpanded(), `the filtered separator was not expanded: ${JSON.stringify(asked)}`);
  });

  it('keeps a separator the user collapsed collapsed, and one the user expanded expanded, across a change on disk', async function () {
    if (!root) this.skip();
    await renderAfter(() => provider().setFilter('', true));
    await onTheSeparator('list.collapse');
    await renderAfter(() => writeAndAwaitInstance(() => {
      fs.mkdirSync(present(modDirs[2], 'Late Armor'), { recursive: true });
      fs.writeFileSync(modlistPath, '+Late Armor\r\n+Armor Pack\r\n+Weapons\r\n-Gear_separator\r\n');
    }));
    assert.ok(!gearExpanded(), `a change on disk expanded a collapsed separator: ${JSON.stringify(asked)}`);

    await onTheSeparator('list.expand');
    await renderAfter(() => writeAndAwaitInstance(() => {
      fs.writeFileSync(modlistPath, '+Armor Pack\r\n+Late Armor\r\n+Weapons\r\n-Gear_separator\r\n');
    }));
    assert.ok(gearExpanded(), `a change on disk collapsed an expanded separator: ${JSON.stringify(asked)}`);
  });

  it('expands a separator the user collapsed, while a filter shows it for its matching mods', async function () {
    if (!root) this.skip();
    await onTheSeparator('list.collapse');
    await renderAfter(() => provider().setFilter('', true));
    assert.ok(!gearExpanded(), `the collapse did not land: ${JSON.stringify(asked)}`);

    await renderAfter(() => provider().setFilter('weap', true));
    assert.ok(gearExpanded(), `the filtered separator was not expanded: ${JSON.stringify(asked)}`);
  });
});

// ── The Mods palette and Space in a running host ─────────────────────────────

// mods.md, Menus and keys. A test cannot press a key, so Space is checked as the command VS Code
// runs for it on a focused row with no Modbench binding: `list.toggleExpand`.
describe('The Mods view\'s palette entries and Space, as VS Code runs them', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const modlistPath = root ? path.join(root, 'profiles', 'Default', 'modlist.txt') : '';
  const modDir = root ? path.join(root, 'mods', 'Palette Mod') : '';
  let original = '';

  // The folder's own arrival can land a sync that adds its line disabled, so each test enables
  // the mod itself once the folder is known. Mods' own Ctrl+C copy value names what is selected.
  const enabledAndSelected = async () => {
    await writeAndAwaitInstance(() => fs.writeFileSync(modlistPath, '+Palette Mod\r\n'));
    await waitFor('the mod row to be focused and selected', async () => {
      await vscode.env.clipboard.writeText('');
      await vscode.commands.executeCommand('modbench.modList.focus');
      await vscode.commands.executeCommand('list.focusFirst');
      await vscode.commands.executeCommand('list.select');
      await vscode.commands.executeCommand('modbench.record.copyValue', MODS_KEY_ARGS);
      return (await vscode.env.clipboard.readText()) === 'Palette Mod';
    });
  };

  before(async () => {
    if (!root) return;
    original = fs.readFileSync(modlistPath, 'utf8');
    await writeAndAwaitInstance(() => fs.mkdirSync(modDir, { recursive: true }));
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    if (!root) return;
    await writeAndAwaitInstance(() => {
      fs.writeFileSync(modlistPath, original);
      fs.rmSync(modDir, { recursive: true, force: true });
    });
  });

  it('VS Code\'s own Space on a focused mod row leaves its check box alone', async function () {
    if (!root) this.skip();
    await enabledAndSelected();
    await vscode.commands.executeCommand('list.toggleExpand');
    await new Promise((r) => setTimeout(r, 750));
    assert.strictEqual(fs.readFileSync(modlistPath, 'utf8'), '+Palette Mod\r\n');
  });

  it('offers Disable Mod in the palette while the Mods view has focus, acting on its selection', async function () {
    if (!root) this.skip();
    this.timeout(30_000);
    await enabledAndSelected();
    // The API shows no palette item, so each try reopens it and accepts its top item until the
    // disable lands; a try made before the item is listed accepts nothing.
    await waitFor('the palette\'s disable to land in the Instance', async () => {
      await vscode.commands.executeCommand('workbench.action.quickOpen', '>Modbench: Disable Mod');
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      return instanceExport()?.value.mods.some((m) => m.name === 'Palette Mod' && !m.enabled);
    });
  });
});

// ── Notification stream lifecycle is gated on the backend ────────────────────

// ADR-0014 invariant 2: every notification kind rides this one stream, proven once here.
// Placed first — the suite activates once — so "no connection before launch" is provable only
// at the one point in the run where that is still true.
describe('Notification stream connects only while the backend is up', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  let gameDir = '';
  const streamRequests = (log: string[]) => log.filter((r) => r === 'GET /notifications/stream');

  before(async () => {
    if (!root) return;
    await resetMockBackendDetached();
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-game-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
    fs.writeFileSync(path.join(gameDir, 'Data', 'TestMod.esp'), '');
    await setGameDirectory(gameDir);
    // Awaited so this suite's own enterEditing/exitEditing race no other, unarmed reconcile a
    // late-settling watcher write would otherwise still send after the test believes it is done.
    await writeAndAwaitInstance(() =>
      fs.writeFileSync(path.join(root, 'profiles', 'Default', 'plugins.txt'), '*TestMod.esp\n'));
  });

  after(async () => {
    if (!root) return;
    exitEditing();
    await setGameDirectory(undefined);
    await writeAndAwaitInstance(() => fs.writeFileSync(path.join(root, 'profiles', 'Default', 'plugins.txt'), ''));
    fs.rmSync(gameDir, { recursive: true, force: true });
  });

  // The connection follows the backend's health, not the load order — it opens before the
  // first PUT /load-order, so that PUT's own progress can ride it too.
  it('connects once the backend is healthy and does not reconnect once editing ends', async function () {
    if (!root) this.skip();
    this.timeout(20000);

    await enterEditing();
    await waitFor('the notification stream to connect', () => streamRequests(requestLog).length > 0);
    assert.strictEqual(streamRequests(requestLog).length, 1, 'expected exactly one connection for the launch');

    exitEditing();
    // client.stop() is fire-and-forget from exitEditing's own contract (editingTeardown.ts), so
    // the test waits on the client's own status instead of a promise it was never handed.
    const client = ext?.exports.client;
    if (client) await awaitStatus(client, 'stopped', 'the client to reach stopped');
    assert.strictEqual(streamRequests(requestLog).length, 1,
      'expected no reconnect once editing ends');
  });
});

// ── The game-directory setting is a recompute trigger ────────────────────────

// ADR-0015 invariant 7: a watcher event, activation and refresh run the same whole recompute.
// The Instance watches files only, so the root turns an edited setting into that recompute.
describe('The game-directory setting reaches the Instance as a recompute', () => {
  let gameDir = '';

  before(() => {
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-game-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
  });

  after(async () => {
    exitEditing();
    await setGameDirectory(undefined);
    fs.rmSync(gameDir, { recursive: true, force: true });
  });

  // No MO2 file is written here, so the only way a new value can land is the setting itself.
  it('lands a value resolving the directory the setting names, with no file of the instance touched', async () => {
    await setGameDirectory(gameDir);

    const instance = present(instanceExport(), 'the Instance activate() exports');
    assert.deepStrictEqual(instance.value.gameFolder, { kind: 'found', root: gameDir, dataFolder: path.join(gameDir, 'Data') });
  });
});

// ── Launch mEdit → editing plugin tree populated ────────────────────────────────

describe('Launch mEdit populates the editing plugin tree', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const treeProvider = () => ext?.exports.treeProvider;
  let gameDir = '';

  // enterEditing needs a resolvable game directory and an enabled plugin in the active profile to
  // reach PUT /load-order, so only the suite-scoped plugins.txt and game dir are set up here.
  before(async () => {
    if (!root) return;
    resetMockBackend();
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-game-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
    fs.writeFileSync(path.join(gameDir, 'Data', 'TestMod.esp'), '');
    await setGameDirectory(gameDir);

    await writeAndAwaitInstance(() =>
      fs.writeFileSync(path.join(root, 'profiles', 'Default', 'plugins.txt'), '*TestMod.esp\n'));
  });

  after(async () => {
    if (!root) return;
    // The launch below is never closed inside this suite's own test — leaving the backend
    // attached would bleed a live session (and its stream) into the next suite's own launch.
    exitEditing();
    await setGameDirectory(undefined);
    await writeAndAwaitInstance(() => fs.writeFileSync(path.join(root, 'profiles', 'Default', 'plugins.txt'), ''));
    fs.rmSync(gameDir, { recursive: true, force: true });
  });

  it('exposes the live PluginTreeProvider from activate()', () => {
    assert.ok(treeProvider(), 'activate() should return { treeProvider } for the editing view');
  });

  it('loads the load order and shows plugins (not an empty tree) after launch', async () => {
    await enterEditing();
    // Snapshot the launch's own requests before we query the tree ourselves below —
    // any GET /plugins the editing view fired during launch would appear here.
    const duringLaunch = [...requestLog];

    const load = duringLaunch.indexOf('PUT /load-order');
    assert.ok(load >= 0, 'launch should PUT /load-order');
    // The pinned regression: the view revealed and fetched /plugins before the load order
    // was loaded. Any /plugins request the launch triggered must follow the load.
    const prematurePlugins = duringLaunch.slice(0, load).includes('GET /plugins');
    assert.ok(!prematurePlugins, 'GET /plugins must not fire before PUT /load-order');

    // TestMod.esp's row expands into real record types only once GET /plugins has landed, so
    // real children (not an error/indexing placeholder) prove the fetch happened after load.
    const pluginsTreeExport = ext?.exports.pluginsTree;
    assert.ok(pluginsTreeExport, 'activate() should return { pluginsTree } for the merged view');
    const rows = await pluginsTreeExport.getChildren();
    assert.ok(rows.length > 0, 'the merged plugins tree should not be empty after a successful launch');
    const testMod = findRow(rows, 'TestMod.esp');
    const children = await pluginsTreeExport.getChildren(testMod);
    assert.deepStrictEqual(
      children.map((c) => c.label), ['Weapon'],
      'TestMod.esp should expand into its record types once the load order has loaded and GET /plugins has landed',
    );
  });
});

// ── The Toolbox stack survives an editing backend ──────────────────────────────
// These prove the two consequences only a live host can show: load-order state survives a
// round trip, and its write path stays reachable while the backend runs.

describe('The Toolbox stack stays visible through an editing backend', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const pluginsTxtPath = root ? path.join(root, 'profiles', 'Default', 'plugins.txt') : '';
  const pluginListProvider = () => present(ext?.exports.pluginsTree, "the activated extension's pluginsTree export");
  let gameDir = '';

  before(async () => {
    if (!root) return;
    resetMockBackend();
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-game-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
    // Every line these tests write names a plugin that plugin sync would otherwise drop.
    // An unparseable Data/ stub is presence without being an implicit master.
    for (const name of ['TestMod.esp', 'Other.esp']) fs.writeFileSync(path.join(gameDir, 'Data', name), '');
    await setGameDirectory(gameDir);
    await writeAndAwaitInstance(() => fs.writeFileSync(pluginsTxtPath, '*TestMod.esp\n*Other.esp\n'));
  });

  after(async () => {
    if (!root) return;
    await setGameDirectory(undefined);
    await writeAndAwaitInstance(() => fs.writeFileSync(pluginsTxtPath, ''));
    fs.rmSync(gameDir, { recursive: true, force: true });
  });

  it('exposes the live PluginsTreeProvider from activate()', () => {
    assert.ok(pluginListProvider(), 'activate() should return { pluginsTree } for the open workspace');
  });

  it('keeps the Plugin load order filter applied across a Launch mEdit / Close mEdit round trip (AC5)', async () => {
    const provider = pluginListProvider();
    provider.setFilter('TestMod');
    const before = await provider.getChildren();
    assert.deepStrictEqual(
      before.map((n) => rowName(n)), ['TestMod.esp'],
      'the filter should narrow to the one matching row before entering editing',
    );

    await enterEditing();
    exitEditing();

    const after = await provider.getChildren();
    assert.deepStrictEqual(
      after.map((n) => rowName(n)), ['TestMod.esp'],
      'the filter set before Launch mEdit must still be applied after Close mEdit — the Plugins view was never torn down',
    );
  });

  it('still writes plugins.txt through the Plugin load order while the backend is running (AC4)', async () => {
    const provider = pluginListProvider();
    provider.setFilter(''); // undo the previous test's filter so both rows are addressable
    await enterEditing();

    const other = findRow(await provider.getChildren(), 'Other.esp');
    await vscode.commands.executeCommand('modbench.plugin.disable', other);

    const written = fs.readFileSync(pluginsTxtPath, 'utf8');
    assert.ok(written.includes('Other.esp'), 'plugins.txt should still list Other.esp, just disabled');
    assert.ok(!written.includes('*Other.esp'), 'disabling a plugin while the backend runs should still write plugins.txt');

    exitEditing();
  });

  it('still writes plugins.txt through the Plugin load order drag-reorder while the backend is running (AC4)', async () => {
    const provider = pluginListProvider();
    provider.setFilter('');
    fs.writeFileSync(pluginsTxtPath, '*TestMod.esp\n*Other.esp\n');
    provider.invalidate();
    await provider.getChildren(); // populate the cached order handleDrop's index math reads against

    await enterEditing();

    // Same mime type PluginsTreeProvider.ts's private DND_MIME constant uses — pinned here since
    // it isn't exported; handleDrag/handleDrop only round-trip through it, never inspect it.
    const dataTransfer = new vscode.DataTransfer();
    dataTransfer.set('application/vnd.medit.pluginlist-node', new vscode.DataTransferItem({ names: ['TestMod.esp'] }));
    // undefined target = drop past the last row: append.
    await provider.handleDrop(undefined, dataTransfer, new vscode.CancellationTokenSource().token);

    const written = fs.readFileSync(pluginsTxtPath, 'utf8');
    const order = written.split('\n').map((l) => l.replace(/^\*/, '').trim()).filter(Boolean);
    assert.deepStrictEqual(
      order, ['Other.esp', 'TestMod.esp'],
      'dragging TestMod.esp to the end while the backend runs should still write the reordered plugins.txt',
    );

    exitEditing();
  });
});

// ── The Plugin load-order rows expand into records ────────────────────────────
// An enabled row is collapsible from launch (ADR-0002); launch/close changes its content on
// expand, never its collapsibleState. A disabled row has no expander (plugins.md, A row story 5).

// plugins.txt lines carry `plugin.name`; the game's implicitly-loaded masters carry `name`.
function rowFields(row: unknown): { name?: unknown; plugin?: { name?: unknown; enabled?: unknown } } {
  return typeof row === 'object' && row !== null ? row : {};
}
const rowName = (row: unknown): string | undefined => {
  const fields = rowFields(row);
  const pluginName = fields.plugin?.name;
  if (typeof pluginName === 'string') return pluginName;
  return typeof fields.name === 'string' ? fields.name : undefined;
};
function findRow<T>(rows: readonly T[], name: string): T {
  const row = rows.find((r) => rowName(r) === name);
  assert.ok(row, `expected a row for ${name}`);
  return row;
}

// A TreeItem's tooltip is typed string | MarkdownString | undefined; a failure message reads
// the string case directly rather than through MarkdownString's own default Object stringification.
function describeTooltip(tooltip: vscode.TreeItem['tooltip']): string {
  return typeof tooltip === 'string' ? tooltip : JSON.stringify(tooltip);
}

// update-load-order-file, Refusals: once mEdit has attached, plugin sync's refusal reaches the
// Plugins view's message line, and a connect runs plugin sync again.
describe('Plugin sync says why it wrote nothing, and runs again on connect', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const pluginsTxtPath = root ? path.join(root, 'profiles', 'Default', 'plugins.txt') : '';
  const messageLine = (): string | undefined => ext?.exports.pluginListView?.message;
  let gameDir = '';

  before(async () => {
    if (!root) return;
    await resetMockBackendDetached();
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-game-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
    fs.writeFileSync(path.join(gameDir, 'Data', 'TestMod.esp'), '');
    await setGameDirectory(gameDir);
    // Before mEdit first attaches, plugin sync waits; this suite's refusal comes after that.
    await enterEditing();
    await resetMockBackendDetached();
  });

  after(async () => {
    if (!root) return;
    exitEditing();
    implicitMastersShouldFail = false;
    await setGameDirectory(undefined);
    await writeAndAwaitInstance(() => fs.writeFileSync(pluginsTxtPath, ''));
    fs.rmSync(gameDir, { recursive: true, force: true });
  });

  it('says mEdit cannot answer in the message line, and clears it once the connect\'s run lands', async () => {
    implicitMastersShouldFail = true;
    await writeAndAwaitInstance(() => fs.writeFileSync(pluginsTxtPath, '*TestMod.esp\n'));
    await waitFor('the refusal in the Plugins view\'s message line', () =>
      messageLine()?.includes('plugins.txt is not synced: mEdit cannot say'));
    // Past every recompute the write queued, only the connect runs plugin sync again.
    const instance = present(instanceExport(), "the activated extension's instance export");
    for (let landed = instance.sequence; ; landed = instance.sequence) {
      await nextLandingWithin(instance, PROBE_SPACING_MS);
      if (instance.sequence === landed) break;
    }

    implicitMastersShouldFail = false;
    await enterEditing();

    await waitFor('the refusal to leave the message line', () =>
      !(messageLine()?.includes('plugins.txt is not synced') ?? false));
  });

  // commands.md, The system commands: plugin sync takes the instance value as its Argument.
  it('modbench.plugin.sync syncs the instance value it is handed: a Data folder it lists empty drops the line', async () => {
    await writeAndAwaitInstance(() => fs.writeFileSync(pluginsTxtPath, '*TestMod.esp\n'));
    const instance = present(instanceExport(), "the activated extension's instance export");
    const handed = { ...instance.value, dataFolderPlugins: { kind: 'listed', names: new Set<string>() } };

    await vscode.commands.executeCommand('modbench.plugin.sync', handed);

    assert.ok(!fs.readFileSync(pluginsTxtPath, 'utf8').includes('TestMod.esp'), 'the line the handed value drops');
  });
});

describe('Plugin load-order rows expand into records', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const pluginsTxtPath = root ? path.join(root, 'profiles', 'Default', 'plugins.txt') : '';
  const pluginsTree = () => present(ext?.exports.pluginsTree, "the activated extension's pluginsTree export");
  let gameDir = '';

  before(async () => {
    if (!root) return;
    resetMockBackend();
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-expand-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
    for (const name of ['TestMod.esp', 'Other.esp']) fs.writeFileSync(path.join(gameDir, 'Data', name), '');
    await setGameDirectory(gameDir);
    await writeAndAwaitInstance(() => fs.writeFileSync(pluginsTxtPath, '*TestMod.esp\nOther.esp\n'));
    pluginsTree().invalidate();
      // Setting the game directory just now fired the production config-change relaunch
    // (backend down + a directory appeared). Settle it and tear editing down so the
    // tests below still start from the pre-editing state they assert.
    await enterEditing();
    exitEditing();
  });

  after(async () => {
    if (!root) return;
    exitEditing();
    await setGameDirectory(undefined);
    await writeAndAwaitInstance(() => fs.writeFileSync(pluginsTxtPath, ''));
    fs.rmSync(gameDir, { recursive: true, force: true });
  });

  it('exposes the merged Plugins tree from activate()', () => {
    assert.ok(pluginsTree(), 'activate() should return { pluginsTree } for the open workspace');
  });

  // The extension parses no plugin binary (ADR-0016), so the forced-on rows can only be the
  // backend's answer — nothing here discovers them from the Data folder.
  it('renders the implicit masters the backend names, ahead of the plugins.txt rows', async () => {
    const tree = pluginsTree();
    mockImplicitMasters = ['Fallout4.esm'];
    try {
      pluginsTree().invalidate();
      const rows = await tree.getChildren();

      assert.strictEqual(rowName(rows[0]), 'Fallout4.esm', 'the backend-named implicit master leads the rows');
      assert.strictEqual(tree.getTreeItem(present(rows[0], 'the first row')).contextValue, 'pluginImplicit');
    } finally {
      mockImplicitMasters = [];
      pluginsTree().invalidate();
    }
  });

  it('renders no implicit row when the backend names none', async () => {
    const tree = pluginsTree();
    pluginsTree().invalidate();
    const rows = await tree.getChildren();

    assert.ok(!rows.some((r) => tree.getTreeItem(r).contextValue === 'pluginImplicit'));
  });

  it('renders every enabled row collapsible, whether or not mEdit has launched', async () => {
    const tree = pluginsTree();
    const rows = await tree.getChildren();

    assert.deepStrictEqual(
      rows.map(rowName).filter((n) => n === 'TestMod.esp' || n === 'Other.esp'), ['TestMod.esp', 'Other.esp'],
      'the rows include both plugins.txt lines, the disabled one too, in file order',
    );
    assert.strictEqual(
      tree.getTreeItem(findRow(rows, 'TestMod.esp')).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed,
      'an enabled row is collapsible from launch — there is no mode for mEdit not having started yet',
    );
    assert.strictEqual(
      tree.getTreeItem(findRow(rows, 'Other.esp')).collapsibleState, vscode.TreeItemCollapsibleState.None,
      'a disabled row has no expander, whatever mEdit has or has not done',
    );
    const children = await tree.getChildren(findRow(rows, 'TestMod.esp'));
    assert.strictEqual(children.length, 1, 'expanding answers exactly one node, never an empty list');
    assert.strictEqual(nodeKind(children[0]), 'recordType',
      'the load order an earlier launch left held is what the row expands into');
  });

  it('launching mEdit gives a row real children, without reordering the load order', async () => {
    const tree = pluginsTree();
    const before = await tree.getChildren();

    await enterEditing();

    const after = await tree.getChildren();
    assert.deepStrictEqual(
      after.map(rowName).filter((n) => n !== undefined), before.map(rowName),
      'launching mEdit must not rebuild or reorder the plugin rows',
    );
    const children = await tree.getChildren(findRow(after, 'TestMod.esp'));
    assert.deepStrictEqual(
      children.map((c) => c.label), ['Weapon'],
      'a row whose plugin is in the load order now expands into its record types',
    );
  });

  it('expands a plugin row into its record types', async () => {
    const tree = pluginsTree();
    const testMod = findRow(await tree.getChildren(), 'TestMod.esp');

    const children = await tree.getChildren(testMod);

    assert.deepStrictEqual(
      children.map((c) => c.label), ['Weapon'],
      'expanding a row shows the record types the backend reports, with xEdit display names',
    );
  });

  // plugins.md, A row story 5: the game does not load a disabled plugin's records, so its row
  // shows no expander — viewing it is deferred, as for an overridden plugin.
  it('a disabled plugin row has no expander', async () => {
    const tree = pluginsTree();
    const other = findRow(await tree.getChildren(), 'Other.esp'); // the prefix-less plugins.txt line

    assert.strictEqual(tree.getTreeItem(other).collapsibleState, vscode.TreeItemCollapsibleState.None);
  });

  // ADR-0002: the view has no shape to revert to, so a backend that goes takes nothing with it —
  // the row's own content is what reports the absence, on the expand that asks for it.
  it('keeps every row and its chevron when mEdit closes', async () => {
    const tree = pluginsTree();

    exitEditing();

    const rows = await tree.getChildren();
    assert.deepStrictEqual(
      rows.map(rowName).filter((n) => n === 'TestMod.esp' || n === 'Other.esp'), ['TestMod.esp', 'Other.esp'],
      'closing mEdit leaves the load order untouched',
    );
    assert.strictEqual(
      tree.getTreeItem(findRow(rows, 'TestMod.esp')).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed,
    );
    assert.strictEqual(
      tree.getTreeItem(findRow(rows, 'Other.esp')).collapsibleState, vscode.TreeItemCollapsibleState.None,
      'closing mEdit does not give a disabled row an expander',
    );
    const children = await tree.getChildren(findRow(rows, 'TestMod.esp'));
    assert.strictEqual(children.length, 1, 'expanding after close answers exactly one node, never an empty list');
    assert.strictEqual(nodeKind(children[0]), 'recordType',
      'closing takes nothing from the tree, so the row still expands into the held load order');
  });
});

// ADR-0017: read-only-for-editing is a tooltip, never an icon, and is known only once a load
// order says so — before launch a plugin row carries no opinion about it at all.
describe('A read-only plugin\'s tooltip says so once the backend is running', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const pluginsTxtPath = root ? path.join(root, 'profiles', 'Default', 'plugins.txt') : '';
  const pluginsTree = () => present(ext?.exports.pluginsTree, "the activated extension's pluginsTree export");
  let gameDir = '';

  before(async () => {
    if (!root) return;
    resetMockBackend();
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-readonly-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
    for (const name of ['Immutable.esm']) fs.writeFileSync(path.join(gameDir, 'Data', name), '');
    await setGameDirectory(gameDir);
    await writeAndAwaitInstance(() => fs.writeFileSync(pluginsTxtPath, '*Immutable.esm\n'));
    pluginsTree().invalidate();
      // Setting the game directory just now fired the production config-change relaunch
    // (backend down + a directory appeared). Settle it and tear editing down so the
    // tests below still start from the pre-editing state they assert.
    await enterEditing();
    exitEditing();
  });

  after(async () => {
    if (!root) return;
    exitEditing();
    await setGameDirectory(undefined);
    await writeAndAwaitInstance(() => fs.writeFileSync(pluginsTxtPath, ''));
    fs.rmSync(gameDir, { recursive: true, force: true });
  });

  it('gains a read-only tooltip once the load order reports it immutable', async () => {
    await enterEditing();
    const tree = pluginsTree();
    const row = findRow(await tree.getChildren(), 'Immutable.esm');

    const tooltip = tree.getTreeItem(row).tooltip;

    assert.ok(typeof tooltip === 'string' && tooltip.includes('read-only'), `expected a read-only tooltip, got: ${describeTooltip(tooltip)}`);
  });
});

// ADR-0017: a plugin flagged with a missing master is decorated through the real wiring.
// MOCK_PLUGINS sends raw JSON no PluginMetadata-typed fixture could produce, so TestMod.esp,
// with no `masterIssues` key, proves an absent field degrades to undecorated.
describe('A plugin with a missing master is flagged, never deactivated', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const pluginsTxtPath = root ? path.join(root, 'profiles', 'Default', 'plugins.txt') : '';
  const pluginsTree = () => present(ext?.exports.pluginsTree, "the activated extension's pluginsTree export");
  let gameDir = '';

  before(async () => {
    if (!root) return;
    resetMockBackend();
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-missingmaster-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
    // The mock reports both with origin 'Data', so the Data folder must actually hold them, or
    // reconcile concludes their names resolve to nothing and decorates every row with a load
    // failure instead (ADR-0013).
    for (const name of ['TestMod.esp', 'MissingMaster.esp']) {
      fs.writeFileSync(path.join(gameDir, 'Data', name), '');
    }
    await setGameDirectory(gameDir);
    await writeAndAwaitInstance(() => fs.writeFileSync(pluginsTxtPath, '*TestMod.esp\n*MissingMaster.esp\n'));
    pluginsTree().invalidate();
    await enterEditing();
  });

  after(async () => {
    if (!root) return;
    exitEditing();
    await setGameDirectory(undefined);
    await writeAndAwaitInstance(() => fs.writeFileSync(pluginsTxtPath, ''));
    fs.rmSync(gameDir, { recursive: true, force: true });
  });

  it('flags the row with an error decoration naming the missing master, and stays checked', async () => {
    const tree = pluginsTree();
    const row = findRow(await tree.getChildren(), 'MissingMaster.esp');
    const item = tree.getTreeItem(row);

    assert.ok(typeof item.tooltip === 'string' && item.tooltip.includes('Missing master: Ghost.esm'),
      `expected a missing-master tooltip, got: ${describeTooltip(item.tooltip)}`);
    // Never deactivated, excluded or hidden — still expandable (in the load order) and checked.
    assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    assert.strictEqual(rowFields(row).plugin?.enabled, true);
    // The leading slot (checkbox) is untouched by this decoration — a real TreeItemCheckboxState
    // read, not just the underlying model's `enabled` flag, so a regression in the decoration
    // logic itself (not just in plugins.txt writing) would be caught here.
    assert.strictEqual(item.checkboxState, vscode.TreeItemCheckboxState.Checked);
  });

  // The negative case: `masterIssues` is non-nullable on the wire, so a plugin whose masters all
  // resolved carries an empty array, and gets no decoration.
  it('leaves a plugin whose masters all resolve undecorated', async () => {
    const tree = pluginsTree();
    const row = findRow(await tree.getChildren(), 'TestMod.esp');

    const item = tree.getTreeItem(row);

    // The base tooltip (file name, mod) is the row's own identity, not a backend fact.
    assert.strictEqual(item.tooltip, 'TestMod.esp\nData');
  });

});

// ADR-0013: an instance change through the real wiring — the plugins.txt watcher, the load-order
// sync, `PUT /load-order`, and the tree hand-off that follows.
describe('An instance change sends a fresh load order snapshot (ADR-0013)', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const pluginsTxtPath = root ? path.join(root, 'profiles', 'Default', 'plugins.txt') : '';
  const pluginsTree = () => present(ext?.exports.pluginsTree, "the activated extension's pluginsTree export");
  let gameDir = '';
  let swapped = false;
  const putCount = () => requestLog.filter((l) => l === 'PUT /load-order').length;

  // An order swap, so the load order itself changes, exercising watcher → sync → PUT end to end.
  // A write that leaves the load order equal puts nothing.
  async function changePluginsTxt(): Promise<void> {
    const before = putCount();
    const pluginReads = requestLog.filter((l) => l === 'GET /plugins').length;
    swapped = !swapped;
    fs.writeFileSync(pluginsTxtPath, swapped ? '*MissingMaster.esp\n*TestMod.esp\n' : '*TestMod.esp\n*MissingMaster.esp\n');
    await waitFor('a fresh PUT /load-order after plugins.txt changed', () => putCount() > before ? true : undefined);
    // The PUT is answered, but the tree hand-off (GET /plugins → setLoadOrder) follows it
    // asynchronously; wait for that read too — unless the PUT failed, in which case there is none.
    if (!putLoadOrderShouldFail) {
      await waitFor('the tree hand-off after the PUT', () => requestLog.filter((l) => l === 'GET /plugins').length > pluginReads ? true : undefined);
    }
  }

  before(async () => {
    if (!root) return;
    await resetMockBackendDetached();
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-reconcile-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
    for (const name of ['TestMod.esp', 'MissingMaster.esp']) {
      fs.writeFileSync(path.join(gameDir, 'Data', name), '');
    }
    await setGameDirectory(gameDir);
    await writeAndAwaitInstance(() => fs.writeFileSync(pluginsTxtPath, '*TestMod.esp\n*MissingMaster.esp\n'));
    pluginsTree().invalidate();
    await enterEditing();
  });

  after(async () => {
    if (!root) return;
    exitEditing();
    await setGameDirectory(undefined);
    await writeAndAwaitInstance(() => fs.writeFileSync(pluginsTxtPath, ''));
    fs.rmSync(gameDir, { recursive: true, force: true });
  });

  it('a plugins.txt write is followed by a fresh PUT /load-order, no command required', async () => {
    const before = putCount();

    await changePluginsTxt();

    assert.ok(putCount() >= before + 1, 'a plugins.txt change must send a fresh snapshot, not merely re-render the tree');
  });

  // update-load-order-file: put on change. The PUT after the equal write carries the swap, so a
  // PUT for the equal write would have landed first.
  it('a plugins.txt write that leaves the load order equal puts nothing', async () => {
    const sent = putLoadOrders.length;
    const unchanged = fs.readFileSync(pluginsTxtPath, 'utf8');
    await writeAndAwaitInstance(() => fs.writeFileSync(pluginsTxtPath, `${unchanged}\n`));

    await changePluginsTxt();

    const swappedOrder = swapped ? ['MissingMaster.esp', 'TestMod.esp'] : ['TestMod.esp', 'MissingMaster.esp'];
    assert.deepStrictEqual(putLoadOrders.slice(sent), [swappedOrder],
      'only the write that changed the load order may put it');
  });

  // The WeakMap decoration restores each row to its captured original before re-deciding what
  // to layer back on, so the same row object must lose a decoration once the backend stops
  // reporting its condition rather than gain a second copy.
  it('clears a resolved master-issue decoration on the same row after the next reconcile, not just applies it', async () => {
    const tree = pluginsTree();
    const before = findRow(await tree.getChildren(), 'MissingMaster.esp');
    const beforeTooltip = tree.getTreeItem(before).tooltip;
    assert.ok(typeof beforeTooltip === 'string' && beforeTooltip.includes('Missing master: Ghost.esm'),
      `expected the row to carry the master-issue tooltip before the reconcile, got: ${describeTooltip(beforeTooltip)}`);

    // The next reconcile reports the same plugin with its master issue resolved.
    mockPluginsOverride = MOCK_PLUGINS.map((p) => p.name === 'MissingMaster.esp' ? { ...p, masterIssues: [] } : p);
    await changePluginsTxt();

    // The hand-off follows the index status on the stream, so the tree is read until it lands.
    await waitFor('a resolved master issue to clear the tooltip, not leave the stale decoration stacked on top of the fresh one',
      async () => tree.getTreeItem(findRow(await tree.getChildren(), 'MissingMaster.esp')).tooltip === 'MissingMaster.esp\nData');
  });

  // If matchingPlugins were refreshed only by setFilter/clearFilter, a suppressed plugin would
  // stay suppressed through a reconcile with no filter at all. Under plugins.md such a plugin has
  // no row, so absence is what is asserted.
  it('hides a plugin a filter suppresses, and restores it once a reconcile comes up with no filter', async () => {
    const tree = pluginsTree();
    const before = findRow(await tree.getChildren(), 'TestMod.esp');
    assert.strictEqual(tree.getTreeItem(before).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed,
      'sanity: the row is expandable before either reconcile below');

    mockPluginsOverride = MOCK_PLUGINS.map((p) => p.name === 'TestMod.esp' ? { ...p, hasMatchingRecords: false } : p);
    await changePluginsTxt();
    // The hand-off follows the index status on the stream, so the tree is read until it lands.
    await waitFor('sanity: the mechanism reaches the tree — a filter with no matches on this plugin hides its row entirely, not just its chevron',
      async () => !(await tree.getChildren()).some((r) => rowName(r) === 'TestMod.esp'));

    mockPluginsOverride = null;
    await changePluginsTxt();
    await waitFor('a reconcile that comes up with no filter to restore a row an earlier filter hid, not leave it permanently gone',
      async () => {
        const restored = (await tree.getChildren()).find((r) => rowName(r) === 'TestMod.esp');
        return restored !== undefined && tree.getTreeItem(restored).collapsibleState === vscode.TreeItemCollapsibleState.Collapsed;
      });
  });

  // ADR-0013: a failed PUT tears nothing down — the backend still holds what it held — so the
  // tree keeps its chevrons rather than tearing editing down.
  it('keeps the rows expandable, without throwing, when the reconcile itself fails', async () => {
    const tree = pluginsTree();
    const before = findRow(await tree.getChildren(), 'TestMod.esp');
    assert.strictEqual(tree.getTreeItem(before).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed,
      'sanity: the row is expandable before the failing reconcile');

    putLoadOrderShouldFail = true;
    try {
      await changePluginsTxt();
    } finally {
      putLoadOrderShouldFail = false;
    }

    const after = findRow(await tree.getChildren(), 'TestMod.esp');
    assert.strictEqual(tree.getTreeItem(after).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed,
      'a failed reconcile leaves the load order the backend already holds in place, so the rows stay expandable');
    // ADR-0013: the failed PUT tore nothing down, so the row expands into the records the backend
    // still holds. "Still indexing" would promise a completion that is not coming.
    const children = await tree.getChildren(after);
    assert.strictEqual(children.length, 1, 'expanding after a failed reconcile answers exactly one node');
    assert.strictEqual(nodeKind(children[0]), 'recordType',
      'a failed PUT leaves the held load order behind the chevron, never a row stuck on "still indexing"');
  });
});

// ADR-0002: mEdit runs for the extension's whole lifetime, so a status change is news the views
// report — none of them has a shape to revert to. Driven through the real status transition, not
// its extracted wiring in isolation.
describe('a client that reports stopped outside exitEditing leaves the Plugins tree\'s shape alone', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const pluginsTxtPath = root ? path.join(root, 'profiles', 'Default', 'plugins.txt') : '';
  const pluginsTree = () => present(ext?.exports.pluginsTree, "the activated extension's pluginsTree export");
  const clientOf = () => ext?.exports.client;
  let gameDir = '';

  before(() => {
    if (!root) return;
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-backend-death-filter-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
    fs.writeFileSync(path.join(gameDir, 'Data', 'TestMod.esp'), '');
  });

  after(() => {
    if (!root) return;
    fs.rmSync(gameDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (!root) return;
    resetMockBackend();
    mockPluginsOverride = MOCK_PLUGINS.map((p) => (p.name === 'TestMod.esp' ? { ...p, hasMatchingRecords: false } : p));
    await setGameDirectory(gameDir);
    await writeAndAwaitInstance(() => fs.writeFileSync(pluginsTxtPath, '*TestMod.esp\n'));
    await enterEditing();
    const tree = pluginsTree();
    await waitFor('the activation reconcile to filter TestMod.esp out',
      async () => ((await tree.getChildren()).some((r) => rowName(r) === 'TestMod.esp') ? undefined : true));
  });

  afterEach(async () => {
    if (!root) return;
    exitEditing();
    await setGameDirectory(undefined);
    await writeAndAwaitInstance(() => fs.writeFileSync(pluginsTxtPath, ''));
    // The setting relaunched mEdit, and the write puts the load order: that PUT is abandoned
    // before the reset, which would otherwise forget the reconcile it waits on.
    await resetMockBackendDetached();
  });

  it('the row a record filter hid stays hidden', async () => {
    const tree = pluginsTree();

    await clientOf()?.stop();

    assert.ok(!(await tree.getChildren()).some((r) => rowName(r) === 'TestMod.esp'),
      'a stopped client is not a reason to un-narrow a view the user narrowed');
  });

  // The expand is the discriminator: a tree that forgot its load order would answer "Still
  // indexing…" for every row, whatever the row's own content would have been.
  it('a row still in the tree keeps the load order behind its chevron', async () => {
    mockPluginsOverride = null; // this one is about the rows the filter left alone
    const tree = pluginsTree();
    await enterEditing();
    const row = findRow(await tree.getChildren(), 'TestMod.esp');

    await clientOf()?.stop();

    const children = await tree.getChildren(row);
    assert.strictEqual(children.length, 1, 'expanding answers exactly one node, never an empty list');
    assert.strictEqual(nodeKind(children[0]), 'recordType',
      'the tree kept its load order, so the row expands into records');
  });
});

// load-instance, refresh: mEdit reads every plugin again against the load order it holds, and the
// re-read of the instance that follows finds that load order unchanged.
describe('Refresh rebuilds the index and sends nothing', () => {
  // Launched, so a re-read that changed the load order would put it.
  beforeEach(async () => {
    await resetMockBackendDetached();
    await enterEditing();
    requestLog.length = 0;
  });
  after(() => resetMockBackend());

  it('POSTs /index/rebuild and PUTs no load order', async () => {
    await vscode.commands.executeCommand('modbench.instance.refresh');

    assert.ok(requestLog.includes('POST /index/rebuild'), 'modbench.instance.refresh must rebuild the index');
    assert.ok(!requestLog.includes('PUT /load-order'), 'modbench.instance.refresh must send no load order');
  });

  // toolbox.md, Reporting story 1; ADR-0009 invariant 5: the toast is the spec's own words,
  // naming this instance — never the backend's raw 423 detail.
  it('reports the second-window refusal in toolbox.md\'s words, naming this instance', async () => {
    rebuildIndexShouldFail = true;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const errors: string[] = [];
    const realShowError = vscode.window.showErrorMessage;
    Object.defineProperty(vscode.window, 'showErrorMessage', {
      configurable: true,
      value: (message: string) => { errors.push(message); return Promise.resolve(undefined); },
    });
    try {
      await vscode.commands.executeCommand('modbench.instance.refresh');

      assert.ok(requestLog.some((l) => l === 'POST /index/rebuild'), 'sanity: the rebuild must still be attempted');
      assert.ok(
        !requestLog.some((l) => l === 'PUT /load-order'),
        'a refused rebuild must not be followed by a load-order send',
      );
      assert.strictEqual(errors.length, 1, `expected exactly one error toast, got: ${JSON.stringify(errors)}`);
      const [toast] = errors;
      assert.ok(
        toast?.includes("This instance's index is open in another Modbench window"),
        `expected toolbox.md's own words, got: ${toast}`,
      );
      assert.ok(root !== undefined && toast?.includes(root), `expected the instance named, got: ${toast}`);
    } finally {
      Object.defineProperty(vscode.window, 'showErrorMessage', { configurable: true, value: realShowError });
    }
  });
});

// ── ADR-0013: progressive load ──────────────────────────────────────────────────
// Rows land as each plugin finishes indexing: a plugin the load has not reached stays a leaf.
// Every assertion is about the window during the load POST, which is why the mock holds it open.

// The tree reacts on the backend's own 500ms cadence, so a fixed sleep would be flaky or slow.
async function waitFor<T>(label: string, read: () => Promise<T | false | undefined> | T | false | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('Progressive load', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const pluginsTxtPath = root ? path.join(root, 'profiles', 'Default', 'plugins.txt') : '';
  const pluginsTree = () => present(ext?.exports.pluginsTree, "the activated extension's pluginsTree export");
  let gameDir = '';

  const childrenFor = async (name: string) => {
    const tree = pluginsTree();
    return tree.getChildren(findRow(await tree.getChildren(), name));
  };

  const itemFor = async (name: string) => {
    const tree = pluginsTree();
    return tree.getTreeItem(findRow(await tree.getChildren(), name));
  };

  before(async () => {
    if (!root) return;
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-progressive-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
    for (const name of ['TestMod.esp', 'Other.esp', 'MissingMaster.esp', 'Immutable.esm']) fs.writeFileSync(path.join(gameDir, 'Data', name), '');
    await setGameDirectory(gameDir);
    await writeAndAwaitInstance(() =>
      fs.writeFileSync(pluginsTxtPath, '*TestMod.esp\n*Other.esp\n*MissingMaster.esp\n*Immutable.esm\n'));
      // Setting the game directory just now fired the production config-change relaunch
    // (backend down + a directory appeared). Settle it and tear editing down so the
    // tests below still start from the pre-editing state they assert.
    await enterEditing();
    exitEditing();
  });

  after(async () => {
    if (!root) return;
    exitEditing();
    await setGameDirectory(undefined);
    await writeAndAwaitInstance(() => fs.writeFileSync(pluginsTxtPath, ''));
    fs.rmSync(gameDir, { recursive: true, force: true });
    // Clearing the setting just fired the same production config-change relaunch `before()`
    // settles. Left running, its PUT lands inside the next suite and hands the load order-less
    // mock a load order.
    await enterEditing();
    exitEditing();
    resetMockBackend();
  });

  beforeEach(() => {
    resetMockBackend();
    holdPutLoadOrder = true;
    pluginsTree().invalidate();
  });

  afterEach(() => {
    releasePutLoadOrder?.();
    exitEditing();
  });

  // `record-types` needs the whole PUT settled in this mock, so the attempt itself
  // (`requestLog`) tells a real ask apart from "still indexing"'s no ask at all.
  const recordTypesAttempted = (name: string) =>
    requestLog.some((l) => l.startsWith(`GET /plugins/${name}/record-types`));
  const stillIndexing = async (name: string) => nodeKind((await childrenFor(name))[0]) === 'indexing';
  const waitForIndexed = (name: string) => waitFor(`the backend to be asked about ${name} once indexed`, async () => {
    await childrenFor(name);
    return recordTypesAttempted(name) ? true : undefined;
  });
  // A load that has begun holds nothing yet, and its first tick is the moment the tree stops
  // describing whatever load order preceded it. Every assertion about a *this*-load state
  // starts here.
  const launchAndAwaitOpeningTick = async (): Promise<{ launch: Promise<void> }> => {
    const launch = enterEditing();
    await waitFor('the load\'s opening tick to reach the tree', () => stillIndexing('TestMod.esp'));
    // Boxed: returning it bare would flatten it and await the load these tests leave in flight.
    return { launch };
  };

  it('makes a plugin browsable as soon as it is indexed, while a later one is still indexing', async () => {
    const { launch } = await launchAndAwaitOpeningTick();

    setIndexed(['TestMod.esp']);
    await waitForIndexed('TestMod.esp');

    // What makes it progressive rather than merely early: a plugin the load has not reached
    // answers "still indexing" from client-side state alone, asking the backend nothing.
    assert.ok(await stillIndexing('Other.esp'), 'Other.esp has not been indexed yet and must answer "still indexing"');
    assert.ok(!recordTypesAttempted('Other.esp'), 'a plugin the load has not reached must not be asked about at all');

    setIndexed(['TestMod.esp', 'Other.esp']);
    await waitForIndexed('Other.esp');

    releasePut();
    await launch;
  });

  // A per-plugin failure surfaces when it occurs, not only at the end of the load.
  it('decorates a plugin that failed to load the moment it is reported, not at the end', async () => {
    const { launch } = await launchAndAwaitOpeningTick();
    setIndexed(['TestMod.esp'], { failures: [{ name: 'Other.esp', origin: 'Data', reason: 'RACE parse' }] });

    const item = await waitFor('Other.esp to be decorated with its load failure mid-load', async () => {
      const candidate = await itemFor('Other.esp');
      return candidate.description === 'failed to load' ? candidate : undefined;
    });

    assert.ok(typeof item.tooltip === 'string' && item.tooltip.includes('RACE parse'),
      `expected the failure reason in the tooltip, got: ${describeTooltip(item.tooltip)}`);

    releasePut();
    await launch;
  });

  // Closing mEdit mid-load is a deliberate abandonment: the stream closes with the backend it was
  // opened against. The "no error toast" half lives at the LoadOrderController seam.
  it('closes the notification stream when mEdit is closed mid-load', async () => {
    const { launch } = await launchAndAwaitOpeningTick();
    setIndexed(['TestMod.esp']);
    await waitForIndexed('TestMod.esp');
    const connectionsAtLoad = requestLog.filter((l) => l === 'GET /notifications/stream').length;
    assert.ok(connectionsAtLoad > 0, 'the load should have been subscribed before it was abandoned');

    exitEditing();
    // The abandoned load resolves on its own — the abort reaches the in-flight POST rather than
    // leaving it to wait for a socket that will never answer.
    await launch;

    // client.stop() is fire-and-forget from exitEditing's own contract (editingTeardown.ts), so
    // the test waits on the client's own status instead of a promise it was never handed.
    const client = ext?.exports.client;
    if (client) await awaitStatus(client, 'stopped', 'the client to reach stopped');

    assert.strictEqual(
      requestLog.filter((l) => l === 'GET /notifications/stream').length, connectionsAtLoad,
      'closing mEdit must not reconnect the stream against a dead backend',
    );
    const children = await childrenFor('TestMod.esp');
    assert.strictEqual(children.length, 1, 'expanding after an abandoned load answers exactly one node, never an empty list');
    assert.strictEqual(
      ext?.exports.pluginListView?.message,
      undefined,
      'the view must stop claiming a load that is not running',
    );
  });

  // A launch has two phases: bring the backend up, then load; this closes during the first.
  // Without the abort armed before the first await, the stale launch outruns the close, finds
  // the stopped backend and reports "Backend failed to start".
  it('raises no error when mEdit is closed before the backend is even up', async () => {
    holdHealth = true;
    const errors: string[] = [];
    const realShowError = vscode.window.showErrorMessage;
    // The test and the extension share one vscode module instance in the extension host, so this
    // is the only way to observe a toast — there is no API to read notifications back.
    Object.defineProperty(vscode.window, 'showErrorMessage', {
      configurable: true,
      value: (message: string) => { errors.push(message); return Promise.resolve(undefined); },
    });
    try {
      const launch = enterEditing();
      await waitFor('the launch to reach the backend health probe', () =>
        requestLog.some((l) => l === 'GET /health'));

      exitEditing();
      releaseHealth?.();
      await launch;

      assert.deepStrictEqual(errors, [], 'a deliberately abandoned launch must raise no error');
      assert.ok(
        !requestLog.some((l) => l === 'PUT /load-order'),
        'an abandoned launch must not go on to load a load order the user has closed',
      );
    } finally {
      Object.defineProperty(vscode.window, 'showErrorMessage', { configurable: true, value: realShowError });
    }
  });

  // plugins.md, A row: "no blink" — a reload keeps the last statuses until the new answer
  // lands, unchanged through the mid-load tick.
  it('keeps a plugin\'s master-issue tooltip through a reload\'s mid-load tick, unchanged', async () => {
    const { launch } = await launchAndAwaitOpeningTick();

    setIndexed(['TestMod.esp', 'MissingMaster.esp']);
    await waitForIndexed('MissingMaster.esp');
    const midLoad = await itemFor('MissingMaster.esp');
    assert.ok(
      typeof midLoad.tooltip === 'string' && midLoad.tooltip.includes('Missing master: Ghost.esm'),
      `expected the prior reconcile's tooltip to survive the mid-load tick, got: ${describeTooltip(midLoad.tooltip)}`,
    );

    releasePut();
    await launch;

    const loaded = await itemFor('MissingMaster.esp');
    assert.ok(typeof loaded.tooltip === 'string' && loaded.tooltip.includes('Missing master: Ghost.esm'),
      `expected the missing-master tooltip once the load completed, got: ${describeTooltip(loaded.tooltip)}`);
    const immutable = await itemFor('Immutable.esm');
    assert.ok(typeof immutable.tooltip === 'string' && immutable.tooltip.includes('read-only'),
      `expected the read-only note once the load completed, got: ${describeTooltip(immutable.tooltip)}`);
    // Immutable.esm never appears in a progress tick's indexedPlugins, so its browsability can
    // only come from the completion hand-off's file set, which a hand-off applying only readOnly
    // would drop.
    assert.ok(
      !(await stillIndexing('Immutable.esm')),
      'Immutable.esm was indexed but never named in a progress tick — it must still browse once the completion hand-off lands',
    );
  });

  // plugins.md, States 3-4: what the stream or the client says reaches the rows as their expansion.
  const expandsTo = async (name: string): Promise<string | undefined> => {
    const [child] = await childrenFor(name);
    return nodeKind(child) === 'error' && child !== undefined ? describeTooltip(pluginsTree().getTreeItem(child).tooltip) : undefined;
  };
  const heldAndLoaded = async (): Promise<{ launch: Promise<void> }> => {
    const launched = await launchAndAwaitOpeningTick();
    setIndexed(['TestMod.esp']);
    await waitForIndexed('TestMod.esp');
    return launched;
  };

  it('expands every row, held or not, to the second window\'s refusal the stream carries', async () => {
    const { launch } = await heldAndLoaded();
    const HELD_ELSEWHERE = 'This instance\'s index is open in another Modbench window.';

    setIndexed(['TestMod.esp'], { state: 'HeldElsewhere', message: HELD_ELSEWHERE });

    for (const name of ['TestMod.esp', 'Other.esp']) {
      await waitFor(`${name} to expand to the refusal`, async () => (await expandsTo(name)) === HELD_ELSEWHERE);
    }
    releasePut();
    await launch;
  });

  it('expands a row the load never reached to a Failed refusal, and leaves a held row its records', async () => {
    const { launch } = await heldAndLoaded();
    const FAILED = 'the reconcile hit something it cannot name';

    setIndexed(['TestMod.esp'], { state: 'Failed', message: FAILED });

    await waitFor('Other.esp to expand to the refusal', async () => (await expandsTo('Other.esp')) === FAILED);
    assert.notStrictEqual(await expandsTo('TestMod.esp'), FAILED, 'a held row keeps what already landed');
    releasePut();
    await launch;
  });

  it('expands a row the load never reached to why mEdit cannot be reached once the client stops', async () => {
    const { launch } = await heldAndLoaded();

    await ext?.exports.client.stop();

    await waitFor('Other.esp to expand to the unreachable reason', async () => (await expandsTo('Other.esp')) === 'mEdit is stopped.');
    releasePutLoadOrder?.();
    await launch;
  });
});

// pickCopyDestination opens with an unguarded repository.getPlugins(); a rejection escapes the
// command callback as VS Code's raw "fetch failed" toast. A load order-less mock reproduces it.
describe('Copy destination picking degrades to a reported error, never an uncaught rejection', () => {
  // A column header's data-vscode-context payload always carries `origin`, so origin resolution
  // short-circuits with no HTTP call and pickCopyDestination's getPlugins() is the first thing to
  // reach the refusing backend.
  const headerArg = {
    webviewSection: 'recordHeader',
    formKey: 'TestMod.esp:000001',
    plugin: 'TestMod.esp',
    origin: 'Data',
    preventDefaultContextMenuItems: true,
  };

  beforeEach(() => resetMockBackend());

  for (const command of ['modbench.record.copyAsOverride', 'modbench.record.copyAsNewRecord']) {
    it(`${command} resolves (not rejects) and shows a Modbench-authored error when the plugins request is refused`, async () => {
      const errors: string[] = [];
      const realShowError = vscode.window.showErrorMessage;
      Object.defineProperty(vscode.window, 'showErrorMessage', {
        configurable: true,
        value: (message: string) => { errors.push(message); return Promise.resolve(undefined); },
      });
      try {
        // An escaped rejection out of the command callback fails executeCommand's own returned promise,
        // so awaiting with no try/catch is the assertion.
        await vscode.commands.executeCommand(command, headerArg);

        assert.ok(requestLog.some((l) => l === 'GET /plugins'),
          'the command must have actually reached pickCopyDestination\'s getPlugins() call');
        assert.strictEqual(errors.length, 1, `expected exactly one error toast, got: ${JSON.stringify(errors)}`);
        const [errorToast] = errors;
        if (errorToast === undefined) throw new Error('expected the one error toast just asserted above');
        assert.ok(errorToast.startsWith('Modbench:'), `expected a Modbench-authored toast, got: ${errorToast}`);
        assert.ok(!errorToast.includes('fetch failed'), `must not surface the raw fetch error verbatim, got: ${errorToast}`);
      } finally {
        Object.defineProperty(vscode.window, 'showErrorMessage', { configurable: true, value: realShowError });
      }
    });
  }
});

// commands.md, Record: a field gesture from the palette acts on the focused cell of the record tab
// in focus. The palette hands the command no argument, as this test does.
describe('A field gesture from the palette acts on the focused cell of the record tab in focus', () => {
  before(async () => {
    await resetMockBackendDetached();
    await enterEditing();
  });

  after(() => { exitEditing(); });

  it('removes the element the focused cell holds', async () => {
    const formKey = '000801:TestMod.esp';
    await vscode.commands.executeCommand('modbench.openEditor', { formKey, label: 'Focused Record' });
    await waitFor('the record tab', () => openTabs().some((t) => t.label === 'Focused Record') || undefined);
    const path = [{ kind: 'member', name: 'Keywords' }, { kind: 'index', index: 0 }];
    present(ext?.exports.focusRecordCell, "the activated extension's focusRecordCell export")({
      webviewSection: 'arrayElement', formKey, plugin: 'TestMod.esp', origin: 'Data', path,
      canMoveUp: false, canMoveDown: true, preventDefaultContextMenuItems: true,
    });

    await vscode.commands.executeCommand('modbench.record.removeElement');

    const sent = await waitFor('the edit to reach mEdit', () => recordEdits.at(-1));
    assert.deepStrictEqual(sent, { formKey, body: { plugin: 'TestMod.esp', origin: 'Data', op: 'remove', path } });
  });
});

