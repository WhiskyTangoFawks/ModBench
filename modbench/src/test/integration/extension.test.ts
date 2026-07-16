import * as assert from 'assert';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { before, after, describe, it } from 'mocha';

const TEST_PORT = 15172;
let mockBackend: http.Server;
let ext: vscode.Extension<unknown> | undefined;

// Mock backend state, controlled by the launch suite. Models the real backend:
// GET /plugins fails with 503 "No session loaded" until POST /session/load-explicit
// is received, then serves the loaded plugins (issue #75).
const MOCK_PLUGINS = [
  { name: 'Fallout4.esm', path: '/data/Fallout4.esm' },
  { name: 'TestMod.esp', path: '/data/TestMod.esp' },
];
let sessionLoaded = false;
const requestLog: string[] = [];

function resetMockBackend(): void {
  sessionLoaded = false;
  requestLog.length = 0;
}

function createMockBackend(): http.Server {
  return http.createServer((req, res) => {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';
    requestLog.push(`${method} ${url}`);
    if (url === '/health') {
      res.writeHead(200);
      res.end();
      return;
    }
    if (method === 'POST' && url === '/session/load-explicit') {
      req.on('data', () => {}); // drain the body so 'end' fires
      req.on('end', () => {
        sessionLoaded = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ failures: [] }));
      });
      return;
    }
    if (url === '/session/filter') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sql: null }));
      return;
    }
    if (url === '/plugins') {
      if (!sessionLoaded) {
        res.writeHead(503);
        res.end('No session loaded.');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(MOCK_PLUGINS));
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

// Start a mock backend that answers GET /health → 200 so the extension reaches
// 'attached'. /plugins is session-gated (see above). Uses port 15172 (set via
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
  await new Promise<void>((resolve, reject) =>
    mockBackend.close(err => (err ? reject(err) : resolve()))
  );
});

// ── Activation ───────────────────────────────────────────────────────────────────

describe('modbench activation', () => {
  it('auto-activates on startup without any explicit activate() call', () => {
    assert.ok(ext?.isActive, 'expected the extension to auto-activate via onStartupFinished');
  });
});

// ── Command registration ───────────────────────────────────────────────────────

describe('modbench command registration', () => {
  const EXPECTED_COMMANDS = [
    'modbench.openEditor',
    'modbench.openCompare',
    'modbench.openHeader',
    'modbench.closeMedit',
    'modbench.reloadSession',
    'modbench.refreshTree',
    'modbench.newPlugin',
    'modbench.copyAsOverrideInto',
    'modbench.filterPluginTree',
    'modbench.setFilter',
    'modbench.clearFilter',
    'modbench.setFilterFromDocument',
    'modbench.showReferencedBy',
    'modbench.deleteRecord',
    'modbench.saveGroup',
    'modbench.revertGroup',
    'modbench.saveAllGroups',
    'modbench.revertAllGroups',
    'modbench.createPlaced',
    'modbench.modList.filter',
    'modbench.modList.switchProfile',
    'modbench.modList.launchMedit',
    'modbench.modList.refresh',
    'modbench.modList.sortDescending',
    'modbench.modList.sortAscending',
    'modbench.modList.deploy',
    'modbench.modList.purge',
    'modbench.modList.launchGame',
    'modbench.modList.installFromArchive',
    'modbench.modList.installFromFolder',
    'modbench.modList.mod.openInExplorer',
    'modbench.modList.mod.addSeparatorBelow',
    'modbench.modList.mod.moveToSeparator',
    'modbench.modList.mod.uninstall',
    'modbench.modList.mod.viewOnNexus',
    'modbench.modList.separator.rename',
    'modbench.modList.separator.addSeparatorBelow',
    'modbench.modList.separator.delete',
    'modbench.modList.overwrite.reveal',
    'modbench.downloads.open',
    'modbench.pluginListTree.refresh',
    'modbench.pluginListTree.filter',
    'modbench.pluginListTree.revealInExplorer',
  ];

  it('registers all expected commands on activation', async () => {
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

// ── downloads.open ──────────────────────────────────────────────────────────

describe('modbench.downloads.open', () => {
  it('opens a new webview tab (test workspace has no downloads/ folder)', async () => {
    const tabsBefore = vscode.window.tabGroups.all.flatMap(g => g.tabs).length;

    await vscode.commands.executeCommand('modbench.downloads.open');
    await new Promise(r => setTimeout(r, 500));

    const tabsAfter = vscode.window.tabGroups.all.flatMap(g => g.tabs).length;
    assert.ok(tabsAfter > tabsBefore, 'Expected a new tab to be opened by modbench.downloads.open');
  });

  it('reuses the existing panel on a second call', async () => {
    const tabsAfterFirst = vscode.window.tabGroups.all.flatMap(g => g.tabs).length;

    await vscode.commands.executeCommand('modbench.downloads.open');
    await new Promise(r => setTimeout(r, 300));

    const tabsAfterSecond = vscode.window.tabGroups.all.flatMap(g => g.tabs).length;
    assert.strictEqual(
      tabsAfterSecond,
      tabsAfterFirst,
      'Second modbench.downloads.open call should reuse the existing panel, not open a new tab'
    );
  });
});

// ── Overwrite row (#82) ────────────────────────────────────────────────────────

interface ModListLike {
  invalidate(): void;
  getChildren(element?: unknown): Promise<Array<{ label?: unknown; kind?: string; resourceUri?: vscode.Uri }>>;
}

describe('Overwrite row (#82)', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const overwriteDir = root ? path.join(root, 'overwrite') : '';
  const provider = () => (ext?.exports as { modListProvider?: ModListLike } | undefined)?.modListProvider;

  // The pinned Overwrite row is appended only once the modlist loads (it sits
  // after the mod roots). The bare test workspace is not an MO2 instance, so lay
  // down a minimal one — ModOrganizer.ini + an empty Default profile modlist —
  // just for this suite, and remove it after.
  before(() => {
    if (!root) return;
    fs.writeFileSync(path.join(root, 'ModOrganizer.ini'), '[General]\ngameName=Fallout4\nselected_profile=Default\n');
    fs.mkdirSync(path.join(root, 'profiles', 'Default'), { recursive: true });
    fs.writeFileSync(path.join(root, 'profiles', 'Default', 'modlist.txt'), '');
    fs.mkdirSync(path.join(root, 'mods'), { recursive: true });
  });

  after(() => {
    if (!root) return;
    fs.rmSync(overwriteDir, { recursive: true, force: true });
    fs.rmSync(path.join(root, 'ModOrganizer.ini'), { force: true });
    fs.rmSync(path.join(root, 'profiles'), { recursive: true, force: true });
    fs.rmSync(path.join(root, 'mods'), { recursive: true, force: true });
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

// ── Launch mEdit → editing plugin tree populated (#75) ──────────────────────────

interface TreeLike {
  getChildren(element?: unknown): Promise<Array<{ kind?: string; plugin?: { name?: string } }>>;
}

describe('Launch mEdit populates the editing plugin tree (#75)', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const treeProvider = () => (ext?.exports as { treeProvider?: TreeLike } | undefined)?.treeProvider;
  let gameDir = '';

  // enterEditing needs a resolvable game directory and a readable active profile
  // to reach POST /session/load-explicit. Lay down a minimal MO2 instance plus a
  // game dir with a Data/ folder, scoped to this suite.
  before(async () => {
    if (!root) return;
    resetMockBackend();
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-game-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', gameDir, vscode.ConfigurationTarget.Workspace);

    fs.writeFileSync(path.join(root, 'ModOrganizer.ini'), '[General]\ngameName=Fallout4\nselected_profile=Default\n');
    fs.mkdirSync(path.join(root, 'profiles', 'Default'), { recursive: true });
    fs.writeFileSync(path.join(root, 'profiles', 'Default', 'modlist.txt'), '');
    fs.writeFileSync(path.join(root, 'profiles', 'Default', 'plugins.txt'), '*TestMod.esp\n');
    fs.mkdirSync(path.join(root, 'mods'), { recursive: true });
  });

  after(async () => {
    if (!root) return;
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', undefined, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('setContext', 'modbench.viewMode', 'loadout');
    fs.rmSync(path.join(root, 'ModOrganizer.ini'), { force: true });
    fs.rmSync(path.join(root, 'profiles'), { recursive: true, force: true });
    fs.rmSync(path.join(root, 'mods'), { recursive: true, force: true });
    fs.rmSync(gameDir, { recursive: true, force: true });
  });

  it('exposes the live PluginTreeProvider from activate()', () => {
    assert.ok(treeProvider(), 'activate() should return { treeProvider } for the editing view');
  });

  it('loads the session and shows plugins (not an empty tree) after launch', async () => {
    await vscode.commands.executeCommand('modbench.modList.launchMedit');
    // Snapshot the launch's own requests before we query the tree ourselves below —
    // any GET /plugins the editing view fired during launch would appear here.
    const duringLaunch = [...requestLog];

    const load = duringLaunch.indexOf('POST /session/load-explicit');
    assert.ok(load >= 0, 'launch should POST /session/load-explicit');
    // The #75 regression: the view revealed and fetched /plugins before the session
    // was loaded. Any /plugins request the launch triggered must follow the load.
    const prematurePlugins = duringLaunch.slice(0, load).includes('GET /plugins');
    assert.ok(!prematurePlugins, 'GET /plugins must not fire before POST /session/load-explicit');

    const nodes = await treeProvider()!.getChildren();
    assert.ok(nodes.length > 0, 'the plugin tree should not be empty after a successful launch');
    assert.ok(!nodes.some((n) => n.kind === 'error'), 'the plugin tree should not show an ErrorNode');
    assert.deepStrictEqual(
      nodes.map((n) => n.plugin?.name),
      MOCK_PLUGINS.map((p) => p.name),
      'the tree should list the plugins the backend returned',
    );
  });
});
