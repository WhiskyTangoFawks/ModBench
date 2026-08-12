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
  { name: 'Fallout4.esm', path: '/data/Fallout4.esm', origin: 'Data' },
  { name: 'TestMod.esp', path: '/data/TestMod.esp', origin: 'Data' },
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

// ── Output channel (#198) ───────────────────────────────────────────────────────

describe('Modbench output channel (#198)', () => {
  it('is created as a leveled LogOutputChannel, not a plain text channel', () => {
    const channel = (ext?.exports as { outputChannel?: vscode.LogOutputChannel } | undefined)?.outputChannel;
    assert.ok(channel, 'activate() should return { outputChannel }');
    // A plain vscode.OutputChannel has none of these — only { log: true } adds them.
    assert.strictEqual(typeof channel?.debug, 'function', 'expected a .debug() method');
    assert.strictEqual(typeof channel?.info, 'function', 'expected an .info() method');
    assert.strictEqual(typeof channel?.warn, 'function', 'expected a .warn() method');
    assert.strictEqual(typeof channel?.error, 'function', 'expected an .error() method');
    assert.ok(channel && 'logLevel' in channel, "expected VS Code's native level filter to apply (logLevel)");
  });
});

// ── Command registration ───────────────────────────────────────────────────────

describe('modbench command registration', () => {
  const EXPECTED_COMMANDS = [
    'modbench.openEditor',
    'modbench.openEditorBeside',
    'modbench.openCompare',
    'modbench.openHeader',
    'modbench.closeMedit',
    'modbench.reloadSession',
    // #247: one Refresh for every Mod-Management source, replacing modbench.refreshTree,
    // modbench.modList.refresh and modbench.pluginListTree.refresh — same need, three ids.
    'modbench.refresh',
    'modbench.newPlugin',
    'modbench.copyAsOverrideInto',
    'modbench.filterPluginTree',
    'modbench.setFilter',
    'modbench.clearFilter',
    'modbench.setFilterFromDocument',
    'modbench.showReferencedBy',
    // #282: the Referenced By view's own copy command — see packageJson.test.ts for its
    // view/item/context and keybinding contributions (declarative, not exercised here).
    'modbench.referencedByTree.copy',
    'modbench.deleteRecord',
    'modbench.saveGroup',
    'modbench.revertGroup',
    'modbench.saveAllGroups',
    'modbench.revertAllGroups',
    // #208: the pending cell's native `webview/context` menu commands — see package.json's
    // contributes.menus["webview/context"] (gated on webviewId/webviewSection, not testable
    // from this harness) and RecordPanel's data-vscode-context wiring (unit-tested).
    'modbench.pendingCell.reveal',
    'modbench.pendingCell.saveGroup',
    'modbench.pendingCell.revertGroup',
    // #209: the column-header's native `webview/context` menu commands — same shape as #208's
    // pendingCell.* above (package.json's contributes.menus["webview/context"], gated on
    // webviewId/webviewSection/immutable/isHeaderRecord, not testable from this harness; and
    // RecordPanel's data-vscode-context wiring, unit-tested). modbench.copyAsOverrideInto
    // (already listed above) is reused for Copy as Override… from this same menu — no separate
    // command id for it. #202: modbench.columnHeader.copyAllToPending deleted outright — Copy as
    // Override now covers that case via sourcePlugin instead of a fourth, near-duplicate action.
    'modbench.columnHeader.copyAsNewRecord',
    'modbench.columnHeader.removeOverride',
    'modbench.columnHeader.addMaster',
    // #227: the array-element/array-parent native `webview/context` menu commands — same shape
    // as #208/#209 above (package.json's contributes.menus["webview/context"], gated on
    // webviewId/webviewSection, not testable from this harness; and DiffRow's data-vscode-context
    // wiring, unit-tested in DiffRow.test.tsx/ArrayDiffRows.test.tsx).
    'modbench.array.add',
    'modbench.array.remove',
    'modbench.array.moveUp',
    'modbench.array.moveDown',
    // #231: VMAD's own structural-op native `webview/context` menu commands — same shape as
    // #227's array.* above (package.json gating, RecordPanel.test.tsx's own unit coverage).
    'modbench.vmad.addScript',
    'modbench.vmad.removeScript',
    'modbench.vmad.addProperty',
    'modbench.vmad.removeProperty',
    // #231 (review): Set Script Flags/Set Property Flags — restores capability lost when
    // VmadSection's always-visible flag `<select>`s were deleted (AC7 regression).
    'modbench.vmad.setScriptFlags',
    'modbench.vmad.setPropertyFlags',
    'modbench.createPlaced',
    'modbench.modList.filter',
    'modbench.modList.switchProfile',
    'modbench.modList.launchMedit',
    'modbench.modList.sortDescending',
    'modbench.modList.sortAscending',
    'modbench.modList.deploy',
    'modbench.modList.purge',
    'modbench.launch',
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
    // #233: the Downloads row's native `view/item/context` menu commands on the
    // modbench.downloads TreeView — see package.json's contributes.menus["view/item/context"]
    // (regex `when` gating, not testable from this harness) and DownloadsProvider's
    // contextValue wiring (unit-tested). modbench.downloads.open/.reveal are gone with the
    // webview — VS Code auto-generates modbench.downloads.focus for the contributed view, and
    // the workspace-root Explorer already reveals downloads/.
    'modbench.downloads.install',
    'modbench.downloads.visitNexus',
    'modbench.downloads.openFile',
    'modbench.downloads.openMeta',
    'modbench.downloads.delete',
    'modbench.downloads.hide',
    'modbench.downloads.unhide',
    // #247: Downloads narrows by name through the same widget as every other list view,
    // superseding #233's native-tree-Find call.
    'modbench.downloads.filter',
    // #238: the view/title Sort by… overflow command and the Show-hidden title-bar toggle.
    'modbench.downloads.sortBy',
    'modbench.downloads.showHidden',
    'modbench.downloads.hideHidden',
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

// ── modbench.downloads tree (#233) ──────────────────────────────────────────

interface DownloadsProviderLike {
  invalidate(): void;
  getChildren(element?: unknown): Promise<Array<{ label?: unknown; row?: { name: string } }>>;
}

describe('modbench.downloads tree (#233)', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const downloadsDir = root ? path.join(root, 'downloads') : '';
  const provider = () => (ext?.exports as { downloadsProvider?: DownloadsProviderLike } | undefined)?.downloadsProvider;

  // The committed test workspace fixture (#192) has no downloads/ folder — created and
  // torn down here so the "no downloads/ folder" empty state stays exercisable against
  // the same workspace elsewhere (mirrors the Overwrite suite's overwriteDir cleanup, #82).
  after(() => {
    if (!root) return;
    fs.rmSync(downloadsDir, { recursive: true, force: true });
  });

  it('exposes the live DownloadsProvider from activate()', () => {
    assert.ok(provider(), 'activate() should return { downloadsProvider } for the open workspace');
  });

  it('renders one row per archive, .meta sidecars suppressed', async () => {
    fs.mkdirSync(downloadsDir, { recursive: true });
    fs.writeFileSync(path.join(downloadsDir, 'foo.zip'), 'data');
    fs.writeFileSync(path.join(downloadsDir, 'foo.zip.meta'), '[General]\r\n');

    const p = provider()!;
    p.invalidate();
    const rows = await p.getChildren();
    assert.deepStrictEqual(rows.map((r) => r.row?.name), ['foo.zip']);
  });

  it('reflects a new archive dropped into downloads/ via the file-watcher, with no manual refresh', async () => {
    fs.writeFileSync(path.join(downloadsDir, 'bar.zip'), 'data');

    // The watcher debounces 200ms (downloadsWatcher.ts) before it calls invalidate() itself —
    // poll for the row rather than a fixed sleep, so this isn't flaky under load. Never calls
    // p.invalidate() directly: the point of this test is that the watcher does it unprompted.
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
  // after the mod roots). The committed test workspace fixture (#192) is
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

// ── Launch mEdit → editing plugin tree populated (#75) ──────────────────────────

interface TreeLike {
  getChildren(element?: unknown): Promise<Array<{ kind?: string; plugin?: { name?: string } }>>;
}

describe('Launch mEdit populates the editing plugin tree (#75)', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const treeProvider = () => (ext?.exports as { treeProvider?: TreeLike } | undefined)?.treeProvider;
  let gameDir = '';

  // enterEditing needs a resolvable game directory and an enabled plugin in the
  // active profile to reach POST /session/load-explicit. The committed test
  // workspace fixture (#192) already supplies a valid MO2 instance (empty
  // plugins.txt) — only the suite-scoped plugins.txt content and game dir are
  // set up here.
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
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', undefined, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('setContext', 'modbench.viewMode', 'loadout');
    fs.writeFileSync(path.join(root, 'profiles', 'Default', 'plugins.txt'), '');
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

// ── mEdit plugin tree title reflects view mode (#109) ───────────────────────────
// The activity-bar container title ("Modbench") is fixed by VS Code; the mEdit
// context instead lives on the editing plugin tree's own writable `title`.

interface TitledTreeView { title?: string }

describe('mEdit plugin tree title reflects view mode (#109)', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const exportsOf = () => ext?.exports as {
    treeView?: TitledTreeView;
    changeGroupTreeView?: TitledTreeView;
    modListProvider?: unknown;
  } | undefined;
  let gameDir = '';

  // The committed test workspace fixture (#192) already supplies a valid MO2
  // instance (empty plugins.txt) — only the suite-scoped plugins.txt content
  // and game dir are set up here.
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
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', undefined, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('setContext', 'modbench.viewMode', 'loadout');
    fs.writeFileSync(path.join(root, 'profiles', 'Default', 'plugins.txt'), '');
    // This suite's own Launch Game test deploys against gameDir before the
    // (failing, fake) launch — that writes mods/.medit-manifest.json. purge()
    // never runs since the spawn errors rather than exits, so clean the manifest
    // up by hand to keep the committed fixture pristine across runs.
    fs.rmSync(path.join(root, 'mods', '.medit-manifest.json'), { force: true });
    fs.rmSync(gameDir, { recursive: true, force: true });
  });

  it('sets the mEdit plugin tree title when Launch mEdit enters editing mode', async () => {
    await vscode.commands.executeCommand('modbench.modList.launchMedit');
    assert.strictEqual(
      exportsOf()?.treeView?.title, 'mEdit — Plugins',
      'the editing plugin tree title should convey the mEdit context after Launch mEdit',
    );
  });

  it('leaves the Pending Changes view title untouched entering editing mode', () => {
    assert.strictEqual(
      exportsOf()?.changeGroupTreeView?.title, 'Pending Changes',
      'only the editing plugin tree title should change — Pending Changes keeps its declared default',
    );
  });

  it('restores the default plugin tree title when Close mEdit exits editing mode', async () => {
    await vscode.commands.executeCommand('modbench.closeMedit');
    assert.strictEqual(
      exportsOf()?.treeView?.title, 'Plugins',
      'closing mEdit should restore the plugin tree title to its declared default',
    );
  });

  // #247 deleted the Launch-Game-enters-editing-mode case along with the command. Launching
  // and editing are separate operations: the replacement (modbench.launch) runs a contributed
  // task and touches no view mode, so there is no longer a title to assert.
});

// ── Loadout stays visible through an editing session (#268) ────────────────────
// The declarative view-mode gate itself is proven statically in packageJson.test.ts. These
// prove the two user-observable consequences only a live host can show: durable Plugin
// load order state survives a Launch mEdit / Close mEdit round trip untouched (AC5), and its
// write path (enable/disable) stays reachable while a session is running (AC4).

interface PluginListNodeLike { plugin?: { name?: string } }
interface PluginListProviderLike {
  setFilter(text: string): void;
  setPluginEnabled(name: string, enabled: boolean): Promise<void>;
  handleDrop(target: unknown, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void>;
  invalidate(): void;
  getChildren(element?: unknown): Promise<PluginListNodeLike[]>;
}

describe('Loadout stays visible through an editing session (#268)', () => {
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
    fs.writeFileSync(pluginsTxtPath, '*TestMod.esp\n*Other.esp\n');
  });

  after(async () => {
    if (!root) return;
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', undefined, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('setContext', 'modbench.viewMode', 'loadout');
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

    await vscode.commands.executeCommand('modbench.modList.launchMedit');
    await vscode.commands.executeCommand('modbench.closeMedit');

    const after = await provider.getChildren();
    assert.deepStrictEqual(
      after.map((n) => n.plugin?.name), ['TestMod.esp'],
      'the filter set before Launch mEdit must still be applied after Close mEdit — the loadout view was never torn down',
    );
  });

  it('still writes plugins.txt through the Plugin load order while a session is running (AC4)', async () => {
    const provider = pluginListProvider()!;
    provider.setFilter(''); // undo the previous test's filter so both rows are addressable
    await vscode.commands.executeCommand('modbench.modList.launchMedit');

    await provider.setPluginEnabled('Other.esp', false);

    const written = fs.readFileSync(pluginsTxtPath, 'utf8');
    assert.ok(written.includes('Other.esp'), 'plugins.txt should still list Other.esp, just disabled');
    assert.ok(!written.includes('*Other.esp'), 'disabling a plugin mid-session should still write plugins.txt');

    await vscode.commands.executeCommand('modbench.closeMedit');
  });

  it('still writes plugins.txt through the Plugin load order drag-reorder while a session is running (AC4)', async () => {
    const provider = pluginListProvider()!;
    provider.setFilter('');
    fs.writeFileSync(pluginsTxtPath, '*TestMod.esp\n*Other.esp\n');
    provider.invalidate();
    await provider.getChildren(); // populate the cached order handleDrop's index math reads against

    await vscode.commands.executeCommand('modbench.modList.launchMedit');

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
      'dragging TestMod.esp to the end mid-session should still write the reordered plugins.txt',
    );

    await vscode.commands.executeCommand('modbench.closeMedit');
  });
});
