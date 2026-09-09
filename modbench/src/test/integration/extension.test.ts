import * as assert from 'assert';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { before, after, beforeEach, afterEach, describe, it } from 'mocha';
import type { PluginMetadata } from '../../medit/ApiClient';

const TEST_PORT = 15172;
let mockBackend: http.Server;
let ext: vscode.Extension<unknown> | undefined;

// The Instance's own read model (ADR-0047): a test that writes plugins.txt and then reads the
// Plugins tree awaits past a sequence with this, rather than assuming the write is visible the
// instant the write call returns.
interface InstanceLike {
  sequence: number;
  subscribe(subscriber: (value: unknown, sequence: number) => void): { dispose(): void };
}
const instanceExport = () => (ext?.exports as { instance?: InstanceLike } | undefined)?.instance;
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

// The backend launches with the extension, so tests drive the lifecycle through activate()'s
// test-API exports: a launch failure is logged-and-swallowed after tearing editing down.
const editingApi = () =>
  ext?.exports as { enterEditing?: () => Promise<void>; exitEditing?: () => void } | undefined;
async function enterEditing(): Promise<void> {
  try {
    await editingApi()?.enterEditing?.();
  } catch {
    editingApi()?.exitEditing?.();
  }
}
function exitEditing(): void {
  editingApi()?.exitEditing?.();
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
  // ADR-0037: a plugin the backend flags with a directly-missing master. Every other entry carries
  // an empty `masterIssues`, which is what the backend sends when all masters resolved.
  mockPlugin({
    name: 'MissingMaster.esp', path: '/data/MissingMaster.esp', origin: 'Data', participates: true,
    masterIssues: [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' }],
  }),
];
const MOCK_RECORD_TYPES = [{ type: 'weap', count: 3, displayName: 'Weapon' }];
let loadOrderHeld = false;
const requestLog: string[] = [];
// Lets a test change what the *next* load reports without touching MOCK_PLUGINS itself —
// simulates a plugin's decoration-worthy state (a master issue, a load failure) changing between
// one load and a reload of the same load order.
let mockPluginsOverride: MockPlugin[] | null = null;
// GET /implicit-masters: the plugins this install loads with no plugins.txt line. Empty by
// default, so a suite's Data/ stubs are presence without being forced on.
let mockImplicitMasters: string[] = [];
// Makes the next PUT /load-order fail the way a bad game directory would. ADR-0044's contract
// disposes the previous scope first, so the mock must not set loadOrderHeld on this path.
let putLoadOrderShouldFail = false;
// Makes the next POST /index/rebuild fail the way another window holding the index would (423).
let rebuildIndexShouldFail = false;
// Makes the next GET /plugins fail the way a transient backend hiccup would mid-session —
// distinct from the 503 "no load order held" answer, which is a normal state, not a failure.
let getPluginsShouldFail = false;
// Mutable per-test so a suite can script a load landing one plugin at a time. `state` is carried
// even though PluginRepository drops it: it is non-nullable on the wire.
type MockLoadOrderStatus = {
  state: 'None' | 'Reconciling' | 'Ready';
  totalPlugins: number;
  indexedPlugins: { name: string; origin: string }[];
  conflictsComputed: boolean;
  failures: { name: string; reason: string }[];
};
const NO_LOAD_ORDER_STATUS: MockLoadOrderStatus =
  { state: 'None', totalPlugins: 0, indexedPlugins: [], conflictsComputed: false, failures: [] };
let loadOrderStatus: MockLoadOrderStatus = { ...NO_LOAD_ORDER_STATUS };
// When set, PUT /load-order does not answer until the test releases it — the real backend's load
// blocks for the whole indexing run, and the progressive-load assertions are about that window.
let releasePutLoadOrder: (() => void) | null = null;
let holdPutLoadOrder = false;
// The client's `start()` gates on GET /health, so holding it parks a launch in its first
// phase — the window a mid-load close also has to survive. One-shot: releasing clears the hold.
let releaseHealth: (() => void) | null = null;
let holdHealth = false;

// ADR-0046 invariant 12: the mock's SSE half. Pushed only where the real backend would publish
// (the PUT /load-order handler below), never on connect, which would reach no listener yet.
const sseClients: http.ServerResponse[] = [];

function writeSseFrame(res: http.ServerResponse, kind: string, payload: Record<string, unknown>): void {
  const data = JSON.stringify({ kind, plugin: '', origin: '', keys: [], sequence: 0, ...payload });
  res.write(`event: ${kind}\ndata: ${data}\n\n`);
}

function pushLoadOrderStatus(): void {
  for (const res of sseClients) writeSseFrame(res, 'load-order-status', { loadOrderStatus });
}

function resetMockBackend(): void {
  loadOrderHeld = false;
  requestLog.length = 0;
  mockPluginsOverride = null;
  mockImplicitMasters = [];
  putLoadOrderShouldFail = false;
  rebuildIndexShouldFail = false;
  getPluginsShouldFail = false;
  loadOrderStatus = { ...NO_LOAD_ORDER_STATUS };
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
      });
      return;
    }
    if (method === 'PUT' && url === '/load-order') {
      req.on('data', () => {}); // drain the body so 'end' fires
      req.on('end', () => {
        // ADR-0044: a failed PUT leaves whatever the backend already held in place — nothing is
        // torn down — so `loadOrderHeld` is not touched here.
        if (putLoadOrderShouldFail) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'simulated load failure' }));
          return;
        }
        // The real load blocks for the whole indexing run. Held open so a test can observe
        // the tree mid-load; answered immediately otherwise, as most suites expect.
        // The real load publishes its progress from the moment it starts, which is why the
        // extension subscribes before the PUT; the tree's held set follows those ticks.
        pushLoadOrderStatus();
        const answer = () => {
          loadOrderHeld = true;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          // The full LoadOrderResponse — `status` and `crashRepairOffers` are non-nullable on the
          // wire, so a body without them is one the backend cannot send.
          res.end(JSON.stringify({ status: 'reconciled', failures: [], crashRepairOffers: [] }));
        };
        // One-shot, like the health hold: the first PUT is the launch's cold reconcile and is
        // parked; a follow-up snapshot (a watcher event coalesced behind it) is the real backend's
        // no-op reconcile and answers at once.
        if (!holdPutLoadOrder) return answer();
        holdPutLoadOrder = false;
        // The real backend's first tick lands once Reconcile is under way, after this PUT lands —
        // which is also after EditingController.putLoadOrder has subscribed.
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
    // Answered from the game directory alone, with no load order held — the Plugins rows and the
    // plugins.txt reconcile both ask it before any PUT (ADR-0021).
    if (url.startsWith('/implicit-masters')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mockImplicitMasters));
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
  ext = vscode.extensions.all.find(e => e.packageJSON?.name === 'modbench');
  const deadline = Date.now() + 5000;
  while (ext && !ext.isActive && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
  }

  // Give the client time to poll and reach 'attached' (polls every 500 ms).
  await new Promise(r => setTimeout(r, 2000));
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
    const channel = (ext?.exports as { outputChannel?: vscode.LogOutputChannel } | undefined)?.outputChannel;
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

describe('modbench command registration', () => {
  // Derived from package.json rather than hand-copied, so a contributed command that was never
  // registered fails here instead of matching a hand-written list that forgot it too. __dirname is
  // three levels under the package root once compiled.
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
  ) as { contributes: { commands: { command: string }[] } };
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

// ── openEditor ────────────────────────────────────────────────────────────────

describe('modbench.openEditor', () => {
  it('opens a new webview tab when no panel exists', async () => {
    const tabsBefore = vscode.window.tabGroups.all.flatMap(g => g.tabs).length;

    await vscode.commands.executeCommand('modbench.openEditor', {
      formKey: 'Fallout4.esm:000001',
      label: 'Test Record',
    });

    await new Promise(r => setTimeout(r, 500));

    const tabsAfter = vscode.window.tabGroups.all.flatMap(g => g.tabs).length;
    assert.ok(tabsAfter > tabsBefore, 'Expected a new tab to be opened by modbench.openEditor');
  });

  it('reuses the existing panel on a second call', async () => {
    const tabsAfterFirst = vscode.window.tabGroups.all.flatMap(g => g.tabs).length;

    await vscode.commands.executeCommand('modbench.openEditor', {
      formKey: 'Fallout4.esm:000002',
      label: 'Another Record',
    });

    await new Promise(r => setTimeout(r, 500));

    const tabsAfterSecond = vscode.window.tabGroups.all.flatMap(g => g.tabs).length;
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
    await new Promise(r => setTimeout(r, 300));

    await vscode.commands.executeCommand('modbench.openEditor', {
      formKey: 'Fallout4.esm:000011',
      label: 'Second Record',
    });
    await new Promise(r => setTimeout(r, 300));

    const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
    const editTab = tabs.find(t => String(t.label).startsWith('First Record') || String(t.label).startsWith('Second Record'));
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
    await new Promise(r => setTimeout(r, 300));

    const tabsBefore = vscode.window.tabGroups.all.flatMap(g => g.tabs).length;

    await vscode.commands.executeCommand('modbench.openEditorBeside', { formKey: 'Fallout4.esm:000021', label: 'Beside Record' });
    await new Promise(r => setTimeout(r, 500));

    const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
    assert.strictEqual(tabs.length, tabsBefore + 1, 'expected a genuinely new tab, not a retarget of the existing singleton');
    assert.ok(tabs.some(t => t.label === 'Seed Record'), 'the singleton panel must still show its own record, untouched');
    assert.ok(tabs.some(t => t.label === 'Beside Record'), 'expected a new tab for the Beside-opened record');
  });

  it('resolves a Plugins-tree RecordNode-shaped argument to its own record', async () => {
    const tabsBefore = vscode.window.tabGroups.all.flatMap(g => g.tabs).length;

    await vscode.commands.executeCommand('modbench.openEditorBeside', {
      kind: 'record',
      record: { formKey: 'Fallout4.esm:000030', plugin: 'Fallout4.esm', editorId: 'TestRecord' },
      origin: 'Data',
      label: 'TestRecord [Fallout4.esm:000030]',
    });
    await new Promise(r => setTimeout(r, 500));

    const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
    assert.strictEqual(tabs.length, tabsBefore + 1, 'expected exactly one new tab');
    assert.ok(
      tabs.some(t => t.label === 'TestRecord [Fallout4.esm:000030]'),
      "expected the tab to carry the RecordNode's own label, not a blank/mEdit placeholder"
    );
  });

  it('resolves a Plugins-tree PlacedNode-shaped argument (placed-reference row) to its own record', async () => {
    const tabsBefore = vscode.window.tabGroups.all.flatMap(g => g.tabs).length;

    await vscode.commands.executeCommand('modbench.openEditorBeside', {
      kind: 'placed',
      placed: { formKey: 'Fallout4.esm:000040', recordType: 'refr', editorId: 'TestRef' },
      origin: 'Data',
      label: 'TestRef [REFR:000040]',
    });
    await new Promise(r => setTimeout(r, 500));

    const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
    assert.strictEqual(tabs.length, tabsBefore + 1, 'expected exactly one new tab');
    assert.ok(
      tabs.some(t => t.label === 'TestRef [REFR:000040]'),
      "expected the tab to carry the PlacedNode's own label, not a blank/mEdit placeholder"
    );
  });

  it('two sequential single-target opens land as two separate tabs — neither retargets the other', async () => {
    const tabsBefore = vscode.window.tabGroups.all.flatMap(g => g.tabs).length;

    await vscode.commands.executeCommand('modbench.openEditorBeside', { formKey: 'Fallout4.esm:000050', label: 'First Beside' });
    await new Promise(r => setTimeout(r, 300));
    await vscode.commands.executeCommand('modbench.openEditorBeside', { formKey: 'Fallout4.esm:000051', label: 'Second Beside' });
    await new Promise(r => setTimeout(r, 300));

    const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
    assert.strictEqual(tabs.length, tabsBefore + 2, 'expected two separate new tabs');
    assert.ok(tabs.some(t => t.label === 'First Beside'), 'first Beside panel should still show its own record');
    assert.ok(tabs.some(t => t.label === 'Second Beside'), 'second Beside panel should show its own record');
  });

  it('a multi-selection opens one panel per record, all landing in a single new editor group beside the active one', async () => {
    const groupsBefore = vscode.window.tabGroups.all.length;
    const tabsBefore = vscode.window.tabGroups.all.flatMap(g => g.tabs).length;

    const selection = [
      { formKey: 'Fallout4.esm:000060', label: 'Multi A' },
      { formKey: 'Fallout4.esm:000061', label: 'Multi B' },
      { formKey: 'Fallout4.esm:000062', label: 'Multi C' },
    ];
    await vscode.commands.executeCommand('modbench.openEditorBeside', selection[0], selection);
    await new Promise(r => setTimeout(r, 700));

    const groupsAfter = vscode.window.tabGroups.all.length;
    const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
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
// esbuild bundles the running extension's own `PluginTreeProvider` inline, so a class imported
// here from source is a distinct constructor — `.kind` is what identifies a node across that
// boundary, the same discriminant `PluginsTreeProvider.ts` switches on internally.
const nodeKind = (node: unknown): unknown => (node as { kind?: unknown } | undefined)?.kind;

describe('modbench.openHeader reachable from every plugin-bearing row of the merged tree', () => {
  it('opens a header tab from an ordinary plugin row (PluginsTreeProvider.PluginNode)', async () => {
    const node = new PluginListPluginNode({ name: 'TestMod.esp', path: '/data/TestMod.esp', enabled: true } as any);
    await vscode.commands.executeCommand('modbench.openHeader', node);
    await new Promise(r => setTimeout(r, 300));
    const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
    assert.ok(tabs.some(t => t.label === 'TestMod.esp'), 'expected a header tab titled after the plugin');
  });

  it('opens a header tab from an implicit-master row (PluginsTreeProvider.ImplicitMasterNode)', async () => {
    const node = new ImplicitMasterNode('Fallout4.esm');
    await vscode.commands.executeCommand('modbench.openHeader', node);
    await new Promise(r => setTimeout(r, 300));
    const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
    assert.ok(tabs.some(t => t.label === 'Fallout4.esm'), 'expected a header tab titled after the implicit master');
  });
});

// ── modbench.downloads tree ─────────────────────────────────────────────────

interface DownloadsProviderLike {
  invalidate(): void;
  getChildren(element?: unknown): Promise<Array<{ label?: unknown; row?: { name: string } }>>;
}

describe('modbench.downloads tree', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const downloadsDir = root ? path.join(root, 'downloads') : '';
  const provider = () => (ext?.exports as { downloadsProvider?: DownloadsProviderLike } | undefined)?.downloadsProvider;

  // The committed test workspace fixture has no downloads/ folder — created and torn down
  // here (mirrors the Overwrite suite's overwriteDir cleanup).
  after(() => {
    if (!root) return;
    fs.rmSync(downloadsDir, { recursive: true, force: true });
  });

  it('exposes the live DownloadsProvider from activate()', () => {
    assert.ok(provider(), 'activate() should return { downloadsProvider } for the open workspace');
  });

  // Rows come from the Instance value (ADR-0047): written through writeAndAwaitInstance and
  // read back with no direct call to the provider's own invalidate().
  it('renders one row per archive, .meta sidecars suppressed', async () => {
    await writeAndAwaitInstance(() => {
      fs.mkdirSync(downloadsDir, { recursive: true });
      fs.writeFileSync(path.join(downloadsDir, 'foo.zip'), 'data');
      fs.writeFileSync(path.join(downloadsDir, 'foo.zip.meta'), '[General]\r\n');
    });

    const rows = await provider()!.getChildren();
    assert.deepStrictEqual(rows.map((r) => r.row?.name), ['foo.zip']);
  });

  it('reflects a new archive dropped into downloads/ via the file-watcher, with no manual refresh', async () => {
    fs.writeFileSync(path.join(downloadsDir, 'bar.zip'), 'data');

    // The watcher debounces 200ms before calling invalidate() itself, so poll for the row rather
    // than sleeping a fixed time. Never calls invalidate() directly: the watcher must do it alone.
    const rows = await new Promise<Array<{ row?: { name: string } }>>((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const check = () => {
        provider()!
          .getChildren()
          .then((found) => {
            if (found.some((r) => r.row?.name === 'bar.zip')) return resolve(found);
            if (Date.now() > deadline) return reject(new Error('bar.zip did not appear via the watcher within 10s'));
            setTimeout(check, 200);
          })
          .catch(reject);
      };
      check();
    });
    assert.ok(rows.some((r) => r.row?.name === 'bar.zip'), 'expected bar.zip among the watcher-refreshed rows');
  });
});

// ── Overwrite row ──────────────────────────────────────────────────────────────

interface ModListLike {
  getChildren(element?: unknown): Promise<Array<{ label?: unknown; kind?: string; resourceUri?: vscode.Uri }>>;
}

describe('Overwrite row', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const overwriteDir = root ? path.join(root, 'overwrite') : '';
  const provider = () => (ext?.exports as { modListProvider?: ModListLike } | undefined)?.modListProvider;

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
    // The count is a field of the Instance value now (ADR-0047) — awaited past a sequence,
    // rather than assuming a fresh disk read the instant invalidate() is called.
    await writeAndAwaitInstance(() => {
      fs.mkdirSync(overwriteDir, { recursive: true });
      fs.writeFileSync(path.join(overwriteDir, 'f4se.log'), 'x');
    });

    const roots = await provider()!.getChildren();
    const last = roots[roots.length - 1];
    assert.strictEqual(last.kind, 'overwrite', 'Overwrite row should be the very last root');
    assert.strictEqual(last.label, 'Overwrite');
  });

  it('reveal action resolves against the overwrite folder without throwing', async () => {
    const p = provider()!;
    const roots = await p.getChildren();
    const node = roots.find((n) => n.kind === 'overwrite');
    assert.ok(node, 'expected an Overwrite node to reveal');
    await vscode.commands.executeCommand('modbench.modList.overwrite.reveal', node);
  });

  it('drops the Overwrite row once overwrite/ is emptied', async () => {
    await writeAndAwaitInstance(() => {
      fs.rmSync(overwriteDir, { recursive: true, force: true });
    });
    const roots = await provider()!.getChildren();
    assert.ok(!roots.some((n) => n.kind === 'overwrite'), 'Overwrite row should disappear when the folder is empty');
  });
});

// ── Notification stream lifecycle is gated on the backend ────────────────────

// ADR-0046 invariant 12: every notification kind rides this one stream, proven once here.
// Placed first — the suite activates once — so "no connection before launch" is provable only
// at the one point in the run where that is still true.
describe('Notification stream connects only while the backend is up', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  let gameDir = '';
  const streamRequests = (log: string[]) => log.filter((r) => r === 'GET /notifications/stream');

  before(async () => {
    if (!root) return;
    resetMockBackend();
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-game-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', gameDir, vscode.ConfigurationTarget.Workspace);
    fs.writeFileSync(path.join(root, 'profiles', 'Default', 'plugins.txt'), '*TestMod.esp\n');
  });

  after(async () => {
    if (!root) return;
    exitEditing();
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', undefined, vscode.ConfigurationTarget.Workspace);
    fs.writeFileSync(path.join(root, 'profiles', 'Default', 'plugins.txt'), '');
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
    await new Promise((r) => setTimeout(r, 1000));
    assert.strictEqual(streamRequests(requestLog).length, 1,
      'expected no reconnect once editing ends');
  });
});

// ── Launch mEdit → editing plugin tree populated ────────────────────────────────

interface TreeLike {
  getChildren(element?: unknown): Promise<Array<{ kind?: string; plugin?: { name?: string } }>>;
}

describe('Launch mEdit populates the editing plugin tree', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const treeProvider = () => (ext?.exports as { treeProvider?: TreeLike } | undefined)?.treeProvider;
  let gameDir = '';

  // enterEditing needs a resolvable game directory and an enabled plugin in the active profile to
  // reach PUT /load-order, so only the suite-scoped plugins.txt and game dir are set up here.
  before(async () => {
    if (!root) return;
    resetMockBackend();
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-game-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', gameDir, vscode.ConfigurationTarget.Workspace);

    await writeAndAwaitInstance(() =>
      fs.writeFileSync(path.join(root, 'profiles', 'Default', 'plugins.txt'), '*TestMod.esp\n'));
  });

  after(async () => {
    if (!root) return;
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', undefined, vscode.ConfigurationTarget.Workspace);
    fs.writeFileSync(path.join(root, 'profiles', 'Default', 'plugins.txt'), '');
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
    const pluginsTreeExport = (ext?.exports as { pluginsTree?: PluginsTreeLike } | undefined)?.pluginsTree;
    assert.ok(pluginsTreeExport, 'activate() should return { pluginsTree } for the merged view');
    const rows = await pluginsTreeExport.getChildren();
    assert.ok(rows.length > 0, 'the merged plugins tree should not be empty after a successful launch');
    const testMod = findRow(rows, 'TestMod.esp');
    const children = await pluginsTreeExport.getChildren(testMod);
    assert.deepStrictEqual(
      children.map((c) => (c as vscode.TreeItem).label), ['Weapon'],
      'TestMod.esp should expand into its record types once the load order has loaded and GET /plugins has landed',
    );
  });
});

// ── The Toolbox stack survives an editing backend ──────────────────────────────
// These prove the two consequences only a live host can show: load-order state survives a
// round trip, and its write path stays reachable while the backend runs.

interface PluginListNodeLike { plugin?: { name?: string; enabled?: boolean } }
interface PluginsTreeProviderLike {
  setFilter(text: string): void;
  setPluginEnabled(name: string, enabled: boolean): Promise<void>;
  handleDrop(target: unknown, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void>;
  invalidate(): void;
  getChildren(element?: unknown): Promise<PluginListNodeLike[]>;
}

describe('The Toolbox stack stays visible through an editing backend', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const pluginsTxtPath = root ? path.join(root, 'profiles', 'Default', 'plugins.txt') : '';
  const pluginListProvider = () =>
    (ext?.exports as { pluginsTree?: PluginsTreeProviderLike } | undefined)?.pluginsTree;
  let gameDir = '';

  before(async () => {
    if (!root) return;
    resetMockBackend();
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-game-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
    // Every line these tests write names a plugin the plugins reconcile would otherwise prune.
    // An unparseable Data/ stub is presence without being an implicit master.
    for (const name of ['TestMod.esp', 'Other.esp']) fs.writeFileSync(path.join(gameDir, 'Data', name), '');
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', gameDir, vscode.ConfigurationTarget.Workspace);
    await writeAndAwaitInstance(() => fs.writeFileSync(pluginsTxtPath, '*TestMod.esp\n*Other.esp\n'));
  });

  after(async () => {
    if (!root) return;
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', undefined, vscode.ConfigurationTarget.Workspace);
    fs.writeFileSync(pluginsTxtPath, '');
    fs.rmSync(gameDir, { recursive: true, force: true });
  });

  it('exposes the live PluginsTreeProvider from activate()', () => {
    assert.ok(pluginListProvider(), 'activate() should return { pluginsTree } for the open workspace');
  });

  it('keeps the Plugin load order filter applied across a Launch mEdit / Close mEdit round trip (AC5)', async () => {
    const provider = pluginListProvider()!;
    provider.setFilter('TestMod');
    const before = await provider.getChildren();
    assert.deepStrictEqual(
      before.map((n) => n.plugin?.name), ['TestMod.esp'],
      'the filter should narrow to the one matching row before entering editing',
    );

    await enterEditing();
    exitEditing();

    const after = await provider.getChildren();
    assert.deepStrictEqual(
      after.map((n) => n.plugin?.name), ['TestMod.esp'],
      'the filter set before Launch mEdit must still be applied after Close mEdit — the Plugins view was never torn down',
    );
  });

  it('still writes plugins.txt through the Plugin load order while the backend is running (AC4)', async () => {
    const provider = pluginListProvider()!;
    provider.setFilter(''); // undo the previous test's filter so both rows are addressable
    await enterEditing();

    await provider.setPluginEnabled('Other.esp', false);

    const written = fs.readFileSync(pluginsTxtPath, 'utf8');
    assert.ok(written.includes('Other.esp'), 'plugins.txt should still list Other.esp, just disabled');
    assert.ok(!written.includes('*Other.esp'), 'disabling a plugin while the backend runs should still write plugins.txt');

    exitEditing();
  });

  it('still writes plugins.txt through the Plugin load order drag-reorder while the backend is running (AC4)', async () => {
    const provider = pluginListProvider()!;
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
// Rows are collapsible from launch (ADR-0035): mEdit is always running, so a chevron encodes no
// absence. Launch/close changes a row's content on expand, never its collapsibleState.

interface PluginsTreeLike {
  getChildren(element?: unknown): Promise<unknown[]>;
  getTreeItem(element: unknown): vscode.TreeItem;
}

// plugins.txt lines carry `plugin.name`; the game's implicitly-loaded masters carry `name`.
const rowName = (row: unknown): string | undefined =>
  (row as PluginListNodeLike).plugin?.name ?? (row as { name?: string }).name;
const findRow = (rows: unknown[], name: string): unknown => {
  const row = rows.find((r) => rowName(r) === name);
  assert.ok(row, `expected a row for ${name}`);
  return row;
};

describe('Plugin load-order rows expand into records', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const pluginsTxtPath = root ? path.join(root, 'profiles', 'Default', 'plugins.txt') : '';
  const pluginsTree = () => (ext?.exports as { pluginsTree?: PluginsTreeLike } | undefined)?.pluginsTree;
  const pluginListProviderOf = () =>
    (ext?.exports as { pluginsTree?: PluginsTreeProviderLike } | undefined)?.pluginsTree;
  let gameDir = '';

  before(async () => {
    if (!root) return;
    resetMockBackend();
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-expand-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
    for (const name of ['TestMod.esp', 'Other.esp']) fs.writeFileSync(path.join(gameDir, 'Data', name), '');
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', gameDir, vscode.ConfigurationTarget.Workspace);
    await writeAndAwaitInstance(() => fs.writeFileSync(pluginsTxtPath, '*TestMod.esp\nOther.esp\n'));
    pluginListProviderOf()?.invalidate();
      // Setting the game directory just now fired the production config-change relaunch
    // (backend down + a directory appeared). Settle it and tear editing down so the
    // tests below still start from the pre-editing state they assert.
    await enterEditing();
    exitEditing();
  });

  after(async () => {
    if (!root) return;
    exitEditing();
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', undefined, vscode.ConfigurationTarget.Workspace);
    fs.writeFileSync(pluginsTxtPath, '');
    fs.rmSync(gameDir, { recursive: true, force: true });
  });

  it('exposes the merged Plugins tree from activate()', () => {
    assert.ok(pluginsTree(), 'activate() should return { pluginsTree } for the open workspace');
  });

  // The extension parses no plugin binary (ADR-0021), so the forced-on rows can only be the
  // backend's answer — nothing here discovers them from the Data folder.
  it('renders the implicit masters the backend names, ahead of the plugins.txt rows', async () => {
    const tree = pluginsTree()!;
    mockImplicitMasters = ['Fallout4.esm'];
    try {
      pluginListProviderOf()!.invalidate();
      const rows = await tree.getChildren();

      assert.strictEqual(rowName(rows[0]), 'Fallout4.esm', 'the backend-named implicit master leads the rows');
      assert.strictEqual(tree.getTreeItem(rows[0]).contextValue, 'pluginImplicit');
    } finally {
      mockImplicitMasters = [];
      pluginListProviderOf()!.invalidate();
    }
  });

  it('renders no implicit row when the backend names none', async () => {
    const tree = pluginsTree()!;
    pluginListProviderOf()!.invalidate();
    const rows = await tree.getChildren();

    assert.ok(!rows.some((r) => tree.getTreeItem(r).contextValue === 'pluginImplicit'));
  });

  it('renders every row collapsible, whether or not mEdit has launched', async () => {
    const tree = pluginsTree()!;
    const rows = await tree.getChildren();

    assert.deepStrictEqual(
      rows.map(rowName).filter((n) => n === 'TestMod.esp' || n === 'Other.esp'), ['TestMod.esp', 'Other.esp'],
      'the rows include both plugins.txt lines, the disabled one too, in file order',
    );
    for (const row of rows) {
      assert.strictEqual(
        tree.getTreeItem(row).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed,
        'rows are collapsible from launch — there is no mode for mEdit not having started yet',
      );
    }
    const children = await tree.getChildren(findRow(rows, 'TestMod.esp'));
    assert.strictEqual(children.length, 1, 'expanding answers exactly one node, never an empty list');
  });

  it('launching mEdit gives a row real children, without reordering the load order', async () => {
    const tree = pluginsTree()!;
    const before = await tree.getChildren();

    await enterEditing();

    const after = await tree.getChildren();
    assert.deepStrictEqual(
      after.map(rowName).filter((n) => n !== undefined), before.map(rowName),
      'launching mEdit must not rebuild or reorder the plugin rows',
    );
    const children = await tree.getChildren(findRow(after, 'TestMod.esp'));
    assert.deepStrictEqual(
      children.map((c) => (c as vscode.TreeItem).label), ['Weapon'],
      'a row whose plugin is in the load order now expands into its record types',
    );
  });

  it('expands a plugin row into its record types', async () => {
    const tree = pluginsTree()!;
    const testMod = findRow(await tree.getChildren(), 'TestMod.esp');

    const children = await tree.getChildren(testMod);

    assert.deepStrictEqual(
      children.map((c) => (c as vscode.TreeItem).label), ['Weapon'],
      'expanding a row shows the record types the backend reports, with xEdit display names',
    );
  });

  it('a disabled plugin browses like any other', async () => {
    const tree = pluginsTree()!;
    const other = findRow(await tree.getChildren(), 'Other.esp'); // the prefix-less plugins.txt line

    assert.strictEqual(
      tree.getTreeItem(other).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed,
      'a disabled plugin is indexed and browsable, just non-participating',
    );
    assert.deepStrictEqual((await tree.getChildren(other)).map((c) => (c as vscode.TreeItem).label), ['Weapon']);
  });

  // ADR-0022: the view has no shape to revert to, so a backend that goes takes nothing with it —
  // the row's own content is what reports the absence, on the expand that asks for it.
  it('keeps every row and its chevron when mEdit closes', async () => {
    const tree = pluginsTree()!;

    exitEditing();

    const rows = await tree.getChildren();
    assert.deepStrictEqual(
      rows.map(rowName).filter((n) => n === 'TestMod.esp' || n === 'Other.esp'), ['TestMod.esp', 'Other.esp'],
      'closing mEdit leaves the load order untouched',
    );
    for (const row of rows) {
      assert.strictEqual(tree.getTreeItem(row).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    }
    const children = await tree.getChildren(findRow(rows, 'TestMod.esp'));
    assert.strictEqual(children.length, 1, 'expanding after close answers exactly one node, never an empty list');
  });
});

// ADR-0035: read-only-for-editing is a tooltip, never an icon, and is known only once a load
// order says so — before launch a plugin row carries no opinion about it at all.
describe('A read-only plugin\'s tooltip says so once the backend is running', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const pluginsTxtPath = root ? path.join(root, 'profiles', 'Default', 'plugins.txt') : '';
  const pluginsTree = () => (ext?.exports as { pluginsTree?: PluginsTreeLike } | undefined)?.pluginsTree;
  const pluginListProviderOf = () =>
    (ext?.exports as { pluginsTree?: PluginsTreeProviderLike } | undefined)?.pluginsTree;
  let gameDir = '';

  before(async () => {
    if (!root) return;
    resetMockBackend();
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-readonly-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
    for (const name of ['Immutable.esm']) fs.writeFileSync(path.join(gameDir, 'Data', name), '');
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', gameDir, vscode.ConfigurationTarget.Workspace);
    await writeAndAwaitInstance(() => fs.writeFileSync(pluginsTxtPath, '*Immutable.esm\n'));
    pluginListProviderOf()?.invalidate();
      // Setting the game directory just now fired the production config-change relaunch
    // (backend down + a directory appeared). Settle it and tear editing down so the
    // tests below still start from the pre-editing state they assert.
    await enterEditing();
    exitEditing();
  });

  after(async () => {
    if (!root) return;
    exitEditing();
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', undefined, vscode.ConfigurationTarget.Workspace);
    fs.writeFileSync(pluginsTxtPath, '');
    fs.rmSync(gameDir, { recursive: true, force: true });
  });

  it('gains a read-only tooltip once the load order reports it immutable', async () => {
    await enterEditing();
    const tree = pluginsTree()!;
    const row = findRow(await tree.getChildren(), 'Immutable.esm');

    const tooltip = tree.getTreeItem(row).tooltip;

    assert.ok(typeof tooltip === 'string' && tooltip.includes('read-only'), `expected a read-only tooltip, got: ${String(tooltip)}`);
  });
});

// ADR-0037: a plugin flagged with a missing master is decorated through the real wiring.
// MOCK_PLUGINS sends raw JSON no PluginMetadata-typed fixture could produce, so TestMod.esp,
// with no `masterIssues` key, proves an absent field degrades to undecorated.
describe('A plugin with a missing master is flagged, never deactivated', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const pluginsTxtPath = root ? path.join(root, 'profiles', 'Default', 'plugins.txt') : '';
  const pluginsTree = () => (ext?.exports as { pluginsTree?: PluginsTreeLike } | undefined)?.pluginsTree;
  const pluginListProviderOf = () =>
    (ext?.exports as { pluginsTree?: PluginsTreeProviderLike } | undefined)?.pluginsTree;
  let gameDir = '';

  before(async () => {
    if (!root) return;
    resetMockBackend();
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-missingmaster-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
    // The mock reports both with origin 'Data', so the Data folder must actually hold them, or
    // reconcile concludes their names resolve to nothing and decorates every row with a load
    // failure instead (ADR-0044).
    for (const name of ['TestMod.esp', 'MissingMaster.esp']) {
      fs.writeFileSync(path.join(gameDir, 'Data', name), '');
    }
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', gameDir, vscode.ConfigurationTarget.Workspace);
    await writeAndAwaitInstance(() => fs.writeFileSync(pluginsTxtPath, '*TestMod.esp\n*MissingMaster.esp\n'));
    pluginListProviderOf()?.invalidate();
    await enterEditing();
  });

  after(async () => {
    if (!root) return;
    exitEditing();
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', undefined, vscode.ConfigurationTarget.Workspace);
    fs.writeFileSync(pluginsTxtPath, '');
    fs.rmSync(gameDir, { recursive: true, force: true });
  });

  it('flags the row with an error decoration naming the missing master, and stays checked', async () => {
    const tree = pluginsTree()!;
    const row = findRow(await tree.getChildren(), 'MissingMaster.esp');
    const item = tree.getTreeItem(row);

    assert.ok(typeof item.tooltip === 'string' && item.tooltip.includes('Missing master: Ghost.esm'),
      `expected a missing-master tooltip, got: ${String(item.tooltip)}`);
    // Never deactivated, excluded or hidden — still expandable (in the load order) and checked.
    assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    assert.strictEqual((row as PluginListNodeLike).plugin?.enabled, true);
    // The leading slot (checkbox) is untouched by this decoration — a real TreeItemCheckboxState
    // read, not just the underlying model's `enabled` flag, so a regression in the decoration
    // logic itself (not just in plugins.txt writing) would be caught here.
    assert.strictEqual(item.checkboxState, vscode.TreeItemCheckboxState.Checked);
  });

  // The negative case: `masterIssues` is non-nullable on the wire, so a plugin whose masters all
  // resolved carries an empty array, and gets no decoration.
  it('leaves a plugin whose masters all resolve undecorated', async () => {
    const tree = pluginsTree()!;
    const row = findRow(await tree.getChildren(), 'TestMod.esp');

    const item = tree.getTreeItem(row);

    assert.strictEqual(item.tooltip, undefined);
  });

});

// ADR-0044: an instance change through the real wiring — the plugins.txt watcher, the load-order
// sync, `PUT /load-order`, and the tree hand-off that follows.
describe('An instance change sends a fresh load order snapshot (ADR-0044)', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const pluginsTxtPath = root ? path.join(root, 'profiles', 'Default', 'plugins.txt') : '';
  const pluginsTree = () => (ext?.exports as { pluginsTree?: PluginsTreeLike } | undefined)?.pluginsTree;
  const pluginListProviderOf = () =>
    (ext?.exports as { pluginsTree?: PluginsTreeProviderLike } | undefined)?.pluginsTree;
  let gameDir = '';
  let pluginsTxtTrailer = '';
  const putCount = () => requestLog.filter((l) => l === 'PUT /load-order').length;

  // A trailing-newline toggle so the bytes change, exercising watcher → sync → PUT end to end.
  async function changePluginsTxt(): Promise<void> {
    const before = putCount();
    const pluginReads = requestLog.filter((l) => l === 'GET /plugins').length;
    pluginsTxtTrailer = pluginsTxtTrailer === '' ? '\n' : '';
    fs.writeFileSync(pluginsTxtPath, '*TestMod.esp\n*MissingMaster.esp\n' + pluginsTxtTrailer);
    await waitFor('a fresh PUT /load-order after plugins.txt changed', () => putCount() > before ? true : undefined);
    // The PUT is answered, but the tree hand-off (GET /plugins → setLoadOrder) follows it
    // asynchronously; wait for that read too — unless the PUT failed, in which case there is none.
    if (!putLoadOrderShouldFail) {
      await waitFor('the tree hand-off after the PUT', () => requestLog.filter((l) => l === 'GET /plugins').length > pluginReads ? true : undefined);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  before(async () => {
    if (!root) return;
    resetMockBackend();
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-reconcile-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
    for (const name of ['TestMod.esp', 'MissingMaster.esp']) {
      fs.writeFileSync(path.join(gameDir, 'Data', name), '');
    }
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', gameDir, vscode.ConfigurationTarget.Workspace);
    fs.writeFileSync(pluginsTxtPath, '*TestMod.esp\n*MissingMaster.esp\n');
    pluginListProviderOf()?.invalidate();
    await enterEditing();
  });

  after(async () => {
    if (!root) return;
    exitEditing();
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', undefined, vscode.ConfigurationTarget.Workspace);
    fs.writeFileSync(pluginsTxtPath, '');
    fs.rmSync(gameDir, { recursive: true, force: true });
  });

  it('a plugins.txt write is followed by a fresh PUT /load-order, no command required', async () => {
    const before = putCount();

    await changePluginsTxt();

    assert.ok(putCount() >= before + 1, 'a plugins.txt change must send a fresh snapshot, not merely re-render the tree');
  });

  // The WeakMap decoration restores each row to its captured original before re-deciding what
  // to layer back on, so the same row object must lose a decoration once the backend stops
  // reporting its condition rather than gain a second copy.
  it('clears a resolved master-issue decoration on the same row after the next reconcile, not just applies it', async () => {
    const tree = pluginsTree()!;
    const before = findRow(await tree.getChildren(), 'MissingMaster.esp');
    const beforeTooltip = tree.getTreeItem(before).tooltip;
    assert.ok(typeof beforeTooltip === 'string' && beforeTooltip.includes('Missing master: Ghost.esm'),
      `expected the row to carry the master-issue tooltip before the reconcile, got: ${String(beforeTooltip)}`);

    // The next reconcile reports the same plugin with its master issue resolved.
    mockPluginsOverride = MOCK_PLUGINS.map((p) => p.name === 'MissingMaster.esp' ? { ...p, masterIssues: [] } : p);
    await changePluginsTxt();

    const after = findRow(await tree.getChildren(), 'MissingMaster.esp');
    assert.strictEqual(tree.getTreeItem(after).tooltip, undefined,
      'a resolved master issue must clear the tooltip, not leave the stale decoration stacked on top of the fresh one');
  });

  // If matchingPlugins were refreshed only by setFilter/clearFilter, a suppressed plugin would
  // stay suppressed through a reconcile with no filter at all. Under ADR-0035 such a plugin has
  // no row, so absence is what is asserted.
  it('hides a plugin a filter suppresses, and restores it once a reconcile comes up with no filter', async () => {
    const tree = pluginsTree()!;
    const before = findRow(await tree.getChildren(), 'TestMod.esp');
    assert.strictEqual(tree.getTreeItem(before).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed,
      'sanity: the row is expandable before either reconcile below');

    mockPluginsOverride = MOCK_PLUGINS.map((p) => p.name === 'TestMod.esp' ? { ...p, hasMatchingRecords: false } : p);
    await changePluginsTxt();
    const hidden = (await tree.getChildren()).find((r) => rowName(r) === 'TestMod.esp');
    assert.strictEqual(hidden, undefined,
      'sanity: the mechanism reaches the tree — a filter with no matches on this plugin hides its row entirely, not just its chevron');

    mockPluginsOverride = null;
    await changePluginsTxt();
    const restored = findRow(await tree.getChildren(), 'TestMod.esp');
    assert.strictEqual(tree.getTreeItem(restored).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed,
      'a reconcile that comes up with no filter must restore a row an earlier filter hid, not leave it permanently gone');
  });

  // ADR-0044: a failed PUT tears nothing down — the backend still holds what it held — so the
  // tree keeps its chevrons rather than tearing editing down.
  it('keeps the rows expandable, without throwing, when the reconcile itself fails', async () => {
    const tree = pluginsTree()!;
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
  });
});

// ADR-0022: mEdit runs for the extension's whole lifetime, so a status change is news the views
// report — none of them has a shape to revert to. Driven through the real status transition, not
// its extracted wiring in isolation.
describe('a client that reports stopped outside exitEditing leaves the Plugins tree\'s shape alone', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const pluginsTxtPath = root ? path.join(root, 'profiles', 'Default', 'plugins.txt') : '';
  const pluginsTree = () => (ext?.exports as { pluginsTree?: PluginsTreeLike } | undefined)?.pluginsTree;
  const clientOf = () =>
    (ext?.exports as { client?: { stop(): Promise<void>; status: string } } | undefined)?.client;
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
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', gameDir, vscode.ConfigurationTarget.Workspace);
    fs.writeFileSync(pluginsTxtPath, '*TestMod.esp\n');
    await enterEditing();
    const tree = pluginsTree()!;
    await waitFor('the activation reconcile to filter TestMod.esp out',
      async () => ((await tree.getChildren()).some((r) => rowName(r) === 'TestMod.esp') ? undefined : true));
  });

  afterEach(async () => {
    if (!root) return;
    exitEditing();
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', undefined, vscode.ConfigurationTarget.Workspace);
    fs.writeFileSync(pluginsTxtPath, '');
    resetMockBackend();
  });

  it('the row a record filter hid stays hidden', async () => {
    const tree = pluginsTree()!;

    await clientOf()?.stop();
    await new Promise((r) => setTimeout(r, 200)); // let the status listener's refresh land

    assert.ok(!(await tree.getChildren()).some((r) => rowName(r) === 'TestMod.esp'),
      'a stopped client is not a reason to un-narrow a view the user narrowed');
  });

  // The expand is the discriminator: a tree that forgot its load order answers "mEdit is not
  // connected" for every row, whatever the row's own content would have been.
  it('a row still in the tree keeps the load order behind its chevron', async () => {
    mockPluginsOverride = null; // this one is about the rows the filter left alone
    const tree = pluginsTree()!;
    await enterEditing();
    const row = findRow(await tree.getChildren(), 'TestMod.esp');

    await clientOf()?.stop();
    await new Promise((r) => setTimeout(r, 200));

    const children = await tree.getChildren(row);
    assert.ok(children.length > 0, 'the row must still expand into something');
    assert.ok(!children.some((c) => tree.getTreeItem(c).label === 'mEdit is not connected.'),
      'the tree kept its load order, so the row expands into records');
  });
});

// ADR-0046: Refresh rebuilds the Index (drops and reopens it empty) and then resends the load
// order exactly as a cold load does, so the reconcile that follows re-indexes everything.
describe('Refresh rebuilds the index, then resends the load order', () => {
  beforeEach(() => resetMockBackend());
  after(() => resetMockBackend());

  it('POSTs /index/rebuild before it PUTs /load-order', async () => {
    await vscode.commands.executeCommand('modbench.refresh');

    const rebuildAt = requestLog.indexOf('POST /index/rebuild');
    const putAt = requestLog.indexOf('PUT /load-order');
    assert.ok(rebuildAt >= 0, 'modbench.refresh must rebuild the index');
    assert.ok(putAt >= 0, 'modbench.refresh must resend the load order after the rebuild');
    assert.ok(rebuildAt < putAt, 'the rebuild must run before the load order is resent');
  });

  it('sends no load order when the rebuild is refused (the index held elsewhere)', async () => {
    rebuildIndexShouldFail = true;

    await vscode.commands.executeCommand('modbench.refresh');

    assert.ok(requestLog.some((l) => l === 'POST /index/rebuild'), 'sanity: the rebuild must still be attempted');
    assert.ok(
      !requestLog.some((l) => l === 'PUT /load-order'),
      'a refused rebuild must not be followed by a load-order send',
    );
  });
});

// ── ADR-0035: progressive load ──────────────────────────────────────────────────
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
  const pluginsTree = () => (ext?.exports as { pluginsTree?: PluginsTreeLike } | undefined)?.pluginsTree;
  const pluginListProviderOf = () =>
    (ext?.exports as { pluginsTree?: PluginsTreeProviderLike } | undefined)?.pluginsTree;
  let gameDir = '';

  const childrenFor = async (name: string) => {
    const tree = pluginsTree()!;
    return tree.getChildren(findRow(await tree.getChildren(), name));
  };

  const itemFor = async (name: string) => {
    const tree = pluginsTree()!;
    return tree.getTreeItem(findRow(await tree.getChildren(), name));
  };

  before(async () => {
    if (!root) return;
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-progressive-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
    for (const name of ['TestMod.esp', 'Other.esp', 'MissingMaster.esp', 'Immutable.esm']) fs.writeFileSync(path.join(gameDir, 'Data', name), '');
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', gameDir, vscode.ConfigurationTarget.Workspace);
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
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', undefined, vscode.ConfigurationTarget.Workspace);
    fs.writeFileSync(pluginsTxtPath, '');
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
    pluginListProviderOf()?.invalidate();
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
  // Nothing is read before the PUT is logged: until the load starts, the tree still holds the
  // previous one, and a read against that would answer about a load order already superseded.
  const waitForIndexed = (name: string) => waitFor(`the backend to be asked about ${name} once indexed`, async () => {
    if (!requestLog.includes('PUT /load-order')) return undefined;
    await childrenFor(name);
    return recordTypesAttempted(name) ? true : undefined;
  });

  it('makes a plugin browsable as soon as it is indexed, while a later one is still indexing', async () => {
    setIndexed(['TestMod.esp']);
    const launch = enterEditing();

    await waitForIndexed('TestMod.esp');

    // What makes it progressive rather than merely early: a plugin the load has not reached
    // answers "still indexing" from client-side state alone, asking the backend nothing.
    assert.ok(await stillIndexing('Other.esp'), 'Other.esp has not been indexed yet and must answer "still indexing"');
    assert.ok(!recordTypesAttempted('Other.esp'), 'a plugin the load has not reached must not be asked about at all');

    setIndexed(['TestMod.esp', 'Other.esp']);
    await waitForIndexed('Other.esp');

    releasePutLoadOrder!();
    await launch;
  });

  // A per-plugin failure surfaces when it occurs, not only at the end of the load.
  it('decorates a plugin that failed to load the moment it is reported, not at the end', async () => {
    setIndexed(['TestMod.esp'], { failures: [{ name: 'Other.esp', reason: 'RACE parse' }] });
    const launch = enterEditing();

    const item = await waitFor('Other.esp to be decorated with its load failure mid-load', async () => {
      const candidate = await itemFor('Other.esp');
      return candidate.description === '✗ Failed to load' ? candidate : undefined;
    });

    assert.ok(typeof item.tooltip === 'string' && item.tooltip.includes('RACE parse'),
      `expected the failure reason in the tooltip, got: ${String(item.tooltip)}`);

    releasePutLoadOrder!();
    await launch;
  });

  // Closing mEdit mid-load is a deliberate abandonment: the stream closes with the backend it was
  // opened against. The "no error toast" half lives at the LoadOrderController seam.
  it('closes the notification stream when mEdit is closed mid-load', async () => {
    setIndexed(['TestMod.esp']);
    const launch = enterEditing();
    await waitForIndexed('TestMod.esp');
    const connectionsAtLoad = requestLog.filter((l) => l === 'GET /notifications/stream').length;
    assert.ok(connectionsAtLoad > 0, 'the load should have been subscribed before it was abandoned');

    exitEditing();
    // The abandoned load resolves on its own — the abort reaches the in-flight POST rather than
    // leaving it to wait for a socket that will never answer.
    await launch;

    await new Promise((r) => setTimeout(r, 1000));

    assert.strictEqual(
      requestLog.filter((l) => l === 'GET /notifications/stream').length, connectionsAtLoad,
      'closing mEdit must not reconnect the stream against a dead backend',
    );
    const children = await childrenFor('TestMod.esp');
    assert.strictEqual(children.length, 1, 'expanding after an abandoned load answers exactly one node, never an empty list');
    assert.strictEqual(
      (ext?.exports as { pluginListView?: { message?: string } } | undefined)?.pluginListView?.message,
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
    (vscode.window as { showErrorMessage: unknown }).showErrorMessage =
      (message: string) => { errors.push(message); return Promise.resolve(undefined); };
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
      (vscode.window as { showErrorMessage: unknown }).showErrorMessage = realShowError;
    }
  });

  // Master issues derive from the whole load order, so mid-load they would flag masters not
  // opened yet. The backend suppresses them while loading; this asserts the suppression holds
  // end to end and then lifts by itself.
  it('leaves master issues off the rows until the load completes, then decorates them with no user action', async () => {
    setIndexed(['TestMod.esp', 'MissingMaster.esp']);
    const launch = enterEditing();

    await waitForIndexed('MissingMaster.esp');
    const midLoad = await itemFor('MissingMaster.esp');
    assert.ok(
      !(typeof midLoad.tooltip === 'string' && midLoad.tooltip.includes('Missing master: Ghost.esm')),
      `master issues must not be decorated mid-load, got: ${String(midLoad.tooltip)}`,
    );

    releasePutLoadOrder!();
    await launch;

    const loaded = await itemFor('MissingMaster.esp');
    assert.ok(typeof loaded.tooltip === 'string' && loaded.tooltip.includes('Missing master: Ghost.esm'),
      `expected the missing-master tooltip once the load completed, got: ${String(loaded.tooltip)}`);
    // A progressive tick carries empty readOnly/masterIssues, so if a tick were ever the last
    // setLoadOrder call both decorations would vanish from a fully loaded tree. Asserting one of each
    // proves the completion hand-off runs after the last tick.
    const immutable = await itemFor('Immutable.esm');
    assert.ok(typeof immutable.tooltip === 'string' && immutable.tooltip.includes('read-only'),
      `expected the read-only note once the load completed, got: ${String(immutable.tooltip)}`);
    // Immutable.esm never appears in a progress tick's indexedPlugins, so its browsability can
    // only come from the completion hand-off's file set, which a hand-off applying only readOnly
    // would drop.
    assert.ok(
      !(await stillIndexing('Immutable.esm')),
      'Immutable.esm was indexed but never named in a progress tick — it must still browse once the completion hand-off lands',
    );
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
      (vscode.window as { showErrorMessage: unknown }).showErrorMessage =
        (message: string) => { errors.push(message); return Promise.resolve(undefined); };
      try {
        // An escaped rejection out of the command callback fails executeCommand's own returned promise,
        // so awaiting with no try/catch is the assertion.
        await vscode.commands.executeCommand(command, headerArg);

        assert.ok(requestLog.some((l) => l === 'GET /plugins'),
          'the command must have actually reached pickCopyDestination\'s getPlugins() call');
        assert.strictEqual(errors.length, 1, `expected exactly one error toast, got: ${JSON.stringify(errors)}`);
        assert.ok(errors[0].startsWith('Modbench:'), `expected a Modbench-authored toast, got: ${errors[0]}`);
        assert.ok(!errors[0].includes('fetch failed'), `must not surface the raw fetch error verbatim, got: ${errors[0]}`);
      } finally {
        (vscode.window as { showErrorMessage: unknown }).showErrorMessage = realShowError;
      }
    });
  }
});
