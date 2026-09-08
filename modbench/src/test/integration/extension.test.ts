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
// test-API exports: a launch failure is logged-and-swallowed after resetting to loadout.
const editingApi = () =>
  ext?.exports as { enterEditing?: () => Promise<void>; exitToLoadout?: () => void } | undefined;
async function enterEditing(): Promise<void> {
  try {
    await editingApi()?.enterEditing?.();
  } catch {
    editingApi()?.exitToLoadout?.();
  }
}
function exitEditing(): void {
  editingApi()?.exitToLoadout?.();
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
// `BackendManager.start()` gates on GET /health, so holding it parks a launch in its first
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
  // BackendManager's first poll succeeds.
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

  // Give BackendManager time to poll and reach 'attached' (polls every 500 ms).
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
import { PluginNode as PluginListPluginNode, ImplicitMasterNode } from '../../modmanager/PluginListProvider';

describe('modbench.openHeader reachable from every plugin-bearing row of the merged tree', () => {
  it('opens a header tab from an ordinary plugin row (PluginListProvider.PluginNode)', async () => {
    const node = new PluginListPluginNode({ name: 'TestMod.esp', path: '/data/TestMod.esp', enabled: true } as any);
    await vscode.commands.executeCommand('modbench.openHeader', node);
    await new Promise(r => setTimeout(r, 300));
    const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
    assert.ok(tabs.some(t => t.label === 'TestMod.esp'), 'expected a header tab titled after the plugin');
  });

  it('opens a header tab from an implicit-master row (PluginListProvider.ImplicitMasterNode)', async () => {
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
  invalidate(): void;
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
    fs.mkdirSync(overwriteDir, { recursive: true });
    fs.writeFileSync(path.join(overwriteDir, 'f4se.log'), 'x');

    const p = provider()!;
    p.invalidate();
    const roots = await p.getChildren();
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
    fs.rmSync(overwriteDir, { recursive: true, force: true });
    const p = provider()!;
    p.invalidate();
    const roots = await p.getChildren();
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

    // The merged Plugins tree is what reflects a successful launch: its TestMod.esp row becomes
    // expandable only after the load order's own GET /plugins lands, so an expandable row proves
    // the fetch happened, and happened after load.
    const pluginsTreeExport = (ext?.exports as { pluginsTree?: PluginsTreeLike } | undefined)?.pluginsTree;
    assert.ok(pluginsTreeExport, 'activate() should return { pluginsTree } for the merged view');
    const rows = await pluginsTreeExport.getChildren();
    assert.ok(rows.length > 0, 'the merged plugins tree should not be empty after a successful launch');
    const testMod = findRow(rows, 'TestMod.esp');
    assert.strictEqual(
      pluginsTreeExport.getTreeItem(testMod).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed,
      'TestMod.esp should be expandable once the load order has loaded and GET /plugins has landed',
    );
  });
});

// ── Loadout survives an editing backend ────────────────────────────────────────
// These prove the two consequences only a live host can show: load-order state survives a
// round trip, and its write path stays reachable while the backend runs.

interface PluginListNodeLike { plugin?: { name?: string; enabled?: boolean } }
interface PluginListProviderLike {
  setFilter(text: string): void;
  setPluginEnabled(name: string, enabled: boolean): Promise<void>;
  handleDrop(target: unknown, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void>;
  invalidate(): void;
  getChildren(element?: unknown): Promise<PluginListNodeLike[]>;
}

describe('Loadout stays visible through an editing backend', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const pluginsTxtPath = root ? path.join(root, 'profiles', 'Default', 'plugins.txt') : '';
  const pluginListProvider = () =>
    (ext?.exports as { pluginListProvider?: PluginListProviderLike } | undefined)?.pluginListProvider;
  let gameDir = '';

  before(async () => {
    if (!root) return;
    resetMockBackend();
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-game-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
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

  it('exposes the live PluginListProvider from activate()', () => {
    assert.ok(pluginListProvider(), 'activate() should return { pluginListProvider } for the open workspace');
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
      'the filter set before Launch mEdit must still be applied after Close mEdit — the loadout view was never torn down',
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

    // Same mime type PluginListProvider.ts's private DND_MIME constant uses — pinned here since
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
// Chevrons appearing across the tree are the whole "editing is available now" signal (ADR-0035):
// with no backend the rows are leaves, a load order makes them collapsible, closing puts them back.

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
    (ext?.exports as { pluginListProvider?: PluginListProviderLike } | undefined)?.pluginListProvider;
  let gameDir = '';

  before(async () => {
    if (!root) return;
    resetMockBackend();
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-expand-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', gameDir, vscode.ConfigurationTarget.Workspace);
    await writeAndAwaitInstance(() => fs.writeFileSync(pluginsTxtPath, '*TestMod.esp\nOther.esp\n'));
    pluginListProviderOf()?.invalidate();
      // Setting the game directory just now fired the production config-change relaunch
    // (backend down + a directory appeared). Settle it and return to loadout so the
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

  it('renders the load order as leaves with no backend running', async () => {
    const tree = pluginsTree()!;
    const rows = await tree.getChildren();

    assert.deepStrictEqual(
      rows.map(rowName).filter((n) => n === 'TestMod.esp' || n === 'Other.esp'), ['TestMod.esp', 'Other.esp'],
      'the rows include both plugins.txt lines, the disabled one too, in file order',
    );
    for (const row of rows) {
      assert.strictEqual(
        tree.getTreeItem(row).collapsibleState, vscode.TreeItemCollapsibleState.None,
        'with no backend running every row is a leaf',
      );
    }
  });

  it('makes rows collapsible when a mEdit starts, without reordering the load order', async () => {
    const tree = pluginsTree()!;
    const before = await tree.getChildren();

    await enterEditing();

    const after = await tree.getChildren();
    assert.deepStrictEqual(
      after.map(rowName).filter((n) => n !== undefined), before.map(rowName),
      'launching mEdit must not rebuild or reorder the plugin rows',
    );
    assert.strictEqual(
      tree.getTreeItem(findRow(after, 'TestMod.esp')).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed,
      'a row whose plugin is in the load order gains a chevron',
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

  it('returns every row to a leaf when the mEdit closes, keeping the load order', async () => {
    const tree = pluginsTree()!;

    exitEditing();

    const rows = await tree.getChildren();
    assert.deepStrictEqual(
      rows.map(rowName).filter((n) => n === 'TestMod.esp' || n === 'Other.esp'), ['TestMod.esp', 'Other.esp'],
      'closing mEdit leaves the load order untouched',
    );
    for (const row of rows) {
      assert.strictEqual(tree.getTreeItem(row).collapsibleState, vscode.TreeItemCollapsibleState.None);
    }
  });
});

// ADR-0035: read-only-for-editing is a tooltip, never an icon, and is known only once a load
// order says so — before launch a plugin row carries no opinion about it at all.
describe('A read-only plugin\'s tooltip says so once the backend is running', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const pluginsTxtPath = root ? path.join(root, 'profiles', 'Default', 'plugins.txt') : '';
  const pluginsTree = () => (ext?.exports as { pluginsTree?: PluginsTreeLike } | undefined)?.pluginsTree;
  const pluginListProviderOf = () =>
    (ext?.exports as { pluginListProvider?: PluginListProviderLike } | undefined)?.pluginListProvider;
  let gameDir = '';

  before(async () => {
    if (!root) return;
    resetMockBackend();
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-readonly-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', gameDir, vscode.ConfigurationTarget.Workspace);
    await writeAndAwaitInstance(() => fs.writeFileSync(pluginsTxtPath, '*Immutable.esm\n'));
    pluginListProviderOf()?.invalidate();
      // Setting the game directory just now fired the production config-change relaunch
    // (backend down + a directory appeared). Settle it and return to loadout so the
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

  it('carries no read-only tooltip before a load order exists', async () => {
    const tree = pluginsTree()!;
    const row = findRow(await tree.getChildren(), 'Immutable.esm');
    assert.strictEqual(tree.getTreeItem(row).tooltip, undefined);
  });

  it('gains a read-only tooltip once the load order reports it immutable', async () => {
    await enterEditing();
    const tree = pluginsTree()!;
    const row = findRow(await tree.getChildren(), 'Immutable.esm');

    const tooltip = tree.getTreeItem(row).tooltip;

    assert.ok(typeof tooltip === 'string' && tooltip.includes('read-only'), `expected a read-only tooltip, got: ${String(tooltip)}`);
  });

  it('loses the tooltip again once the mEdit closes', async () => {
    exitEditing();
    const tree = pluginsTree()!;
    const row = findRow(await tree.getChildren(), 'Immutable.esm');

    assert.strictEqual(tree.getTreeItem(row).tooltip, undefined);
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
    (ext?.exports as { pluginListProvider?: PluginListProviderLike } | undefined)?.pluginListProvider;
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

// ADR-0044: a loadout change through the real wiring — the plugins.txt watcher, the load-order
// sync, `PUT /load-order`, and the tree hand-off that follows.
describe('A loadout change sends a fresh load order snapshot (ADR-0044)', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const pluginsTxtPath = root ? path.join(root, 'profiles', 'Default', 'plugins.txt') : '';
  const pluginsTree = () => (ext?.exports as { pluginsTree?: PluginsTreeLike } | undefined)?.pluginsTree;
  const pluginListProviderOf = () =>
    (ext?.exports as { pluginListProvider?: PluginListProviderLike } | undefined)?.pluginListProvider;
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
  // tree keeps its chevrons rather than exiting to Loadout.
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

// ADR-0035 amending ADR-0018: the match map answers for the active filter only, so three
// writers reset it to undefined rather than answer for a filter or load order that has gone:
// refreshMatchingPlugins's failure path, exitToLoadout, and clearTreeWhenBackendDies.
describe('matchingPlugins resets to undefined once it cannot answer for the active filter or load order', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const pluginsTxtPath = root ? path.join(root, 'profiles', 'Default', 'plugins.txt') : '';
  const loadOrderSyncOf = () =>
    (ext?.exports as { loadOrderSync?: { matches: (file: string) => boolean | undefined } } | undefined)?.loadOrderSync;
  interface BackendManagerLike {
    stop(): Promise<void>;
    listeners(event: string): ((...args: unknown[]) => void)[];
    removeAllListeners(event: string): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
  }
  const backendManagerOf = () =>
    (ext?.exports as { backendManager?: BackendManagerLike } | undefined)?.backendManager;
  let gameDir = '';

  before(() => {
    if (!root) return;
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-matching-plugins-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
    fs.writeFileSync(path.join(gameDir, 'Data', 'TestMod.esp'), '');
  });

  after(() => {
    if (!root) return;
    fs.rmSync(gameDir, { recursive: true, force: true });
  });

  // Each test starts from "a record filter has already ruled TestMod.esp out", set directly rather
  // than through a setFilter round trip: which filter produced the map cannot matter to what clears it.
  beforeEach(async () => {
    if (!root) return;
    resetMockBackend();
    mockPluginsOverride = MOCK_PLUGINS.map((p) => (p.name === 'TestMod.esp' ? { ...p, hasMatchingRecords: false } : p));
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', gameDir, vscode.ConfigurationTarget.Workspace);
    fs.writeFileSync(pluginsTxtPath, '*TestMod.esp\n');
    await enterEditing();
    await waitFor('the activation reconcile to record TestMod.esp as filtered out',
      () => (loadOrderSyncOf()?.matches('testmod.esp') === false ? true : undefined));
  });

  afterEach(async () => {
    if (!root) return;
    exitEditing();
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', undefined, vscode.ConfigurationTarget.Workspace);
    fs.writeFileSync(pluginsTxtPath, '');
    resetMockBackend();
  });

  it('exitToLoadout clears the match map, not just the tree', () => {
    // exitToLoadout's stop() also fires clearTreeWhenBackendDies's 'status' listener, a second writer
    // of the same map — detached here so this test proves exitToLoadout's own write, restored after.
    const bm = backendManagerOf();
    const statusListeners = bm?.listeners('status') ?? [];
    bm?.removeAllListeners('status');
    try {
      exitEditing();
      assert.strictEqual(loadOrderSyncOf()?.matches('testmod.esp'), undefined,
        'closing mEdit must forget which plugins an old record filter matched, not leave a stale answer for the next session');
    } finally {
      for (const listener of statusListeners) bm?.on('status', listener);
    }
  });

  it('a failed refresh after clearing the filter drops the stale match rather than keeping it', async () => {
    getPluginsShouldFail = true;
    try {
      await vscode.commands.executeCommand('modbench.clearFilter');
      const cleared = await waitFor('refreshMatchingPlugins\'s failed GET /plugins to clear the stale match',
        () => (loadOrderSyncOf()?.matches('testmod.esp') === undefined ? true : undefined));
      assert.strictEqual(cleared, true);
    } finally {
      getPluginsShouldFail = false;
    }
  });

  it('a backend that goes unhealthy outside exitToLoadout still clears the match map', async () => {
    await backendManagerOf()?.stop();
    assert.strictEqual(loadOrderSyncOf()?.matches('testmod.esp'), undefined,
      'a dead backend must forget which plugins an old record filter matched, the same as an explicit Close mEdit');
  });
});

// The record filter is a fact about the load order, so it cannot outlive one — a readout
// describing a load order that is gone. The name filter survives a close: its rows remain.
describe('The record-filter readout does not outlive its load order', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const pluginsTxtPath = root ? path.join(root, 'profiles', 'Default', 'plugins.txt') : '';
  const description = () =>
    (ext?.exports as { pluginListView?: { description?: string } } | undefined)?.pluginListView?.description;
  let gameDir = '';

  before(async () => {
    if (!root) return;
    resetMockBackend();
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-exit-filter-readout-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', gameDir, vscode.ConfigurationTarget.Workspace);
    fs.writeFileSync(pluginsTxtPath, '*TestMod.esp\n');
  });

  after(async () => {
    if (!root) return;
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', undefined, vscode.ConfigurationTarget.Workspace);
    fs.writeFileSync(pluginsTxtPath, '');
    fs.rmSync(gameDir, { recursive: true, force: true });
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    resetMockBackend();
  });

  it('an explicit Close mEdit takes the record filter out of the description', async () => {
    await enterEditing();
    // Applied from an open document — the one record-filter entry point a test can drive; the
    // other opens a quick pick over the scripts folder.
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: 'SELECT form_key FROM "npc_"' });
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('modbench.setFilterFromDocument');
    assert.ok(description()?.includes('records:'),
      `sanity: the description must name the record filter before Close mEdit, or clearing it proves nothing (was: ${description() ?? 'unset'})`);

    exitEditing();

    assert.ok(!(description() ?? '').includes('records:'),
      'a load order that does not exist must not leave the view still claiming a record filter');
  });
});

// Close mEdit must clear the readout, the context key the Clear action is gated on, and the code
// lens's notion of which SQL is active; all go through the filter's single writer.

// The context key is unreadable from a test, but the code lens is a genuinely registered
// provider, so proving it clears proves that single writer ran.
describe('Close mEdit clears the record filter\'s code lens too, not just the readout', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const pluginsTxtPath = root ? path.join(root, 'profiles', 'Default', 'plugins.txt') : '';
  // FilterCodeLensProvider renders lenses only for documents inside scriptsPath, resolved once
  // at activate() and not reconfigurable. The file goes in an mkdtempSync'd subdirectory so a
  // leak reads as this test's own; a subdirectory still matches the prefix gate.
  const scriptsDir = path.join(os.homedir(), '.medit', 'scripts');
  const sql = 'SELECT form_key FROM "npc_"';
  let gameDir = '';
  let scriptsSubdir = '';
  let scriptsFile = '';

  const codeLensCommandFor = async (uri: vscode.Uri): Promise<string | undefined> => {
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[] | undefined>('vscode.executeCodeLensProvider', uri);
    return lenses?.at(0)?.command?.command;
  };

  before(async () => {
    if (!root) return;
    resetMockBackend();
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-exit-filter-lens-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', gameDir, vscode.ConfigurationTarget.Workspace);
    fs.writeFileSync(pluginsTxtPath, '*TestMod.esp\n');
    fs.mkdirSync(scriptsDir, { recursive: true });
    scriptsSubdir = fs.mkdtempSync(path.join(scriptsDir, '__test-354-'));
    scriptsFile = path.join(scriptsSubdir, 'filter-lens.sql');
    fs.writeFileSync(scriptsFile, sql);
  });

  after(async () => {
    if (!root) return;
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', undefined, vscode.ConfigurationTarget.Workspace);
    fs.writeFileSync(pluginsTxtPath, '');
    fs.rmSync(gameDir, { recursive: true, force: true });
    // Tolerate the directory already being gone; a cleanup failure here must never mask the
    // test's own assertion result.
    try { fs.rmSync(scriptsSubdir, { recursive: true, force: true }); } catch { /* best-effort */ }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    resetMockBackend();
  });

  it('an explicit Close mEdit clears the code lens the same way it clears the readout', async () => {
    await enterEditing();
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(scriptsFile));
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('modbench.setFilterFromDocument');

    assert.strictEqual(await codeLensCommandFor(doc.uri), 'modbench.clearFilter',
      'sanity: the code lens must report the filter active before Close mEdit, or clearing it proves nothing');

    exitEditing();

    assert.strictEqual(await codeLensCommandFor(doc.uri), 'modbench.setFilterFromDocument',
      'a load order that does not exist must not leave the code lens still claiming its SQL is active');
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
    (ext?.exports as { pluginListProvider?: PluginListProviderLike } | undefined)?.pluginListProvider;
  let gameDir = '';

  const itemFor = async (name: string) => {
    const tree = pluginsTree()!;
    return tree.getTreeItem(findRow(await tree.getChildren(), name));
  };

  before(async () => {
    if (!root) return;
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-progressive-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', gameDir, vscode.ConfigurationTarget.Workspace);
    await writeAndAwaitInstance(() =>
      fs.writeFileSync(pluginsTxtPath, '*TestMod.esp\n*Other.esp\n*MissingMaster.esp\n*Immutable.esm\n'));
      // Setting the game directory just now fired the production config-change relaunch
    // (backend down + a directory appeared). Settle it and return to loadout so the
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

  // Rows gain chevrons as each plugin lands, not all at once at the end.
  it('makes a plugin expandable as soon as it is indexed, while a later one is still a leaf', async () => {
    setIndexed(['TestMod.esp']);
    const launch = enterEditing();

    await waitFor('TestMod.esp to gain a chevron mid-load', async () =>
      (await itemFor('TestMod.esp')).collapsibleState === vscode.TreeItemCollapsibleState.Collapsed);

    // What makes it progressive rather than merely early: a plugin the load has not reached stays a
    // leaf. A row that expanded here would fetch records for a plugin that is not queryable yet.
    assert.strictEqual(
      (await itemFor('Other.esp')).collapsibleState, vscode.TreeItemCollapsibleState.None,
      'Other.esp has not been indexed yet and must not be expandable',
    );

    setIndexed(['TestMod.esp', 'Other.esp']);
    await waitFor('Other.esp to gain a chevron once it lands', async () =>
      (await itemFor('Other.esp')).collapsibleState === vscode.TreeItemCollapsibleState.Collapsed);

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

  // Closing mEdit mid-load is a deliberate abandonment, not a failure: the notification stream
  // closes, chevrons and message go, and nothing is reported broken. The "no error toast" half
  // is asserted at the LoadOrderController seam, where the reporter is injectable.
  it('closes the notification stream and clears the view when mEdit is closed mid-load', async () => {
    setIndexed(['TestMod.esp']);
    const launch = enterEditing();
    await waitFor('the load to be under way, subscribed and rendering', async () =>
      (await itemFor('TestMod.esp')).collapsibleState === vscode.TreeItemCollapsibleState.Collapsed);
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
    assert.strictEqual(
      (await itemFor('TestMod.esp')).collapsibleState, vscode.TreeItemCollapsibleState.None,
      'the chevrons must go with the load order',
    );
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

    await waitFor('MissingMaster.esp to gain a chevron mid-load', async () =>
      (await itemFor('MissingMaster.esp')).collapsibleState === vscode.TreeItemCollapsibleState.Collapsed);
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
    // Immutable.esm never appears in a progress tick's indexedPlugins, so its chevron can only come
    // from the completion hand-off's file set, which a hand-off applying only readOnly would drop.
    assert.strictEqual(
      immutable.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed,
      'Immutable.esm was indexed but never named in a progress tick — its chevron must still come from the completion hand-off',
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
