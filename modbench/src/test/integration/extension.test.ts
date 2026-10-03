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
import { PLUGINS_KEY_ARGS } from '../../plugins/gestureEntry';

const PLUGIN_LIST_DND_MIME = 'application/vnd.medit.pluginlist-node';
const TEST_PORT = Number(present(process.env.MODBENCH_TEST_PORT, 'the port .vscode-test.mjs hands the run'));
let mockBackend: http.Server;
let ext: vscode.Extension<ActivateExports> | undefined;

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
async function writeAndAwaitInstance(write: () => void): Promise<void> {
  const instance = instanceExport();
  const before = instance?.sequence ?? 0;
  write();
  if (instance) await pastSequence(instance, before);
}

async function setGameDirectory(dir: string | undefined): Promise<void> {
  const instance = instanceExport();
  const before = instance?.sequence ?? 0;
  await vscode.workspace.getConfiguration('modbench').update(
    'mods.gameDirectory', dir, vscode.ConfigurationTarget.Workspace);
  if (instance) await pastSequence(instance, before);
}

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

type MockPlugin = PluginMetadata;
function mockPlugin(over: Partial<PluginMetadata> & Pick<PluginMetadata, 'name' | 'path' | 'origin' | 'inLoadOrder'>): MockPlugin {
  return {
    isLight: false, isMaster: false, isBlueprint: false, masters: [], recordCount: 0, isImmutable: false,
    masterIssues: [], hasMatchingRecords: true,
    isTracked: false,
    hasParseFailure: false,
    ...over,
  };
}
const MOCK_PLUGINS: MockPlugin[] = [
  mockPlugin({ name: 'Fallout4.esm', path: '/data/Fallout4.esm', origin: 'Data', inLoadOrder: true }),
  mockPlugin({ name: 'TestMod.esp', path: '/data/TestMod.esp', origin: 'Data', inLoadOrder: true }),
  mockPlugin({ name: 'Other.esp', path: '/data/Other.esp', origin: 'Data', inLoadOrder: false }),
  mockPlugin({ name: 'Immutable.esm', path: '/data/Immutable.esm', origin: 'Data', inLoadOrder: true, isImmutable: true }),
  mockPlugin({
    name: 'MissingMaster.esp', path: '/data/MissingMaster.esp', origin: 'Data', inLoadOrder: true,
    masterIssues: ['Ghost.esm'],
  }),
];
const MOCK_RECORD_TYPES = [{ type: 'weap', count: 3, displayName: 'Weapon' }];
let loadOrderHeld = false;
const requestLog: string[] = [];
const putLoadOrders: string[][] = [];
const recordEdits: { formKey: string; body: unknown }[] = [];

function pluginNamesOf(body: string): string[] {
  const parsed: unknown = JSON.parse(body);
  const plugins = typeof parsed === 'object' && parsed !== null && 'plugins' in parsed ? parsed.plugins : undefined;
  if (!Array.isArray(plugins)) throw new Error(`expected a PUT /load-order body with a plugins array, got: ${body}`);
  return plugins.map((p: unknown) => (typeof p === 'object' && p !== null && 'name' in p ? String(p.name) : '?'));
}
let mockPluginsOverride: MockPlugin[] | null = null;
let putLoadOrderShouldFail = false;
let rebuildIndexShouldFail = false;
const RAW_INDEX_LOCKED_DETAIL = 'raw backend detail: index lock held by pid 4242';
let getPluginsShouldFail = false;
type MockLoadOrderStatus = {
  state: 'None' | 'Reconciling' | 'Ready' | 'HeldElsewhere' | 'Failed';
  totalPlugins: number;
  activePlugins: number;
  indexedPlugins: { name: string; origin: string }[];
  conflictsComputed: boolean;
  failures: { name: string; origin: string; reason: string }[];
  version: number;
  message?: string;
};
const NO_LOAD_ORDER_STATUS: MockLoadOrderStatus =
  { state: 'None', totalPlugins: 0, activePlugins: 0, indexedPlugins: [], conflictsComputed: false, failures: [], version: 0 };
let loadOrderStatus: MockLoadOrderStatus = { ...NO_LOAD_ORDER_STATUS };
let loadOrderVersion = 0;
let releasePutLoadOrder: (() => void) | null = null;
let holdPutLoadOrder = false;
function releasePut(): void {
  if (!releasePutLoadOrder) throw new Error('expected PUT /load-order to be held (holdPutLoadOrder must be set) before releasing it');
  releasePutLoadOrder();
}
let releaseHealth: (() => void) | null = null;
let holdHealth = false;

const sseClients: http.ServerResponse[] = [];

function writeSseFrame(res: http.ServerResponse, kind: string, payload: Record<string, unknown>): void {
  const data = JSON.stringify({ kind, plugin: '', origin: '', keys: [], sequence: 0, ...payload });
  res.write(`event: ${kind}\ndata: ${data}\n\n`);
}

function pushLoadOrderStatus(): void {
  for (const res of sseClients) writeSseFrame(res, 'load-order-status', { loadOrderStatus });
}

async function resetMockBackendDetached(): Promise<void> {
  const client = ext?.exports.client;
  if (client?.status === 'running') {
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

function setIndexed(names: string[], extra: Partial<MockLoadOrderStatus> = {}): void {
  loadOrderStatus = {
    state: 'Reconciling',
    totalPlugins: Math.max(names.length, loadOrderStatus.totalPlugins),
    activePlugins: Math.max(names.length, loadOrderStatus.activePlugins),
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
      holdHealth = false;
      releaseHealth = () => { releaseHealth = null; answer(); };
      return;
    }
    if (method === 'POST' && url === '/index/rebuild') {
      req.on('data', () => {});
      req.on('end', () => {
        if (rebuildIndexShouldFail) {
          res.writeHead(423, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ detail: RAW_INDEX_LOCKED_DETAIL }));
          return;
        }
        res.writeHead(204);
        res.end();
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
        if (putLoadOrderShouldFail) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'simulated load failure' }));
          return;
        }
        loadOrderVersion += 1;
        const version = loadOrderVersion;
        loadOrderStatus = { ...loadOrderStatus, version };
        pushLoadOrderStatus();

        const answer = () => {
          loadOrderHeld = true;
          loadOrderStatus = { ...loadOrderStatus, state: 'Ready', conflictsComputed: true, version };
          pushLoadOrderStatus();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ applied: true, version }));
        };
        if (!holdPutLoadOrder) return answer();
        holdPutLoadOrder = false;
        pushLoadOrderStatus();
        releasePutLoadOrder = () => { releasePutLoadOrder = null; answer(); };
      });
      return;
    }
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
    if (/^\/plugins\/[^/?]+\/record-types(\?|$)/.test(url)) {
      res.writeHead(loadOrderHeld ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(loadOrderHeld ? JSON.stringify(MOCK_RECORD_TYPES) : 'No load order has been received.');
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

before(async function () {
  this.timeout(15000);

  mockBackend = createMockBackend();
  await new Promise<void>(r => mockBackend.listen(TEST_PORT, '127.0.0.1', () => r()));

  ext = vscode.extensions.all.find(e => isRecord(e.packageJSON) && e.packageJSON.name === 'modbench');
  const deadline = Date.now() + 5000;
  while (ext && !ext.isActive && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
  }

  const client = ext?.exports.client;
  if (client) await awaitStatus(client, 'running', 'the client to reach running');
});

after(async () => {
  mockBackend.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    mockBackend.close(err => (err ? reject(err) : resolve()))
  );
});

describe('modbench activation', () => {
  it('answers the instance check for an instance folder: instance', () => {
    assert.strictEqual(ext?.exports.folder, 'instance');
  });

  it('marks the first read once the Instance lands a value', async () => {
    await pastSequence(present(instanceExport(), 'the Instance export'), 0);
    assert.strictEqual(ext?.exports.instanceRead(), true);
  });
});

describe('Modbench output channel', () => {
  it('is created as a leveled LogOutputChannel, not a plain text channel', () => {
    const channel = ext?.exports.outputChannel;
    assert.ok(channel, 'activate() should return { outputChannel }');
    assert.strictEqual(typeof channel.debug, 'function', 'expected a .debug() method');
    assert.strictEqual(typeof channel.info, 'function', 'expected an .info() method');
    assert.strictEqual(typeof channel.warn, 'function', 'expected a .warn() method');
    assert.strictEqual(typeof channel.error, 'function', 'expected an .error() method');
    assert.ok('logLevel' in channel, "expected VS Code's native level filter to apply (logLevel)");
  });
});

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
  const pkg = commandsManifest(JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
  ));
  const EXPECTED_COMMANDS = pkg.contributes.commands.map((c) => c.command);

  it('registers all expected commands on activation', async () => {
    assert.ok(EXPECTED_COMMANDS.length > 0, 'derived command list is empty — the manifest shape changed');
    const all = await vscode.commands.getCommands(true);
    for (const cmd of EXPECTED_COMMANDS) {
      assert.ok(all.includes(cmd), `Command not registered: ${cmd}`);
    }
  });
});

describe('modbench.mod.sync syncs the instance value it is handed', () => {
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

const openTabs = () => vscode.window.tabGroups.all.flatMap(g => g.tabs);

async function checkBoxTogglesMarkedByTheNextTurn(
  rows: { markUnconfirmed(row: never, enabled: boolean): void }, command: string,
): Promise<number> {
  let toggles = 0;
  const mark = rows.markUnconfirmed.bind(rows);
  rows.markUnconfirmed = (row, enabled) => {
    toggles++;
    mark(row, enabled);
  };
  try {
    await vscode.commands.executeCommand(command);
    await new Promise((turn) => setImmediate(turn));
  } finally {
    rows.markUnconfirmed = mark;
  }
  return toggles;
}

describe('modbench.record.open', () => {
  const titled = (title: string) => openTabs().some(t => t.label === title);

  it('opens a tab titled by the FormKey', async () => {
    await vscode.commands.executeCommand('modbench.record.open', { formKey: 'Fallout4.esm:000001' });

    await waitFor('a tab titled by the FormKey', () => titled('Fallout4.esm:000001') || undefined);
  });

  it('a second click replaces the preview tab instead of adding one', async () => {
    const tabsBefore = openTabs().length;

    await vscode.commands.executeCommand('modbench.record.open', { formKey: 'Fallout4.esm:000002' });
    await waitFor('the second record\'s tab', () => titled('Fallout4.esm:000002') || undefined);

    assert.strictEqual(openTabs().length, tabsBefore, 'the next click replaces the preview editor');
    assert.ok(!titled('Fallout4.esm:000001'), 'the first record\'s preview tab is gone');
  });

  it('shows a record already open in a tab of its own, and does not open it twice', async () => {
    await vscode.commands.executeCommand('modbench.record.open', { formKey: 'Fallout4.esm:000010', placement: 'beside' });
    await waitFor('the pinned tab', () => titled('Fallout4.esm:000010') || undefined);
    const tabsBefore = openTabs().length;

    await vscode.commands.executeCommand('modbench.record.open', { formKey: 'Fallout4.esm:000010', placement: 'beside' });

    assert.strictEqual(openTabs().length, tabsBefore);
  });

  it('opens several records at once, each in a tab of its own', async () => {
    const tabsBefore = openTabs().length;

    await vscode.commands.executeCommand('modbench.record.open', [
      { formKey: 'Fallout4.esm:000011' }, { formKey: 'Fallout4.esm:000012' },
    ]);
    await waitFor('both tabs', () => (titled('Fallout4.esm:000011') && titled('Fallout4.esm:000012')) || undefined);

    assert.strictEqual(openTabs().length, tabsBefore + 2);
  });

  it('opens beside as a genuinely new tab, leaving the tab it was fired from alone', async () => {
    await vscode.commands.executeCommand('modbench.record.open', { formKey: 'Fallout4.esm:000020', placement: 'beside' });
    await waitFor('the seed tab', () => titled('Fallout4.esm:000020') || undefined);
    const tabsBefore = openTabs().length;

    await vscode.commands.executeCommand('modbench.record.open', { formKey: 'Fallout4.esm:000021', placement: 'beside' });
    await waitFor('the beside tab', () => titled('Fallout4.esm:000021') || undefined);

    assert.strictEqual(openTabs().length, tabsBefore + 1);
    assert.ok(titled('Fallout4.esm:000020'), 'the seed tab is untouched');
  });

  it('reads a Plugins-tree RecordNode-shaped row from a menu to its own record', async () => {
    const row = { kind: 'record', record: { formKey: 'Fallout4.esm:000030' }, origin: 'Data' };

    await vscode.commands.executeCommand('modbench.record.openToSide', row, [row]);

    await waitFor('the RecordNode\'s tab', () => titled('Fallout4.esm:000030') || undefined);
  });

  it('reads a Plugins-tree ChildRecordNode-shaped row from a menu to its own record', async () => {
    const row = { kind: 'placed', formKey: 'Fallout4.esm:000040', origin: 'Data' };

    await vscode.commands.executeCommand('modbench.record.openToSide', row, [row]);

    await waitFor('the ChildRecordNode\'s tab', () => titled('Fallout4.esm:000040') || undefined);
  });

  it('a menu\'s multi-selection opens one tab per record, all in a single new group beside the active one', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllGroups');
    const selection = [
      { formKey: 'Fallout4.esm:000060' }, { formKey: 'Fallout4.esm:000061' }, { formKey: 'Fallout4.esm:000062' },
    ];

    await vscode.commands.executeCommand('modbench.record.openToSide', selection[0], selection);
    await waitFor('every selected tab', () => selection.every((s) => titled(s.formKey)) || undefined);

    const tabsByGroup = vscode.window.tabGroups.all.map((g) => g.tabs.map((t) => t.label));
    assert.deepStrictEqual(tabsByGroup, [[], selection.map((s) => s.formKey)]);
  });
});

import { PluginNode as PluginListPluginNode, ImplicitMasterNode } from '../../plugins/PluginsTreeProvider';
import { ImplicitMasterDecorationProvider } from '../../plugins/ImplicitMasterDecorationProvider';
import { publishPluginWarnings } from '../../medit/loadDiagnostics';
function nodeKind(node: unknown): unknown {
  const fields: { kind?: unknown } = typeof node === 'object' && node !== null ? node : {};
  return fields.kind;
}

async function clickRow(node: { command?: vscode.Command }): Promise<void> {
  const { command, arguments: args } = present(node.command, 'the row\'s command');
  const given: unknown[] = args ?? [];
  await vscode.commands.executeCommand(command, ...given);
}

describe('a click on a plugin row opens its header', () => {
  it('from an ordinary plugin row, titled by the plugin\'s file name', async () => {
    await clickRow(new PluginListPluginNode({ name: 'TestMod.esp', enabled: true }, 'SomeMod'));

    await waitFor('a header tab for TestMod.esp', () => openTabs().some(t => t.label === 'TestMod.esp') || undefined);
  });

  it('from an implicit-master row', async () => {
    await clickRow(new ImplicitMasterNode('Fallout4.esm', 'Data'));

    await waitFor('a header tab for Fallout4.esm', () => openTabs().some(t => t.label === 'Fallout4.esm') || undefined);
  });

  it('opens two plugins of one file name from different origins as two tabs', async () => {
    const tabsBefore = openTabs().length;

    await vscode.commands.executeCommand('modbench.record.open', [
      { formKey: '000000:Twin.esp', origin: 'ModA' }, { formKey: '000000:Twin.esp', origin: 'ModB' },
    ]);
    await waitFor('both Twin.esp tabs', () => openTabs().filter(t => t.label === 'Twin.esp').length === 2 || undefined);

    assert.strictEqual(openTabs().length, tabsBefore + 2);
  });
});

describe('the locked row is greyed and carries no Problems badge', () => {
  const dataFolder = path.join(os.tmpdir(), 'locked-row-game', 'Data');
  const node = new ImplicitMasterNode('Fallout4.esm', 'Data', path.join(dataFolder, 'Fallout4.esm'));
  const collection = vscode.languages.createDiagnosticCollection('locked-row-test');
  after(() => collection.dispose());

  it('holds none of the diagnostics published on its plugin file', () => {
    publishPluginWarnings(collection, () => dataFolder, [{ plugin: 'Fallout4.esm', origin: 'Data', text: 'malformed' }]);

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

const archiveNameOf = (row: DownloadsTreeNode): string | undefined =>
  row instanceof DownloadNode ? row.row.name : undefined;

describe('modbench.downloads tree', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const downloadsDir = root ? path.join(root, 'downloads') : '';
  const provider = () => present(ext?.exports.downloadsProvider, "the activated extension's downloadsProvider export");
  const instance = () => present(instanceExport(), 'the Instance activate() exports');
  const iniPath = root ? path.join(root, 'ModOrganizer.ini') : '';

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

  after(() => {
    if (!root) return;
    fs.rmSync(downloadsDir, { recursive: true, force: true });
  });

  it('renders one row per archive, .meta sidecars suppressed', async () => {
    await writeAndAwaitInstance(() => {
      fs.mkdirSync(downloadsDir, { recursive: true });
      fs.writeFileSync(path.join(downloadsDir, 'foo.zip'), 'data');
      fs.writeFileSync(path.join(downloadsDir, 'foo.zip.meta'), '[General]\r\n');
    });

    const rows = await waitFor('the downloads rows to hold foo.zip', async () => {
      const found = await provider().getChildren();
      return found.some((r) => archiveNameOf(r) === 'foo.zip') ? found : undefined;
    });
    assert.deepStrictEqual(rows.map((r) => archiveNameOf(r)), ['foo.zip']);
  });

  it('reflects a new archive dropped into downloads/ via the file-watcher, with no manual refresh', async () => {
    await probeUntilListed(downloadsDir, 'dropped');
  });

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

describe('Overwrite row', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const overwriteDir = root ? path.join(root, 'overwrite') : '';
  const provider = () => present(ext?.exports.modListProvider, "the activated extension's modListProvider export");

  after(() => {
    if (!root) return;
    fs.rmSync(overwriteDir, { recursive: true, force: true });
  });

  it('shows a pinned Overwrite row (last, outside grouping) when overwrite/ is non-empty', async () => {
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

const xdgTrash = path.join(present(process.env.XDG_DATA_HOME, 'the data directory .vscode-test.mjs hands the run'), 'Trash');
const trashInfoDir = path.join(xdgTrash, 'info');
const TRASH_INFO = '.trashinfo';

function trashInfoNames(): ReadonlySet<string> {
  return new Set(fs.existsSync(trashInfoDir) ? fs.readdirSync(trashInfoDir) : []);
}

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

  it('delete separator asks the Instance and the view for no refresh, and its row goes when the watch lands the new value', async function () {
    if (!root) this.skip();
    const doomed = present(await separatorRow('Doomed'), 'the Doomed separator row');
    let unexplainedInvalidates = 0;
    let instanceRefreshes = 0;
    let sequenceAtLastInvalidate = instance().sequence;
    const view = provider();
    const invalidate = view.invalidate.bind(view);
    view.invalidate = () => {
      if (instance().sequence === sequenceAtLastInvalidate) unexplainedInvalidates++;
      sequenceAtLastInvalidate = instance().sequence;
      invalidate();
    };
    const target = instance();
    const refresh = target.refresh.bind(target);
    target.refresh = () => {
      instanceRefreshes++;
      return refresh();
    };

    const warn = vscode.window.showWarningMessage;
    (vscode.window as { showWarningMessage: unknown }).showWarningMessage = () => Promise.resolve('Delete');
    try {
      await vscode.commands.executeCommand('modbench.separator.delete', doomed);

      assert.ok(!fs.readFileSync(modlistPath, 'utf8').includes('Doomed'), 'the delete should have written modlist.txt');
      assert.ok(!fs.existsSync(doomedDir), 'the delete should have taken the separator\'s folder from mods/');
      if (process.platform === 'linux') {
        assert.strictEqual(takeFromTrash(doomedDir, trashedBefore), 1, 'the separator\'s folder should be in the OS trash');
      }
      await waitFor('the watch to take the Doomed row away', async () => (await separatorRow('Doomed')) === undefined);
      assert.strictEqual(instanceRefreshes, 0, 'the gesture asked the Instance to re-read');
      assert.strictEqual(unexplainedInvalidates, 0, 'the gesture asked the view to re-pull a value no watch landed');
    } finally {
      target.refresh = refresh;
      (vscode.window as { showWarningMessage: unknown }).showWarningMessage = warn;
      view.invalidate = invalidate;
    }
  });
});

describe('The Mods tree\'s expansion, as VS Code renders it', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const modlistPath = root ? path.join(root, 'profiles', 'Default', 'modlist.txt') : '';
  const modDirs = root ? ['Armor Pack', 'Weapons', 'Late Armor'].map((name) => path.join(root, 'mods', name)) : [];
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
  const expandsAfter = async (change: () => unknown): Promise<void> => {
    asked = [];
    await change();
    await waitFor('the re-rendered view to ask for the separator\'s children', () => {
      const rendered = asked.indexOf('root');
      return rendered >= 0 && asked.indexOf('separator:Gear', rendered) > rendered;
    });
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
    await expandsAfter(() => provider().setFilter('armor', true));
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
    await expandsAfter(() => writeAndAwaitInstance(() => {
      fs.writeFileSync(modlistPath, '+Armor Pack\r\n+Late Armor\r\n+Weapons\r\n-Gear_separator\r\n');
    }));
  });

  it('expands a separator the user collapsed, while a filter shows it for its matching mods', async function () {
    if (!root) this.skip();
    await onTheSeparator('list.collapse');
    await renderAfter(() => provider().setFilter('', true));
    assert.ok(!gearExpanded(), `the collapse did not land: ${JSON.stringify(asked)}`);

    await expandsAfter(() => provider().setFilter('weap', true));
  });
});

describe('The Mods view\'s palette entries and Space, as VS Code runs them', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const modlistPath = root ? path.join(root, 'profiles', 'Default', 'modlist.txt') : '';
  const modDir = root ? path.join(root, 'mods', 'Palette Mod') : '';
  let original = '';

  const enabledAndSelected = async () => {
    await writeAndAwaitInstance(() => fs.writeFileSync(modlistPath, '+Palette Mod\r\n'));
    await waitFor('the mod row to be focused and selected', async () => {
      await vscode.env.clipboard.writeText('');
      await vscode.commands.executeCommand('modbench.modList.focus');
      await vscode.commands.executeCommand('list.focusFirst');
      await vscode.commands.executeCommand('list.select');
      await vscode.commands.executeCommand('modbench.copyValue', MODS_KEY_ARGS);
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
    const mods = present(ext?.exports.modListProvider, "the activated extension's modListProvider export");
    assert.strictEqual(await checkBoxTogglesMarkedByTheNextTurn(mods, 'list.toggleExpand'), 0);
  });

  it('copies the selection of the view last selected in when Copy Value is run from the palette', async function () {
    if (!root) this.skip();
    this.timeout(30_000);
    await enabledAndSelected();
    await vscode.env.clipboard.writeText('');
    await waitFor('the palette\'s copy value to reach the clipboard', async () => {
      await vscode.commands.executeCommand('workbench.action.quickOpen', '>Modbench: Copy Value');
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      return (await vscode.env.clipboard.readText()) === 'Palette Mod';
    });
  });

  it('offers Disable Mod in the palette while the Mods view has focus, acting on its selection', async function () {
    if (!root) this.skip();
    this.timeout(30_000);
    await enabledAndSelected();
    await waitFor('the palette\'s disable to land in the Instance', async () => {
      await vscode.commands.executeCommand('workbench.action.quickOpen', '>Modbench: Disable Mod');
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      return instanceExport()?.value.mods.some((m) => m.name === 'Palette Mod' && !m.enabled);
    });
  });
});

describe('The Plugins view\'s keys, as VS Code runs them', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const pluginsTxtPath = root ? path.join(root, 'profiles', 'Default', 'plugins.txt') : '';
  let gameDir = '';
  let original = '';

  const focusRow = async (index: number) => {
    await writeAndAwaitInstance(() => fs.writeFileSync(pluginsTxtPath, '*TestMod.esp\r\nOther.esp\r\n'));
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitFor('the plugin row to be focused and selected', async () => {
      await vscode.env.clipboard.writeText('');
      await vscode.commands.executeCommand('modbench.pluginListTree.focus');
      await vscode.commands.executeCommand('workbench.actions.treeView.modbench.pluginListTree.collapseAll');
      await vscode.commands.executeCommand('list.focusFirst');
      for (let i = 0; i < index; i++) await vscode.commands.executeCommand('list.focusDown');
      await vscode.commands.executeCommand('list.selectAndPreserveFocus');
      await vscode.commands.executeCommand('modbench.copyValue', PLUGINS_KEY_ARGS);
      return (await vscode.env.clipboard.readText()) === ['TestMod.esp', 'Other.esp'][index];
    });
  };

  before(async () => {
    if (!root) return;
    resetMockBackend();
    original = fs.readFileSync(pluginsTxtPath, 'utf8');
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-keys-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
    for (const name of ['TestMod.esp', 'Other.esp']) fs.writeFileSync(path.join(gameDir, 'Data', name), '');
    await setGameDirectory(gameDir);
    await enterEditing();
    exitEditing();
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (!root) return;
    await setGameDirectory(undefined);
    await writeAndAwaitInstance(() => fs.writeFileSync(pluginsTxtPath, original));
    fs.rmSync(gameDir, { recursive: true, force: true });
  });

  it('VS Code\'s own Space on a focused plugin row leaves its check box alone', async function () {
    if (!root) this.skip();
    await focusRow(0);
    const plugins = present(ext?.exports.pluginsTree, "the activated extension's pluginsTree export");
    assert.strictEqual(await checkBoxTogglesMarkedByTheNextTurn(plugins, 'list.toggleExpand'), 0);
  });

  it('Space disables the selected plugin', async function () {
    if (!root) this.skip();
    await focusRow(0);
    await vscode.commands.executeCommand('modbench.plugin.disable');
    await waitFor('the disable to land in the Instance', () =>
      instanceExport()?.value.plugins.some((p) => p.name === 'TestMod.esp' && !p.enabled));
  });

  it('VS Code\'s own Enter on an enabled plugin row opens its header, as a click does', async function () {
    if (!root) this.skip();
    await focusRow(0);
    await vscode.commands.executeCommand('list.select');
    await waitFor('a header tab for TestMod.esp', () => openTabs().some((t) => t.label === 'TestMod.esp') || undefined);
  });

  it('VS Code\'s own Enter on a disabled plugin row only selects it', async function () {
    if (!root) this.skip();
    await focusRow(1);
    await vscode.commands.executeCommand('list.select');
    await new Promise((r) => setTimeout(r, 750));
    assert.deepStrictEqual(openTabs().map((t) => t.label), []);
  });
});

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

  it('connects once the backend is healthy and does not reconnect once editing ends', async function () {
    if (!root) this.skip();
    this.timeout(20000);

    await enterEditing();
    await waitFor('the notification stream to connect', () => streamRequests(requestLog).length > 0);
    assert.strictEqual(streamRequests(requestLog).length, 1, 'expected exactly one connection for the launch');

    exitEditing();
    const client = ext?.exports.client;
    if (client) await awaitStatus(client, 'stopped', 'the client to reach stopped');
    assert.strictEqual(streamRequests(requestLog).length, 1,
      'expected no reconnect once editing ends');
  });
});

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

  it('lands a value resolving the directory the setting names, with no file of the instance touched', async () => {
    await setGameDirectory(gameDir);

    const instance = present(instanceExport(), 'the Instance activate() exports');
    assert.deepStrictEqual(instance.value.gameFolder, { kind: 'found', root: gameDir, dataFolder: path.join(gameDir, 'Data') });
  });
});

describe('Launch mEdit populates the editing plugin tree', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  let gameDir = '';

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
    exitEditing();
    await setGameDirectory(undefined);
    await writeAndAwaitInstance(() => fs.writeFileSync(path.join(root, 'profiles', 'Default', 'plugins.txt'), ''));
    fs.rmSync(gameDir, { recursive: true, force: true });
  });

  it('loads the load order and shows plugins (not an empty tree) after launch', async () => {
    await enterEditing();
    const duringLaunch = [...requestLog];

    const load = duringLaunch.indexOf('PUT /load-order');
    assert.ok(load >= 0, 'launch should PUT /load-order');
    const prematurePlugins = duringLaunch.slice(0, load).includes('GET /plugins');
    assert.ok(!prematurePlugins, 'GET /plugins must not fire before PUT /load-order');

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
    for (const name of ['TestMod.esp', 'Other.esp']) fs.writeFileSync(path.join(gameDir, 'Data', name), '');
    await setGameDirectory(gameDir);
    await writeAndAwaitInstance(() => fs.writeFileSync(pluginsTxtPath, '*TestMod.esp\n*Other.esp\n'));
    await waitFor('the plugin rows to hold both written plugins', async () => {
      const names = (await pluginListProvider().getChildren()).map((n) => rowName(n));
      return (names.includes('TestMod.esp') && names.includes('Other.esp')) || undefined;
    });
  });

  after(async () => {
    if (!root) return;
    await setGameDirectory(undefined);
    await writeAndAwaitInstance(() => fs.writeFileSync(pluginsTxtPath, ''));
    fs.rmSync(gameDir, { recursive: true, force: true });
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
    provider.setFilter('');
    await enterEditing();

    const other = findRow(await provider.getChildren(), 'Other.esp');
    await vscode.commands.executeCommand('modbench.plugin.disable', other);

    const written = fs.readFileSync(pluginsTxtPath, 'utf8');
    assert.ok(written.includes('Other.esp'), 'plugins.txt should still list Other.esp, just disabled');
    assert.ok(!written.includes('*Other.esp'), 'disabling a plugin while the backend runs should still write plugins.txt');

    exitEditing();
  });

  it('still writes plugins.txt when a plugin is dragged past the last row while the backend is running (AC4)', async () => {
    const provider = pluginListProvider();
    provider.setFilter('');
    fs.writeFileSync(pluginsTxtPath, '*TestMod.esp\n*Other.esp\n');
    provider.invalidate();
    await provider.getChildren();

    await enterEditing();

    const dataTransfer = new vscode.DataTransfer();
    dataTransfer.set(PLUGIN_LIST_DND_MIME, new vscode.DataTransferItem({ plugins: [{ name: 'TestMod.esp', origin: 'Data' }] }));
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

function describeTooltip(tooltip: vscode.TreeItem['tooltip']): string {
  return typeof tooltip === 'string' ? tooltip : JSON.stringify(tooltip);
}

describe('Plugin sync takes the instance value', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const pluginsTxtPath = root ? path.join(root, 'profiles', 'Default', 'plugins.txt') : '';
  let gameDir = '';

  before(async () => {
    if (!root) return;
    await resetMockBackendDetached();
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-game-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
    fs.writeFileSync(path.join(gameDir, 'Data', 'TestMod.esp'), '');
    await setGameDirectory(gameDir);
  });

  after(async () => {
    if (!root) return;
    await setGameDirectory(undefined);
    await writeAndAwaitInstance(() => fs.writeFileSync(pluginsTxtPath, ''));
    fs.rmSync(gameDir, { recursive: true, force: true });
  });

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

  it('renders the game\'s master the game folder holds, ahead of the plugins.txt rows', async () => {
    const tree = pluginsTree();
    const master = path.join(gameDir, 'Data', 'Fallout4.esm');
    try {
      await writeAndAwaitInstance(() => fs.writeFileSync(master, ''));
      const rows = await tree.getChildren();

      assert.strictEqual(rowName(rows[0]), 'Fallout4.esm', 'the game\'s master leads the rows');
      assert.strictEqual(tree.getTreeItem(present(rows[0], 'the first row')).contextValue, 'pluginImplicit');
    } finally {
      await writeAndAwaitInstance(() => fs.rmSync(master));
    }
  });

  it('renders no implicit row when the game folder holds none of the game\'s masters', async () => {
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

  it('a disabled plugin row has no expander', async () => {
    const tree = pluginsTree();
    const other = findRow(await tree.getChildren(), 'Other.esp');

    assert.strictEqual(tree.getTreeItem(other).collapsibleState, vscode.TreeItemCollapsibleState.None);
  });

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

    assert.ok(typeof item.tooltip === 'string' && item.tooltip.includes('Missing masters: Ghost.esm'),
      `expected a missing-master tooltip, got: ${describeTooltip(item.tooltip)}`);
    assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    assert.strictEqual(rowFields(row).plugin?.enabled, true);
    assert.strictEqual(item.checkboxState, vscode.TreeItemCheckboxState.Checked);
  });

  it('leaves a plugin whose masters all resolve undecorated', async () => {
    const tree = pluginsTree();
    const row = findRow(await tree.getChildren(), 'TestMod.esp');

    const item = tree.getTreeItem(row);

    assert.strictEqual(item.tooltip, 'TestMod.esp\nData');
  });

});

describe('An instance change sends a fresh load order snapshot (ADR-0013)', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const pluginsTxtPath = root ? path.join(root, 'profiles', 'Default', 'plugins.txt') : '';
  const pluginsTree = () => present(ext?.exports.pluginsTree, "the activated extension's pluginsTree export");
  let gameDir = '';
  let swapped = false;
  const putCount = () => requestLog.filter((l) => l === 'PUT /load-order').length;

  async function swapPluginOrder(): Promise<void> {
    swapped = !swapped;
    await writePluginsTxt(swapped ? '*MissingMaster.esp\n*TestMod.esp\n' : '*TestMod.esp\n*MissingMaster.esp\n');
  }

  async function writePluginsTxt(text: string): Promise<void> {
    const before = putCount();
    const pluginReads = requestLog.filter((l) => l === 'GET /plugins').length;
    fs.writeFileSync(pluginsTxtPath, text);
    await waitFor('a fresh PUT /load-order after plugins.txt changed', () => putCount() > before ? true : undefined);
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

    await swapPluginOrder();

    assert.ok(putCount() >= before + 1, 'a plugins.txt change must send a fresh snapshot, not merely re-render the tree');
  });

  it('a plugins.txt write that leaves the load order equal puts it again', async () => {
    const sent = putLoadOrders.length;
    const order = swapped ? ['MissingMaster.esp', 'TestMod.esp'] : ['TestMod.esp', 'MissingMaster.esp'];

    await writePluginsTxt(`${fs.readFileSync(pluginsTxtPath, 'utf8')}\n`);

    assert.deepStrictEqual(putLoadOrders.slice(sent), [order]);
  });

  it('clears a resolved master-issue decoration on the same row after the next reconcile, not just applies it', async () => {
    const tree = pluginsTree();
    const before = findRow(await tree.getChildren(), 'MissingMaster.esp');
    const beforeTooltip = tree.getTreeItem(before).tooltip;
    assert.ok(typeof beforeTooltip === 'string' && beforeTooltip.includes('Missing masters: Ghost.esm'),
      `expected the row to carry the master-issue tooltip before the reconcile, got: ${describeTooltip(beforeTooltip)}`);

    mockPluginsOverride = MOCK_PLUGINS.map((p) => p.name === 'MissingMaster.esp' ? { ...p, masterIssues: [] } : p);
    await swapPluginOrder();

    await waitFor('a resolved master issue to clear the tooltip, not leave the stale decoration stacked on top of the fresh one',
      async () => tree.getTreeItem(findRow(await tree.getChildren(), 'MissingMaster.esp')).tooltip === 'MissingMaster.esp\nData');
  });

  it('hides a plugin a filter suppresses, and restores it once a reconcile comes up with no filter', async () => {
    const tree = pluginsTree();
    const before = findRow(await tree.getChildren(), 'TestMod.esp');
    assert.strictEqual(tree.getTreeItem(before).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed,
      'sanity: the row is expandable before either reconcile below');

    mockPluginsOverride = MOCK_PLUGINS.map((p) => p.name === 'TestMod.esp' ? { ...p, hasMatchingRecords: false } : p);
    await swapPluginOrder();
    await waitFor('sanity: the mechanism reaches the tree — a filter with no matches on this plugin hides its row entirely, not just its chevron',
      async () => !(await tree.getChildren()).some((r) => rowName(r) === 'TestMod.esp'));

    mockPluginsOverride = null;
    await swapPluginOrder();
    await waitFor('a reconcile that comes up with no filter to restore a row an earlier filter hid, not leave it permanently gone',
      async () => {
        const restored = (await tree.getChildren()).find((r) => rowName(r) === 'TestMod.esp');
        return restored !== undefined && tree.getTreeItem(restored).collapsibleState === vscode.TreeItemCollapsibleState.Collapsed;
      });
  });

  it('keeps the rows expandable, without throwing, when the reconcile itself fails', async () => {
    const tree = pluginsTree();
    const before = findRow(await tree.getChildren(), 'TestMod.esp');
    assert.strictEqual(tree.getTreeItem(before).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed,
      'sanity: the row is expandable before the failing reconcile');

    putLoadOrderShouldFail = true;
    try {
      await swapPluginOrder();
    } finally {
      putLoadOrderShouldFail = false;
    }

    const after = findRow(await tree.getChildren(), 'TestMod.esp');
    assert.strictEqual(tree.getTreeItem(after).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed,
      'a failed reconcile leaves the load order the backend already holds in place, so the rows stay expandable');
    const children = await tree.getChildren(after);
    assert.strictEqual(children.length, 1, 'expanding after a failed reconcile answers exactly one node');
    assert.strictEqual(nodeKind(children[0]), 'recordType',
      'a failed PUT leaves the held load order behind the chevron, never a row stuck on "still indexing"');
  });
});

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
    await resetMockBackendDetached();
  });

  it('the row a record filter hid stays hidden', async () => {
    const tree = pluginsTree();

    await clientOf()?.stop();

    assert.ok(!(await tree.getChildren()).some((r) => rowName(r) === 'TestMod.esp'),
      'a stopped client is not a reason to un-narrow a view the user narrowed');
  });

  it('a row still in the tree keeps the load order behind its chevron', async () => {
    mockPluginsOverride = null;
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

describe('Refresh rebuilds the index, then re-reads the instance', () => {
  beforeEach(async () => {
    await resetMockBackendDetached();
    await enterEditing();
    requestLog.length = 0;
  });
  after(() => resetMockBackend());

  it('POSTs /index/rebuild, then PUTs the load order the re-read built', async () => {
    await vscode.commands.executeCommand('modbench.instance.refresh');

    const rebuilt = requestLog.indexOf('POST /index/rebuild');
    assert.ok(rebuilt !== -1, 'modbench.instance.refresh must rebuild the index');
    await waitFor('a PUT /load-order after the rebuild',
      () => requestLog.slice(rebuilt).includes('PUT /load-order') ? true : undefined);
  });

  it('reports that another window holds the index, naming this instance', async () => {
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
        `expected the refusal's words, got: ${toast}`,
      );
      assert.ok(root !== undefined && toast?.includes(root), `expected the instance named, got: ${toast}`);
      assert.ok(!toast?.includes(RAW_INDEX_LOCKED_DETAIL), `expected the backend's raw detail kept out of the toast, got: ${toast}`);
    } finally {
      Object.defineProperty(vscode.window, 'showErrorMessage', { configurable: true, value: realShowError });
    }
  });
});

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
    await enterEditing();
    exitEditing();
  });

  after(async () => {
    if (!root) return;
    exitEditing();
    await setGameDirectory(undefined);
    await writeAndAwaitInstance(() => fs.writeFileSync(pluginsTxtPath, ''));
    fs.rmSync(gameDir, { recursive: true, force: true });
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

  const recordTypesAttempted = (name: string) =>
    requestLog.some((l) => l.startsWith(`GET /plugins/${name}/record-types`));
  const stillIndexing = async (name: string) => nodeKind((await childrenFor(name))[0]) === 'indexing';
  const waitForIndexed = (name: string) => waitFor(`the backend to be asked about ${name} once indexed`, async () => {
    await childrenFor(name);
    return recordTypesAttempted(name) ? true : undefined;
  });
  const launchAndAwaitOpeningTick = async (): Promise<{ launch: Promise<void> }> => {
    const launch = enterEditing();
    await waitFor('the load\'s opening tick to reach the tree', () => stillIndexing('TestMod.esp'));
    return { launch };
  };

  it('makes a plugin browsable as soon as it is indexed, while a later one is still indexing', async () => {
    const { launch } = await launchAndAwaitOpeningTick();

    setIndexed(['TestMod.esp']);
    await waitForIndexed('TestMod.esp');

    assert.ok(await stillIndexing('Other.esp'), 'Other.esp has not been indexed yet and must answer "still indexing"');
    assert.ok(!recordTypesAttempted('Other.esp'), 'a plugin the load has not reached must not be asked about at all');

    setIndexed(['TestMod.esp', 'Other.esp']);
    await waitForIndexed('Other.esp');

    releasePut();
    await launch;
  });

  it('decorates a plugin that failed to read the moment it is reported, not at the end', async () => {
    const { launch } = await launchAndAwaitOpeningTick();
    setIndexed(['TestMod.esp'], { failures: [{ name: 'Other.esp', origin: 'Data', reason: 'RACE parse' }] });

    const item = await waitFor('Other.esp to be decorated with its load failure mid-load', async () => {
      const candidate = await itemFor('Other.esp');
      return candidate.description === 'failed to read' ? candidate : undefined;
    });

    assert.ok(typeof item.tooltip === 'string' && item.tooltip.includes('RACE parse'),
      `expected the failure reason in the tooltip, got: ${describeTooltip(item.tooltip)}`);

    releasePut();
    await launch;
  });

  it('closes the notification stream when mEdit is closed mid-load', async () => {
    const { launch } = await launchAndAwaitOpeningTick();
    setIndexed(['TestMod.esp']);
    await waitForIndexed('TestMod.esp');
    const connectionsAtLoad = requestLog.filter((l) => l === 'GET /notifications/stream').length;
    assert.ok(connectionsAtLoad > 0, 'the load should have been subscribed before it was abandoned');

    exitEditing();
    await launch;

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

  it('raises no error when mEdit is closed before the backend is even up', async () => {
    holdHealth = true;
    const errors: string[] = [];
    const realShowError = vscode.window.showErrorMessage;
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

  it('keeps a plugin\'s master-issue tooltip through a reload\'s mid-load tick, unchanged', async () => {
    const { launch } = await launchAndAwaitOpeningTick();

    setIndexed(['TestMod.esp', 'MissingMaster.esp']);
    await waitForIndexed('MissingMaster.esp');
    const midLoad = await itemFor('MissingMaster.esp');
    assert.ok(
      typeof midLoad.tooltip === 'string' && midLoad.tooltip.includes('Missing masters: Ghost.esm'),
      `expected the prior reconcile's tooltip to survive the mid-load tick, got: ${describeTooltip(midLoad.tooltip)}`,
    );

    releasePut();
    await launch;

    const loaded = await itemFor('MissingMaster.esp');
    assert.ok(typeof loaded.tooltip === 'string' && loaded.tooltip.includes('Missing masters: Ghost.esm'),
      `expected the missing-master tooltip once the load completed, got: ${describeTooltip(loaded.tooltip)}`);
    const immutable = await itemFor('Immutable.esm');
    assert.ok(typeof immutable.tooltip === 'string' && immutable.tooltip.includes('read-only'),
      `expected the read-only note once the load completed, got: ${describeTooltip(immutable.tooltip)}`);
    assert.ok(
      !(await stillIndexing('Immutable.esm')),
      'Immutable.esm was indexed but never named in a progress tick — it must still browse once the completion hand-off lands',
    );
  });

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

describe('Copy says why its destination lookup failed', () => {
  const headerArg = {
    webviewSection: 'recordHeader',
    formKey: 'TestMod.esp:000001',
    plugin: 'TestMod.esp',
    origin: 'Data',
    preventDefaultContextMenuItems: true,
  };

  beforeEach(() => resetMockBackend());

  for (const mode of ['Override', 'New']) {
    it(`copy as ${mode} resolves and shows one Modbench error naming the reason`, async () => {
      const errors: string[] = [];
      const realShowError = vscode.window.showErrorMessage;
      const realShowQuickPick = vscode.window.showQuickPick;
      Object.defineProperty(vscode.window, 'showErrorMessage', {
        configurable: true,
        value: (message: string) => { errors.push(message); return Promise.resolve(undefined); },
      });
      Object.defineProperty(vscode.window, 'showQuickPick', {
        configurable: true,
        value: (items: readonly { mode?: string }[]) => Promise.resolve(items.find((item) => item.mode === mode)),
      });
      try {
        await vscode.commands.executeCommand('modbench.record.copy', headerArg);

        assert.ok(requestLog.some((l) => l === 'GET /plugins'), 'the command must have looked up the destinations');
        assert.strictEqual(errors.length, 1, `expected exactly one error toast, got: ${JSON.stringify(errors)}`);
        const [errorToast] = errors;
        if (errorToast === undefined) throw new Error('expected the one error toast just asserted above');
        assert.ok(errorToast.startsWith('Modbench:'), `expected a Modbench-authored toast, got: ${errorToast}`);
        assert.ok(errorToast.includes('No load order has been received.'), `expected the reason, got: ${errorToast}`);
      } finally {
        Object.defineProperty(vscode.window, 'showErrorMessage', { configurable: true, value: realShowError });
        Object.defineProperty(vscode.window, 'showQuickPick', { configurable: true, value: realShowQuickPick });
      }
    });
  }
});

describe('A field gesture from the palette acts on the focused cell of the record tab in focus', () => {
  before(async () => {
    await resetMockBackendDetached();
    await enterEditing();
  });

  after(() => { exitEditing(); });

  it('removes the element the focused cell holds', async () => {
    const formKey = '000801:TestMod.esp';
    await vscode.commands.executeCommand('modbench.record.open', { formKey });
    await waitFor('the record tab', () => openTabs().some((t) => t.label === formKey) || undefined);
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

