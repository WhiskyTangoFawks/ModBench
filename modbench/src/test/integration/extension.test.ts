import * as assert from 'assert';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { before, after, beforeEach, afterEach, describe, it } from 'mocha';

const TEST_PORT = 15172;
let mockBackend: http.Server;
let ext: vscode.Extension<unknown> | undefined;

// Mock backend state, controlled by the launch suite. Models the real backend:
// GET /plugins fails with 503 "No session loaded" until POST /session/load-explicit
// is received, then serves the loaded plugins (issue #75).
// #270: the session holds every plugins.txt line, so a disabled one is present and browsable —
// it just never participates in winner computation.
// #295: an explicit type (rather than inferred from the literal below) so mockPluginsOverride
// can build a variant of one entry (e.g. its masterIssues resolved) without every other entry's
// shape narrowing what's assignable — the literal below is otherwise deliberately loose per its
// own #277 comment (some entries omit isImmutable/masterIssues entirely).
type MockPlugin = {
  name: string; path: string; origin: string; participates: boolean;
  isImmutable?: boolean; masterIssues?: { masterName: string; kind: string }[];
  // #278 / ADR-0035 amending ADR-0018: omitted everywhere below on purpose — every existing row
  // exercises the wire's `?? true` default this way, the same convention masterIssues above
  // already uses for the "field entirely absent" case.
  hasMatchingRecords?: boolean;
};
const MOCK_PLUGINS: MockPlugin[] = [
  { name: 'Fallout4.esm', path: '/data/Fallout4.esm', origin: 'Data', participates: true },
  { name: 'TestMod.esp', path: '/data/TestMod.esp', origin: 'Data', participates: true },
  { name: 'Other.esp', path: '/data/Other.esp', origin: 'Data', participates: false },
  // #276: a plugins.txt line (not an implicit master) the backend reports read-only for editing
  // (Editing's "Immutable plugin") — exercises the composite's tooltip decoration end-to-end,
  // distinct from ImplicitMasterNode's own (Mod-Management-only, no session needed) lock icon.
  { name: 'Immutable.esm', path: '/data/Immutable.esm', origin: 'Data', participates: true, isImmutable: true },
  // #277 / ADR-0037: a plugin the backend flags with a directly-missing master — exercises the
  // composite's error decoration end-to-end. Deliberately carries no `masterIssues` key on any
  // *other* MOCK_PLUGINS entry (e.g. TestMod.esp above) so those rows double as the "wire omits
  // the field entirely" case a hand-typed PluginMetadata fixture could never produce on its own.
  {
    name: 'MissingMaster.esp', path: '/data/MissingMaster.esp', origin: 'Data', participates: true,
    masterIssues: [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' }],
  },
];
const MOCK_RECORD_TYPES = [{ type: 'weap', count: 3, displayName: 'Weapon' }];
// #364: GET /records/conflicts' answer — the Conflicts node's own listing. Empty until a test
// says otherwise, mirroring mockPluginsOverride's "changeable per test, reset between them" shape.
let mockConflicts: unknown[] = [];
let sessionLoaded = false;
const requestLog: string[] = [];
// #295: lets a test change what the *next* load reports without touching MOCK_PLUGINS itself —
// simulates a plugin's decoration-worthy state (a master issue, a load failure) changing between
// one load and a reload of the same session.
let mockPluginsOverride: MockPlugin[] | null = null;
// #295 AC4: makes the next POST /session/load-explicit fail, the way a bad game directory or a
// backend-side load error would — session.md's own contract (SessionManager.LoadExplicitCore
// disposes the previous session unconditionally first) means the mock must *not* set
// sessionLoaded on this path, matching the real backend leaving no session behind either.
let loadExplicitShouldFail = false;
// #307: GET /session/status' answer — what the load can honestly say about itself *right now*.
// Mutable per-test so a suite can script a load landing one plugin at a time and observe the tree
// react to each, which is the whole subject of progressive load. `conflictsComputed` is separate
// from any notion of state on purpose (SessionStatus.cs) — the tree gates its incompleteness
// message on this field alone.
type MockSessionStatus = {
  totalPlugins: number;
  indexedPlugins: { name: string; origin: string }[];
  conflictsComputed: boolean;
  failures: { name: string; reason: string }[];
};
const NO_SESSION_STATUS: MockSessionStatus =
  { totalPlugins: 0, indexedPlugins: [], conflictsComputed: false, failures: [] };
let sessionStatus: MockSessionStatus = { ...NO_SESSION_STATUS };
// #307: when set, POST /session/load-explicit does not answer until the test calls it — the real
// backend's load blocks for the whole indexing run, and every progressive-load assertion is about
// what the tree does *during* that window. A mock that answers instantly cannot express it.
let releaseLoadExplicit: (() => void) | null = null;
let holdLoadExplicit = false;
// #307 AC7: the same trick one step earlier in the launch. `BackendManager.start()` gates on
// GET /health, so holding it parks a launch in its *first* phase — before the load POST exists at
// all — which is the window a mid-load close has to survive too. One-shot: releasing clears the
// hold, so the connect loop's next attempt answers normally.
let releaseHealth: (() => void) | null = null;
let holdHealth = false;

function resetMockBackend(): void {
  sessionLoaded = false;
  requestLog.length = 0;
  mockPluginsOverride = null;
  mockConflicts = [];
  loadExplicitShouldFail = false;
  sessionStatus = { ...NO_SESSION_STATUS };
  holdLoadExplicit = false;
  releaseLoadExplicit?.();
  releaseLoadExplicit = null;
  holdHealth = false;
  releaseHealth?.();
  releaseHealth = null;
}

/** #307: report the load as having indexed `names` so far. `conflictsComputed` stays false until
 *  a test says otherwise — the winner sweep is the last thing a real load does. */
function setIndexed(names: string[], extra: Partial<MockSessionStatus> = {}): void {
  sessionStatus = {
    totalPlugins: Math.max(names.length, sessionStatus.totalPlugins),
    indexedPlugins: names.map((name) => ({ name, origin: 'Data' })),
    conflictsComputed: false,
    failures: [],
    ...extra,
  };
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
    if (method === 'POST' && url === '/session/load-explicit') {
      req.on('data', () => {}); // drain the body so 'end' fires
      req.on('end', () => {
        // #295 AC4: mirrors SessionManager.LoadExplicitCore — the real backend disposes the
        // previous session unconditionally before attempting the new one, so a failed load
        // leaves no session behind either, not the stale one.
        if (loadExplicitShouldFail) {
          sessionLoaded = false;
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'simulated load failure' }));
          return;
        }
        // #307: the real load blocks for the whole indexing run. Held open so a test can observe
        // the tree mid-load; answered immediately otherwise, as every pre-#307 test expects.
        const answer = () => {
          sessionLoaded = true;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ failures: [] }));
        };
        if (!holdLoadExplicit) return answer();
        releaseLoadExplicit = () => { releaseLoadExplicit = null; answer(); };
      });
      return;
    }
    // #307 / #274: answers 200 in every state including "no session" — reporting the absence of
    // a session is this endpoint's job, not a failure to do it (SessionEndpoints.cs).
    if (url === '/session/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessionStatus));
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
      res.end(JSON.stringify(mockPluginsOverride ?? MOCK_PLUGINS));
      return;
    }
    // #270: a plugin row's children come from here once a session is running.
    if (/^\/plugins\/[^/]+\/record-types$/.test(url)) {
      res.writeHead(sessionLoaded ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(sessionLoaded ? JSON.stringify(MOCK_RECORD_TYPES) : 'No session loaded.');
      return;
    }
    // #364: the Conflicts node's own listing.
    if (url === '/records/conflicts') {
      res.writeHead(sessionLoaded ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(sessionLoaded ? JSON.stringify(mockConflicts) : 'No session loaded.');
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

// ── Build integrity (#299) ─────────────────────────────────────────────────────
// The harness loads out/extension.js, a bundle produced by a separate esbuild step —
// nothing about running this suite forces that bundle to be current. Assert the property
// from inside the process that actually loaded it, rather than trust the npm script that
// got us here (pretest:integration could be deleted, renamed, point at the wrong outfile,
// or esbuild could silently stop emitting — every one of those goes red here).

describe('the loaded extension bundle is not older than its sources (#299)', () => {
  it('out/extension.js is at least as new as every file under src/', () => {
    // Compiled location is out/test/integration/extension.test.js — three levels under
    // the modbench package root.
    const pkgRoot = path.join(__dirname, '..', '..', '..');
    const srcDir = path.join(pkgRoot, 'src');
    const bundlePath = path.join(pkgRoot, 'out', 'extension.js');
    // The workspace fixture VS Code opens as the test workspace folder — it's live,
    // written to mid-run by other suites (downloads/, overwrite/, plugins.txt edits), so
    // its mtimes churn independently of any bundle-affecting source edit and would flake
    // this comparison. It also isn't part of the bundle.
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
    // #426 Track 4: the array-op right-click commands (record editor's field grid).
    'modbench.array.add',
    'modbench.array.remove',
    'modbench.array.moveUp',
    'modbench.array.moveDown',
    // #426 Track 5: VMAD's structural-op right-click commands (record editor's field grid).
    'modbench.vmad.addScript',
    'modbench.vmad.removeScript',
    'modbench.vmad.addProperty',
    'modbench.vmad.removeProperty',
    'modbench.vmad.setScriptFlags',
    'modbench.vmad.setPropertyFlags',
    // #258 / ADR-0039: the string cell's own right-click command (record editor's field grid).
    'modbench.field.openExtended',
    'modbench.closeMedit',
    'modbench.reloadSession',
    // #247: one Refresh for every Mod-Management source, replacing modbench.refreshTree,
    // modbench.modList.refresh and modbench.pluginListTree.refresh — same need, three ids.
    'modbench.refresh',
    'modbench.newPlugin',
    // #273 Slice D: modbench.filterPluginTree (issue #70) is gone — it duplicated
    // modbench.pluginListTree.filter over the same rows once the merged tree made this
    // command's own view (modbench.pluginTree) unreachable.
    'modbench.setFilter',
    'modbench.clearFilter',
    'modbench.setFilterFromDocument',
    'modbench.showReferencedBy',
    // #282: the Referenced By view's own copy command — see packageJson.test.ts for its
    // view/item/context and keybinding contributions (declarative, not exercised here).
    'modbench.referencedByTree.copy',
    'modbench.modList.filter',
    'modbench.modList.clearFilter',
    'modbench.modList.switchProfile',
    'modbench.modList.launchMedit',
    'modbench.modList.view.winningAtTop',
    'modbench.modList.view.losingAtTop',
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
    // #255: every name filter is durable, so every one of them has an explicit clear — the
    // slot-1 clear variant, gated on that view's own filter-active context key.
    'modbench.downloads.clearFilter',
    // #238: the view/title Sort by… overflow command and the Show-hidden title-bar toggle.
    'modbench.downloads.sortBy',
    'modbench.downloads.showHidden',
    'modbench.downloads.hideHidden',
    'modbench.pluginListTree.filter',
    'modbench.pluginListTree.clearFilter',
    'modbench.pluginListTree.revealInExplorer',
    // #448 AC5: a Stack peer's own "jump to the providing mod" gesture. Gated to
    // `viewItem == stackPeer` in package.json and hidden from the palette, same posture as
    // revealInExplorer — it needs the clicked peer row's own origin.
    'modbench.pluginListTree.revealInModsTree',
    // #448 AC4: the Stack node's binary entry's own "diff working tree vs last compile" gesture.
    // Gated to `viewItem == stackBinaryState` and hidden from the palette — it needs the clicked
    // entry's own (plugin, origin), no ambient fallback.
    'modbench.pluginListTree.diffAgainstSource',
    // #414/ADR-0041: the Track gesture. Gated to `viewItem == plugin` in package.json and hidden
    // from the palette — it needs the clicked row's plugin name.
    'modbench.pluginListTree.track',
    // #416: Save & Compile — reachable from the record editor's editor/title icon, the tree row's
    // context menu, and the palette (falls back to a QuickPick when invoked with no plugin in hand).
    'modbench.saveAndCompile',
    // #416: compile-at-main behind its own confirmation. Gated to the clicked row and hidden from
    // the palette, same posture as Track — naming a ref to compile at with no plugin in hand isn't
    // a gesture the palette can support.
    'modbench.pluginListTree.compileAtMain',
    // #417: Modbench: Rebase onto Updated Baseline — the offered rebase's re-runnable form. Gated
    // to the clicked row and hidden from the palette, same posture as Track/compileAtMain.
    'modbench.pluginListTree.rebase',
    // #363: Filter to Selected Plugins — the ordinary record filter, pre-restricted to the
    // clicked/selected plugin row(s). Gated to plugin-bearing rows and hidden from the palette,
    // same posture as Track/rebase — it needs the row selection, with no ambient fallback.
    'modbench.pluginListTree.filterToSelected',
    // #427: the three lifecycle gestures — Add (recordType row), Remove/Change FormID… (record
    // row). Gated to the clicked row and hidden from the palette, same posture as Track/rebase —
    // each needs the clicked row's own identity, with no ambient fallback.
    'modbench.record.create',
    'modbench.record.delete',
    'modbench.record.renumber',
    // #436/#494: Copy as Override Into…/Copy as New Record Into… — restored on both the plugins-
    // tree record row and the record editor's own column header, sharing one implementation path.
    // Gated and hidden from the palette the same way, for the same reason.
    'modbench.record.copyAsOverride',
    'modbench.record.copyAsNewRecord',
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

// ── modbench.openEditorBeside (#284) ────────────────────────────────────────────
// Reachable today from the Referenced By tree's group rows (plain {formKey,label} shape) and, as
// of #284, from the Plugins tree's record/placed-reference rows too (RecordNode/PlacedNode
// shapes, single or multi-selected) — none of this was under test before #284.

describe('modbench.openEditorBeside', () => {
  it('opens a plain {formKey,label}-shaped target as a genuinely new tab, never retargeting the singleton (#284)', async () => {
    // Seed the singleton with a known title first — a wrong implementation that routed this
    // through the singleton/retarget path instead of always creating a fresh panel would retarget
    // *this* panel rather than opening a new tab, which is exactly what the assertions below catch.
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

  it('resolves a Plugins-tree RecordNode-shaped argument to its own record (#284)', async () => {
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

  it('resolves a Plugins-tree PlacedNode-shaped argument (placed-reference row) to its own record (#284)', async () => {
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

  it('two sequential single-target opens land as two separate tabs — neither retargets the other (#284)', async () => {
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

  it('a multi-selection opens one panel per record, all landing in a single new editor group beside the active one (#284)', async () => {
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

// ── modbench.openHeader reachable from every plugin-bearing row (#273 Slice E) ──
// The gap this closes: the old modbench.pluginTree's Open Header reached both 'plugin' and
// 'pluginImmutable' rows (medit's own read-only-master contextValue). The merged tree's rows
// come from modmanager/PluginListProvider.ts instead, whose implicit-master row is a *different*
// class with a *different* contextValue ('pluginImplicit', not 'pluginImmutable') and no `.plugin`
// field at all — so the handler's own node-shape assumption, not just the package.json `when`,
// had to change for this row kind to keep working. Reconciling the two contextValues is #276's,
// not this ticket's.
import { PluginNode as PluginListPluginNode, ImplicitMasterNode } from '../../modmanager/PluginListProvider';

describe('modbench.openHeader reachable from every plugin-bearing row of the merged tree (#273 Slice E)', () => {
  it('opens a header tab from an ordinary plugin row (PluginListProvider.PluginNode)', async () => {
    const node = new PluginListPluginNode({ name: 'TestMod.esp', path: '/data/TestMod.esp', enabled: true } as any);
    await vscode.commands.executeCommand('modbench.openHeader', node);
    await new Promise(r => setTimeout(r, 300));
    const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
    assert.ok(tabs.some(t => t.label === 'TestMod.esp'), 'expected a header tab titled after the plugin');
  });

  it('opens a header tab from an implicit-master row (PluginListProvider.ImplicitMasterNode) — the gap #273 closes', async () => {
    const node = new ImplicitMasterNode('Fallout4.esm');
    await vscode.commands.executeCommand('modbench.openHeader', node);
    await new Promise(r => setTimeout(r, 300));
    const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
    assert.ok(tabs.some(t => t.label === 'Fallout4.esm'), 'expected a header tab titled after the implicit master');
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

// ── External-change poller lifecycle is gated on the backend, not activation (#432) ─────────────
// Deliberately placed here, before any other describe below ever calls Launch mEdit — this suite
// activates the extension exactly once (the file's own top-level before()), so "no poll before
// Launch mEdit" is only provable at the one point in the run where that is still true.

describe('External-change poller starts/stops with the backend, never before Launch mEdit (#432)', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  let gameDir = '';
  const pollRequests = (log: string[]) => log.filter((r) => r.includes('external-changes/status'));

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
    await vscode.commands.executeCommand('modbench.closeMedit');
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', undefined, vscode.ConfigurationTarget.Workspace);
    fs.writeFileSync(path.join(root, 'profiles', 'Default', 'plugins.txt'), '');
    fs.rmSync(gameDir, { recursive: true, force: true });
  });

  it('polls only between a successful Launch mEdit and Close mEdit', async function () {
    if (!root) this.skip();
    this.timeout(20000);

    // Wait past one full poll interval (EXTERNAL_CHANGE_POLL_INTERVAL_MS = 3000ms) with no Launch
    // mEdit run — the pre-#432 wiring (unconditional start at activation) would already have
    // ticked at least once by now.
    await new Promise((r) => setTimeout(r, 3500));
    assert.strictEqual(pollRequests(requestLog).length, 0,
      'no external-change poll should fire before Launch mEdit has ever run');

    await vscode.commands.executeCommand('modbench.modList.launchMedit');
    await new Promise((r) => setTimeout(r, 3500));
    assert.ok(pollRequests(requestLog).length > 0,
      'expected the poller to start once Launch mEdit confirms the backend is up');

    await vscode.commands.executeCommand('modbench.closeMedit');
    const countAtClose = pollRequests(requestLog).length;
    await new Promise((r) => setTimeout(r, 3500));
    assert.strictEqual(pollRequests(requestLog).length, countAtClose,
      'expected no further external-change polls after Close mEdit');
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

    // #273: the standalone editing tree's own root listing (what this assertion read before) is
    // gone — nothing in production calls treeProvider.getChildren(undefined) any more. The merged
    // Plugins tree (modbench.pluginListTree / pluginsTree export) is what actually reflects a
    // successful launch now: its TestMod.esp row only becomes expandable once
    // PluginsTreeComposite.setSession() has run, which only happens after the session's own
    // GET /plugins lands — so an expandable row here proves both halves of the #75 regression
    // this test guards: the fetch happened, and it happened after load, not before.
    const pluginsTreeExport = (ext?.exports as { pluginsTree?: PluginsTreeLike } | undefined)?.pluginsTree;
    assert.ok(pluginsTreeExport, 'activate() should return { pluginsTree } for the merged view');
    const rows = await pluginsTreeExport.getChildren();
    assert.ok(rows.length > 0, 'the merged plugins tree should not be empty after a successful launch');
    const testMod = findRow(rows, 'TestMod.esp');
    assert.strictEqual(
      pluginsTreeExport.getTreeItem(testMod).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed,
      'TestMod.esp should be expandable once the session has loaded and GET /plugins has landed',
    );
  });
});

// #273 AC6: the #109 runtime view-title swap ("mEdit plugin tree title reflects view mode") is
// removed outright, not adapted — modbench.pluginTree (the view whose title it swapped) and
// modbench.viewMode (the key it swapped on) are both gone, so there is no mode left to reflect
// and nothing left to assert. This comment is the suite's own tombstone; the merged tree's own
// identity is covered by the #270 suite below, and
// packageJson.test.ts assertion (its declared name never changes at runtime).

// ── Loadout stays visible through an editing session (#268) ────────────────────
// The declarative view-mode gate itself is proven statically in packageJson.test.ts. These
// prove the two user-observable consequences only a live host can show: durable Plugin
// load order state survives a Launch mEdit / Close mEdit round trip untouched (AC5), and its
// write path (enable/disable) stays reachable while a session is running (AC4).

interface PluginListNodeLike { plugin?: { name?: string; enabled?: boolean } }
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

// ── #270: the Plugin load-order rows expand into records ──────────────────────
// The merged Plugins tree, exercised through the same seam the view uses: the composite's own
// getChildren/getTreeItem. Chevrons appearing across the tree are the whole "editing is available
// now" signal (ADR-0035), so that transition is what these assert — with no session the rows are
// leaves, a session makes them collapsible without disturbing the load order, and closing it puts
// them back.

interface PluginsTreeLike {
  getChildren(element?: unknown): Promise<unknown[]>;
  getTreeItem(element: unknown): vscode.TreeItem;
}

/** A row's plugin file, however the row spells it: plugins.txt lines carry `plugin.name`, the
 *  game's implicitly-loaded masters carry `name`. The tree renders both — the implicit rows come
 *  from the resolved Data folder, so how many there are depends on the fixture instance. */
const rowName = (row: unknown): string | undefined =>
  (row as PluginListNodeLike).plugin?.name ?? (row as { name?: string }).name;
const findRow = (rows: unknown[], name: string): unknown => {
  const row = rows.find((r) => rowName(r) === name);
  assert.ok(row, `expected a row for ${name}`);
  return row;
};

describe('Plugin load-order rows expand into records (#270)', () => {
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
    fs.writeFileSync(pluginsTxtPath, '*TestMod.esp\nOther.esp\n');
    pluginListProviderOf()?.invalidate();
  });

  after(async () => {
    if (!root) return;
    await vscode.commands.executeCommand('modbench.closeMedit');
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', undefined, vscode.ConfigurationTarget.Workspace);
    fs.writeFileSync(pluginsTxtPath, '');
    fs.rmSync(gameDir, { recursive: true, force: true });
  });

  it('exposes the merged Plugins tree from activate()', () => {
    assert.ok(pluginsTree(), 'activate() should return { pluginsTree } for the open workspace');
  });

  it('renders the load order as leaves with no session', async () => {
    const tree = pluginsTree()!;
    const rows = await tree.getChildren();

    assert.deepStrictEqual(
      rows.map(rowName).filter((n) => n === 'TestMod.esp' || n === 'Other.esp'), ['TestMod.esp', 'Other.esp'],
      'the rows include both plugins.txt lines, the disabled one too, in file order',
    );
    for (const row of rows) {
      assert.strictEqual(
        tree.getTreeItem(row).collapsibleState, vscode.TreeItemCollapsibleState.None,
        'with no session every row is a leaf',
      );
    }
  });

  it('makes rows collapsible when a session starts, without reordering the load order', async () => {
    const tree = pluginsTree()!;
    const before = await tree.getChildren();

    await vscode.commands.executeCommand('modbench.modList.launchMedit');

    const after = await tree.getChildren();
    // #364: an ordinary (non-held) load completes with conflicts already known (SessionController
    // .reportLoadedSession's own doc comment — the load POST only answers after the winner sweep),
    // so the Conflicts node legitimately joins the root listing here too — filtered out (via
    // rowName's own undefined-for-non-plugin-rows behavior) before this test's own claim, which is
    // specifically about the *plugin* rows never being rebuilt or reordered, not about whether a
    // new synthetic node the #270-era tree never had can now appear alongside them.
    assert.deepStrictEqual(
      after.map(rowName).filter((n) => n !== undefined), before.map(rowName),
      'starting a session must not rebuild or reorder the plugin rows',
    );
    assert.strictEqual(
      tree.getTreeItem(findRow(after, 'TestMod.esp')).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed,
      'a row whose plugin is in the session gains a chevron',
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

  it('returns every row to a leaf when the session closes, keeping the load order', async () => {
    const tree = pluginsTree()!;

    await vscode.commands.executeCommand('modbench.closeMedit');

    const rows = await tree.getChildren();
    assert.deepStrictEqual(
      rows.map(rowName).filter((n) => n === 'TestMod.esp' || n === 'Other.esp'), ['TestMod.esp', 'Other.esp'],
      'closing the session leaves the load order untouched',
    );
    for (const row of rows) {
      assert.strictEqual(tree.getTreeItem(row).collapsibleState, vscode.TreeItemCollapsibleState.None);
    }
  });
});

// #276 / ADR-0035: read-only-for-editing is a tooltip, never an icon, and only ever known once a
// session says so — before launch (or after close) a plugin row carries no opinion about it at
// all, matching AC4/AC5 and this wiring's own real seam (extension.ts's sessionPluginFilesFrom →
// PluginsTreeComposite.setSession), not just the composite's own unit seam already covered by
// PluginsTreeComposite.test.ts.
describe('A read-only plugin\'s tooltip says so once a session is running (#276)', () => {
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
    fs.writeFileSync(pluginsTxtPath, '*Immutable.esm\n');
    pluginListProviderOf()?.invalidate();
  });

  after(async () => {
    if (!root) return;
    await vscode.commands.executeCommand('modbench.closeMedit');
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', undefined, vscode.ConfigurationTarget.Workspace);
    fs.writeFileSync(pluginsTxtPath, '');
    fs.rmSync(gameDir, { recursive: true, force: true });
  });

  it('carries no read-only tooltip before a session exists', async () => {
    const tree = pluginsTree()!;
    const row = findRow(await tree.getChildren(), 'Immutable.esm');
    assert.strictEqual(tree.getTreeItem(row).tooltip, undefined);
  });

  it('gains a read-only tooltip once the session reports it immutable', async () => {
    await vscode.commands.executeCommand('modbench.modList.launchMedit');
    const tree = pluginsTree()!;
    const row = findRow(await tree.getChildren(), 'Immutable.esm');

    const tooltip = tree.getTreeItem(row).tooltip;

    assert.ok(typeof tooltip === 'string' && tooltip.includes('read-only'), `expected a read-only tooltip, got: ${String(tooltip)}`);
  });

  it('loses the tooltip again once the session closes', async () => {
    await vscode.commands.executeCommand('modbench.closeMedit');
    const tree = pluginsTree()!;
    const row = findRow(await tree.getChildren(), 'Immutable.esm');

    assert.strictEqual(tree.getTreeItem(row).tooltip, undefined);
  });
});

// #277 / ADR-0037 AC1/AC2/AC4/AC7: a plugin the backend flags with a missing master is decorated
// through the real wiring (extension.ts's sessionPluginFilesFrom → PluginsTreeComposite.setSession),
// not just the composite's own unit seam already covered by PluginsTreeComposite.test.ts. Also
// covers the defensive-read requirement: MOCK_PLUGINS sends raw JSON no PluginMetadata-typed
// fixture could produce, so TestMod.esp — which carries no `masterIssues` key at all — proves the
// "field absent" case degrades to undecorated rather than throwing.
describe('A plugin with a missing master is flagged, never deactivated (#277)', () => {
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
    // #279: the mock backend reports both of these with origin 'Data', so the Data folder has to
    // actually hold them — otherwise drift correctly concludes their names now resolve to nothing
    // and decorates every row accordingly. Production cannot reach that state (load-explicit
    // refuses a plugin whose file is missing), so a fixture that could is the thing out of step.
    for (const name of ['TestMod.esp', 'MissingMaster.esp']) {
      fs.writeFileSync(path.join(gameDir, 'Data', name), '');
    }
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', gameDir, vscode.ConfigurationTarget.Workspace);
    fs.writeFileSync(pluginsTxtPath, '*TestMod.esp\n*MissingMaster.esp\n');
    pluginListProviderOf()?.invalidate();
    await vscode.commands.executeCommand('modbench.modList.launchMedit');
  });

  after(async () => {
    if (!root) return;
    await vscode.commands.executeCommand('modbench.closeMedit');
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
    // AC2: never deactivated, excluded or hidden — still expandable (in the session) and checked.
    assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    assert.strictEqual((row as PluginListNodeLike).plugin?.enabled, true);
    // AC3: the leading slot (checkbox) is untouched by this decoration — a real TreeItemCheckboxState
    // read, not just the underlying model's `enabled` flag, so a regression in the decoration
    // logic itself (not just in plugins.txt writing) would be caught here.
    assert.strictEqual(item.checkboxState, vscode.TreeItemCheckboxState.Checked);
  });

  it('degrades to undecorated, without throwing, for a plugin the wire sends no masterIssues for at all', async () => {
    const tree = pluginsTree()!;
    const row = findRow(await tree.getChildren(), 'TestMod.esp');

    const item = tree.getTreeItem(row);

    assert.strictEqual(item.tooltip, undefined);
  });
});

// #295: modbench.reloadSession through the real wiring — reloadSession backed by
// the reused makeEnterEditing path, not just
// reloadSession's own unit seam (already covered directly, confirm/cancel included, since
// showWarningMessage can't be driven headlessly here).
describe('Reload Session actually reloads (#295)', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const pluginsTxtPath = root ? path.join(root, 'profiles', 'Default', 'plugins.txt') : '';
  const pluginsTree = () => (ext?.exports as { pluginsTree?: PluginsTreeLike } | undefined)?.pluginsTree;
  const pluginListProviderOf = () =>
    (ext?.exports as { pluginListProvider?: PluginListProviderLike } | undefined)?.pluginListProvider;
  let gameDir = '';

  before(async () => {
    if (!root) return;
    resetMockBackend();
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-reload-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
    // #279: the mock backend reports both of these with origin 'Data', so the Data folder has to
    // actually hold them — otherwise drift correctly concludes their names now resolve to nothing
    // and decorates every row accordingly. Production cannot reach that state (load-explicit
    // refuses a plugin whose file is missing), so a fixture that could is the thing out of step.
    for (const name of ['TestMod.esp', 'MissingMaster.esp']) {
      fs.writeFileSync(path.join(gameDir, 'Data', name), '');
    }
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', gameDir, vscode.ConfigurationTarget.Workspace);
    fs.writeFileSync(pluginsTxtPath, '*TestMod.esp\n*MissingMaster.esp\n');
    pluginListProviderOf()?.invalidate();
    await vscode.commands.executeCommand('modbench.modList.launchMedit');
  });

  after(async () => {
    if (!root) return;
    await vscode.commands.executeCommand('modbench.closeMedit');
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', undefined, vscode.ConfigurationTarget.Workspace);
    fs.writeFileSync(pluginsTxtPath, '');
    fs.rmSync(gameDir, { recursive: true, force: true });
  });

  // #410: reload no longer confirms at all (there is no uncommitted work to lose), so this must
  // re-run the session load with no modal in the way — a real showWarningMessage would hang a
  // headless test, so this doubles as proof the confirm is genuinely gone.
  it('re-POSTs /session/load-explicit, no prompt required', async () => {
    const before = requestLog.filter((l) => l === 'POST /session/load-explicit').length;

    await vscode.commands.executeCommand('modbench.reloadSession');

    const after = requestLog.filter((l) => l === 'POST /session/load-explicit').length;
    assert.strictEqual(after, before + 1, 'reloadSession must issue a fresh load-explicit, not merely re-render the tree');
  });

  // The WeakMap-based decoration in PluginsTreeComposite restores each row to its captured
  // original before re-deciding what to layer back on (already covered in isolation by
  // PluginsTreeComposite.test.ts) — this proves the *real* reload wiring actually reaches it:
  // the same row object PluginListProvider handed out before the reload must lose a decoration
  // whose backend condition no longer holds, not merely gain a second copy of it. #276 shipped
  // a bug of exactly this shape (stacked, not cleared); #277 had to generalise the fix.
  it('clears a resolved master-issue decoration on the same row after reload, not just applies it', async () => {
    const tree = pluginsTree()!;
    const before = findRow(await tree.getChildren(), 'MissingMaster.esp');
    const beforeTooltip = tree.getTreeItem(before).tooltip;
    assert.ok(typeof beforeTooltip === 'string' && beforeTooltip.includes('Missing master: Ghost.esm'),
      `expected the pre-reload row to carry the master-issue tooltip, got: ${String(beforeTooltip)}`);

    // The next load reports the same plugin with its master issue resolved.
    mockPluginsOverride = MOCK_PLUGINS.map((p) => p.name === 'MissingMaster.esp' ? { ...p, masterIssues: [] } : p);
    await vscode.commands.executeCommand('modbench.reloadSession');

    const after = findRow(await tree.getChildren(), 'MissingMaster.esp');
    assert.strictEqual(after, before, 'the row list is unchanged (plugins.txt untouched), so this must be the same reused row object');
    assert.strictEqual(tree.getTreeItem(after).tooltip, undefined,
      'a resolved master issue must clear the tooltip, not leave the stale decoration stacked on top of the fresh one');
  });

  // #278 review finding 1 (Standards): matchingPlugins used to be refreshed only by
  // SessionController.setFilter/clearFilter, so a plugin a filter suppressed the row of stayed
  // suppressed through a Reload Session that came up with no filter at all — the exact "map
  // outlives the filter state it describes" bug this ticket exists to prevent, in mirror image.
  // Fixed by routing GET /plugins' hasMatchingRecords through the same completion hand-off
  // (applyLoadedSessionToTree) every session (re)load already reaches downstream of
  // SessionController.syncFilterState — modbench.reloadSession included, since it re-runs the
  // identical makeEnterEditing closure Launch mEdit uses. The first reload below stands in for
  // "a filter was active"; the second is the regression case (reload with no filter must clear
  // it) and is what would have stayed red without the fix — before it, matchingPlugins had no
  // path back to `true` short of an in-session setFilter/clearFilter call.
  //
  // #396 / ADR-0035's dated §Filters amendment reverses what "suppressed" means here: a plugin
  // with no matching records used to keep its row and lose only its chevron; now the row itself
  // is omitted from getChildren() entirely. The regression this test guards is unchanged (a stale
  // `false` must not survive a filter-free reload) — only the observable effect of the stale value
  // is different, hence asserting absence/presence of the row rather than its collapsibleState.
  it('hides a plugin a filter suppresses, and restores it once a reload comes up with no filter (#396 / #278 review)', async () => {
    const tree = pluginsTree()!;
    const before = findRow(await tree.getChildren(), 'TestMod.esp');
    assert.strictEqual(tree.getTreeItem(before).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed,
      'sanity: the row is expandable before either reload below');

    // Stands in for "a record filter matching none of TestMod.esp's records was active when this
    // session loaded" — GetPlugins() reports it, unprompted by any setFilter call on this side.
    mockPluginsOverride = MOCK_PLUGINS.map((p) => p.name === 'TestMod.esp' ? { ...p, hasMatchingRecords: false } : p);
    await vscode.commands.executeCommand('modbench.reloadSession');
    const hidden = (await tree.getChildren()).find((r) => rowName(r) === 'TestMod.esp');
    assert.strictEqual(hidden, undefined,
      'sanity: the mechanism reaches the tree — #396: a filter with no matches on this plugin hides its row entirely, not just its chevron');

    // The next load — a plain reload, reporting no filter at all — must restore it.
    mockPluginsOverride = null;
    await vscode.commands.executeCommand('modbench.reloadSession');
    const restored = findRow(await tree.getChildren(), 'TestMod.esp');
    assert.strictEqual(tree.getTreeItem(restored).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed,
      'a reload that comes up with no filter must restore a row an earlier filter hid, not leave it permanently gone');
  });

  // AC4: a failed reload must not leave the tree claiming a session the backend has already
  // discarded (SessionManager.LoadExplicitCore disposes the previous session unconditionally
  // before the new one can fail) — mirrors #270's own "returns every row to a leaf when the
  // session closes" assertion, triggered by a failed reload instead of an explicit close.
  it('returns every row to a leaf, without throwing, when the reload itself fails', async () => {
    const tree = pluginsTree()!;
    const before = findRow(await tree.getChildren(), 'TestMod.esp');
    assert.strictEqual(tree.getTreeItem(before).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed,
      'sanity: the row is expandable before the failing reload');

    loadExplicitShouldFail = true;
    await vscode.commands.executeCommand('modbench.reloadSession');

    const after = findRow(await tree.getChildren(), 'TestMod.esp');
    assert.strictEqual(tree.getTreeItem(after).collapsibleState, vscode.TreeItemCollapsibleState.None,
      'a failed reload must not leave rows claiming an expandable session that no longer exists');
  });

  // Code-review finding: AC4 must hold for every way enterEditing can fail, not only
  // loadExplicitSession resolving undefined — resolveGameDirectory throwing (an explicit
  // gameDirectory config with no Data/ subfolder) is uncaught by any of enterEditing's own
  // internal branches, so this exercises registerReloadSessionCommand's own try/catch, the
  // same one modbench.modList.launchMedit already has.
  it('tears the session down, without throwing, when the reload fails for a reason other than a rejected load-explicit', async () => {
    // The previous test's failed load-explicit already tore the session down — re-establish one.
    resetMockBackend();
    await vscode.commands.executeCommand('modbench.modList.launchMedit');
    const tree = pluginsTree()!;
    const before = findRow(await tree.getChildren(), 'TestMod.esp');
    assert.strictEqual(tree.getTreeItem(before).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed,
      'sanity: the row is expandable before the failing reload');

    // resolveGameDirectory's very first branch: an explicit config directory with no Data/
    // subfolder throws, not something loadExplicitSession's undefined-failures handling covers.
    const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-reload-nodatafolder-'));
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', brokenDir, vscode.ConfigurationTarget.Workspace);

    await vscode.commands.executeCommand('modbench.reloadSession');

    const after = findRow(await tree.getChildren(), 'TestMod.esp');
    assert.strictEqual(tree.getTreeItem(after).collapsibleState, vscode.TreeItemCollapsibleState.None,
      'an unhandled reload failure must still tear the session down, not leave the tree claiming a session that is gone');

    fs.rmSync(brokenDir, { recursive: true, force: true });
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', gameDir, vscode.ConfigurationTarget.Workspace);
  });
});

// #255: the Plugins tree's description names both of its narrowing axes, and the record filter
// is a fact about the *session* — so it cannot outlive one. Same exitToLoadout path and the same
// silent-wrong-state class as the decoration above: a readout describing a session that is gone.
// The name filter's half is deliberately untouched by a close — it narrows load-order rows,
// which are still there.
describe('The record-filter readout does not outlive its session (#255)', () => {
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
    await vscode.commands.executeCommand('modbench.modList.launchMedit');
    // Applied from an open document — the one record-filter entry point a test can drive; the
    // other opens a quick pick over the scripts folder.
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: 'SELECT form_key FROM "npc_"' });
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('modbench.setFilterFromDocument');
    assert.ok(description()?.includes('records:'),
      `sanity: the description must name the record filter before Close mEdit, or clearing it proves nothing (was: ${description() ?? 'unset'})`);

    await vscode.commands.executeCommand('modbench.closeMedit');

    assert.ok(!(description() ?? '').includes('records:'),
      'a session that no longer exists must not leave the view still claiming a record filter');
  });
});

// #354: exitToLoadout used to clear only the readout above, directly — never the context key the
// Clear title-bar action is gated on (`modbench.filterActive`), nor the code lens's own notion of
// which SQL is active. Both now go through the record filter's single writer (makeSetFilterActive),
// the same one every in-session filter change already goes through, so `modbench.filterActive`
// stays written from exactly one place.
//
// The context key itself is not asserted here: VS Code exposes no public API to read a context
// key's value from a test. What *is* observable is the code
// lens, because FilterCodeLensProvider is a genuinely registered `vscode.languages.CodeLensProvider`
// — `vscode.executeCodeLensProvider` exercises the real instance, not a private field. Proving the
// code lens clears on Close mEdit proves the single writer ran, and by that writer's own
// construction the context key cleared with it.
describe('Close mEdit clears the record filter\'s code lens too, not just the readout (#354)', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const pluginsTxtPath = root ? path.join(root, 'profiles', 'Default', 'plugins.txt') : '';
  // FilterCodeLensProvider only renders a lens for a document inside scriptsPath, and scriptsPath
  // is resolved once at activate() (config, or ~/.medit/scripts) — not reconfigurable per test the
  // way mods.gameDirectory is elsewhere in this file. setupScripts already creates and writes into
  // this real directory on every activation; this file is additive to it, kept in its own
  // mkdtempSync'd subdirectory (the file's own uniqueness idiom, used ten other places including
  // gameDir just below — atomic, unlike a hand-rolled Date.now() name, which two runs against the
  // same $HOME could collide on) so a leaked artifact (a crash between write and cleanup) reads as
  // this test's own rather than a mystery in a real product-facing folder. The provider gates on a
  // URI *prefix*, so a subdirectory under scriptsPath still matches, same as gameDir under a temp
  // root elsewhere in this file.
  const scriptsDir = path.join(os.homedir(), '.medit', 'scripts');
  const sql = 'SELECT form_key FROM "npc_"';
  let gameDir = '';
  let scriptsSubdir = '';
  let scriptsFile = '';

  const codeLensCommandFor = async (uri: vscode.Uri): Promise<string | undefined> => {
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri);
    return lenses?.[0]?.command?.command;
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
    await vscode.commands.executeCommand('modbench.modList.launchMedit');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(scriptsFile));
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('modbench.setFilterFromDocument');

    assert.strictEqual(await codeLensCommandFor(doc.uri), 'modbench.clearFilter',
      'sanity: the code lens must report the filter active before Close mEdit, or clearing it proves nothing');

    await vscode.commands.executeCommand('modbench.closeMedit');

    assert.strictEqual(await codeLensCommandFor(doc.uri), 'modbench.setFilterFromDocument',
      'a session that no longer exists must not leave the code lens still claiming its SQL is active');
  });
});

// #363: Filter to Selected Plugins — the ordinary record filter, pre-restricted to a plugin-name
// set drawn from the tree selection. The pure SQL builder's escaping/multi-plugin behavior is
// unit-tested (filterSelectedPluginsSql.test.ts) and the selection-extractor's dedupe/drop
// behavior is unit-tested (PluginListProvider.test.ts) without a VS Code harness; this suite
// proves only that a real VS Code dispatch — `(clicked, selected[])`, the actual
// `view/item/context` invocation shape — reaches the same POST /session/filter and readout every
// other filter entry point already goes through.
describe('modbench.pluginListTree.filterToSelected (#363)', () => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const pluginsTxtPath = root ? path.join(root, 'profiles', 'Default', 'plugins.txt') : '';
  const description = () =>
    (ext?.exports as { pluginListView?: { description?: string } } | undefined)?.pluginListView?.description;
  let gameDir = '';

  before(async () => {
    if (!root) return;
    resetMockBackend();
    gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'medit-filter-to-selected-'));
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', gameDir, vscode.ConfigurationTarget.Workspace);
    fs.writeFileSync(pluginsTxtPath, '*TestMod.esp\n');
    await vscode.commands.executeCommand('modbench.modList.launchMedit');
  });

  after(async () => {
    if (!root) return;
    await vscode.commands.executeCommand('modbench.closeMedit');
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', undefined, vscode.ConfigurationTarget.Workspace);
    fs.writeFileSync(pluginsTxtPath, '');
    fs.rmSync(gameDir, { recursive: true, force: true });
    resetMockBackend();
  });

  it('scopes the filter to a multi-row selection and names it in the readout', async () => {
    const a = new PluginListPluginNode({ name: 'TestMod.esp', path: '/data/TestMod.esp', enabled: true } as any);
    const b = new ImplicitMasterNode('Fallout4.esm');
    const before = requestLog.filter((l) => l === 'POST /session/filter').length;

    await vscode.commands.executeCommand('modbench.pluginListTree.filterToSelected', a, [a, b]);

    const after = requestLog.filter((l) => l === 'POST /session/filter').length;
    assert.strictEqual(after, before + 1, 'expected the command to reach POST /session/filter exactly once');
    assert.ok(description()?.includes('records: Selected Plugins'),
      `expected the readout to name the filter (was: ${description() ?? 'unset'})`);
  });

  it('is a no-op for a selection that names no plugin', async () => {
    const before = requestLog.filter((l) => l === 'POST /session/filter').length;

    await vscode.commands.executeCommand('modbench.pluginListTree.filterToSelected', undefined, []);

    const after = requestLog.filter((l) => l === 'POST /session/filter').length;
    assert.strictEqual(after, before, 'a selection with no plugin row must never reach the backend');
  });
});

// #295 AC5: Refresh (#247's single Mod-Management refresh) must remain distinct and never
// trigger a reload — a regression assertion, not new behavior; modbench.refresh's own body
// never touches enterEditing/loadExplicitSession.
describe('Refresh never triggers a session reload (#295 AC5)', () => {
  before(() => resetMockBackend());
  after(() => resetMockBackend());

  it('does not POST /session/load-explicit', async () => {
    await vscode.commands.executeCommand('modbench.refresh');

    assert.ok(
      !requestLog.some((l) => l === 'POST /session/load-explicit'),
      'modbench.refresh must never reload the editing session',
    );
  });
});

// ── #307 / ADR-0035: progressive load that states its own incompleteness ───────
// The trap this closes: an absent conflict badge is indistinguishable from "no conflict". If
// browsing opens at second five and the sweep lands at second ninety, an unmarked record silently
// claims to be conflict-free for eighty-five seconds when nothing has looked. So the load is not
// merely "shown sooner" — it says what it does not yet know.
//
// Every assertion here is about the window *during* the load POST, which is why the mock holds it
// open (holdLoadExplicit) rather than answering instantly like every other suite in this file.

/** Poll `read` until it returns a truthy value, or fail after `label`'s deadline. The tree reacts
 *  to a status poll on the backend's own 500ms cadence, so a fixed sleep would be either flaky or
 *  slow; same shape as the downloads watcher's own wait above. */
async function waitFor<T>(label: string, read: () => Promise<T> | T, timeoutMs = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('Progressive load states its own incompleteness (#307)', () => {
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
    fs.writeFileSync(pluginsTxtPath, '*TestMod.esp\n*Other.esp\n*MissingMaster.esp\n*Immutable.esm\n');
  });

  after(async () => {
    if (!root) return;
    await vscode.commands.executeCommand('modbench.closeMedit');
    await vscode.workspace.getConfiguration('modbench').update(
      'mods.gameDirectory', undefined, vscode.ConfigurationTarget.Workspace);
    fs.writeFileSync(pluginsTxtPath, '');
    fs.rmSync(gameDir, { recursive: true, force: true });
    resetMockBackend();
  });

  beforeEach(() => {
    resetMockBackend();
    holdLoadExplicit = true;
    pluginListProviderOf()?.invalidate();
  });

  afterEach(async () => {
    releaseLoadExplicit?.();
    await vscode.commands.executeCommand('modbench.closeMedit');
  });

  // AC1: rows gain chevrons as each plugin lands, not all at once at the end.
  it('makes a plugin expandable as soon as it is indexed, while a later one is still a leaf', async () => {
    setIndexed(['TestMod.esp']);
    const launch = vscode.commands.executeCommand('modbench.modList.launchMedit');

    await waitFor('TestMod.esp to gain a chevron mid-load', async () =>
      (await itemFor('TestMod.esp')).collapsibleState === vscode.TreeItemCollapsibleState.Collapsed);

    // The other half of the claim, and the one that makes it progressive rather than merely
    // early: a plugin the load has not reached yet stays a leaf. A row that expanded here would
    // fetch records for a plugin that is not queryable yet.
    assert.strictEqual(
      (await itemFor('Other.esp')).collapsibleState, vscode.TreeItemCollapsibleState.None,
      'Other.esp has not been indexed yet and must not be expandable',
    );

    setIndexed(['TestMod.esp', 'Other.esp']);
    await waitFor('Other.esp to gain a chevron once it lands', async () =>
      (await itemFor('Other.esp')).collapsibleState === vscode.TreeItemCollapsibleState.Collapsed);

    releaseLoadExplicit!();
    await launch;
  });

  // AC3 + AC5: the view says, in as many words, that conflict information is not yet computed —
  // and stops saying it the moment the sweep lands, with no user action. TreeView.message is the
  // native surface for exactly this (a view-scoped statement about the view's own contents), so
  // there is no banner row and no bespoke widget.
  it('states that conflict information is not yet computed, then clears that once the sweep lands', async () => {
    setIndexed(['TestMod.esp']);
    const launch = vscode.commands.executeCommand('modbench.modList.launchMedit');

    const message = await waitFor('the view to state its own incompleteness', () =>
      (ext?.exports as { pluginListView?: { message?: string } } | undefined)?.pluginListView?.message);
    assert.match(message, /conflict information is not yet computed/i);

    // The sweep is the last thing a real load does, so it lands with the POST's own answer.
    sessionStatus = { ...sessionStatus, conflictsComputed: true };
    releaseLoadExplicit!();
    await launch;

    assert.strictEqual(
      (ext?.exports as { pluginListView?: { message?: string } } | undefined)?.pluginListView?.message,
      undefined,
      'the incompleteness statement must clear itself once conflicts are computed',
    );
  });

  // #364 inherits #307's own invariant: the Conflicts node is exactly as absent-until-computed as
  // the incompleteness message above — same conflictsComputed transition, a different surface.
  it('#364: the Conflicts node is absent from the root listing before conflictsComputed, prepended once it lands', async () => {
    setIndexed(['TestMod.esp']);
    const launch = vscode.commands.executeCommand('modbench.modList.launchMedit');

    await waitFor('TestMod.esp to gain a chevron mid-load', async () =>
      (await itemFor('TestMod.esp')).collapsibleState === vscode.TreeItemCollapsibleState.Collapsed);

    const midLoadRows = await pluginsTree()!.getChildren();
    assert.ok(
      !midLoadRows.some((r) => (r as { contextValue?: string }).contextValue === 'conflicts'),
      'the Conflicts node must not appear before conflictsComputed lands',
    );

    mockConflicts = [{
      record: {
        formKey: '000801:TestMod.esp', plugin: 'TestMod.esp', origin: 'Data',
        loadOrderIndex: 0, isWinner: true, editorId: 'Foo', workingTreeState: 'None',
      },
      conflictAll: 'Conflict',
    }];
    sessionStatus = { ...sessionStatus, conflictsComputed: true };
    releaseLoadExplicit!();
    await launch;

    const rootRows = await waitFor('the Conflicts node to appear once conflicts are computed', async () => {
      const rows = await pluginsTree()!.getChildren();
      return rows.some((r) => (r as { contextValue?: string }).contextValue === 'conflicts') ? rows : undefined;
    });
    assert.strictEqual(
      (rootRows[0] as { contextValue?: string }).contextValue, 'conflicts',
      'the Conflicts node must be prepended ahead of every plugin row, not merely present somewhere',
    );
  });

  // AC6: a per-plugin failure surfaces when it occurs, not only at the end of the load.
  it('decorates a plugin that failed to load the moment it is reported, not at the end', async () => {
    setIndexed(['TestMod.esp'], { failures: [{ name: 'Other.esp', reason: 'RACE parse' }] });
    const launch = vscode.commands.executeCommand('modbench.modList.launchMedit');

    const item = await waitFor('Other.esp to be decorated with its load failure mid-load', async () => {
      const candidate = await itemFor('Other.esp');
      return candidate.description === '✗ Failed to load' ? candidate : undefined;
    });

    assert.ok(typeof item.tooltip === 'string' && item.tooltip.includes('RACE parse'),
      `expected the failure reason in the tooltip, got: ${String(item.tooltip)}`);

    releaseLoadExplicit!();
    await launch;
  });

  // AC7: closing the session mid-load is a deliberate abandonment, not a failure. The polling
  // stops, the chevrons and the message go, and nothing is reported as broken — the user asked
  // for exactly this. (The "no error toast" half is asserted at the SessionController seam, where
  // the reporter is injectable; here we assert the observable consequences in a live window.)
  it('stops polling and clears the view when the session is closed mid-load', async () => {
    setIndexed(['TestMod.esp']);
    const launch = vscode.commands.executeCommand('modbench.modList.launchMedit');
    await waitFor('the load to be under way, polling and rendering', async () =>
      (await itemFor('TestMod.esp')).collapsibleState === vscode.TreeItemCollapsibleState.Collapsed);

    await vscode.commands.executeCommand('modbench.closeMedit');
    // The abandoned load resolves on its own — the abort reaches the in-flight POST rather than
    // leaving it to wait for a socket that will never answer.
    await launch;
    const pollsAtClose = requestLog.filter((l) => l === 'GET /session/status').length;
    assert.ok(pollsAtClose > 0, 'the load should have been polling before it was abandoned');

    await new Promise((r) => setTimeout(r, 1500)); // three poll intervals

    assert.strictEqual(
      requestLog.filter((l) => l === 'GET /session/status').length, pollsAtClose,
      'closing the session must stop the polling, not leave it running against a dead backend',
    );
    assert.strictEqual(
      (await itemFor('TestMod.esp')).collapsibleState, vscode.TreeItemCollapsibleState.None,
      'the chevrons must go with the session',
    );
    assert.strictEqual(
      (ext?.exports as { pluginListView?: { message?: string } } | undefined)?.pluginListView?.message,
      undefined,
      'the view must stop claiming a load that is no longer running',
    );
  });

  // AC7, the *earlier* window. A launch has two phases: bring the backend up and walk the mod
  // tree, then load. The test above closes during the second. This one closes during the first —
  // before the load POST exists at all — because AC7 says "closing the session mid-load" with no
  // qualification by phase, and backend spawn plus a filesystem walk is a realistic window to
  // land in. Without the abort being armed before the first await, the stale launch runs on past
  // the close, finds the backend it just stopped, and reports "Backend failed to start" — an
  // error raised for something the user deliberately did.
  it('raises no error when the session is closed before the backend is even up', async () => {
    holdHealth = true;
    const errors: string[] = [];
    const realShowError = vscode.window.showErrorMessage;
    // The test and the extension share one vscode module instance in the extension host, so this
    // is the only way to observe a toast — there is no API to read notifications back.
    (vscode.window as { showErrorMessage: unknown }).showErrorMessage =
      (message: string) => { errors.push(message); return Promise.resolve(undefined); };
    try {
      const launch = vscode.commands.executeCommand('modbench.modList.launchMedit');
      await waitFor('the launch to reach the backend health probe', () =>
        requestLog.some((l) => l === 'GET /health'));

      await vscode.commands.executeCommand('modbench.closeMedit');
      releaseHealth?.();
      await launch;

      assert.deepStrictEqual(errors, [], 'a deliberately abandoned launch must raise no error');
      assert.ok(
        !requestLog.some((l) => l === 'POST /session/load-explicit'),
        'an abandoned launch must not go on to load a session the user has closed',
      );
    } finally {
      (vscode.window as { showErrorMessage: unknown }).showErrorMessage = realShowError;
    }
  });

  // AC9: master issues are derived from the whole session, so mid-load they would flag masters
  // that simply have not been opened yet. The backend already suppresses them while loading
  // (RecordQueryService.GetPlugins gates Classify on SessionState.Ready) and the frontend never
  // asks for them mid-load — this asserts the suppression is honoured end to end, and, just as
  // importantly, that it lifts by itself once the load completes.
  it('leaves master issues off the rows until the load completes, then decorates them with no user action', async () => {
    setIndexed(['TestMod.esp', 'MissingMaster.esp']);
    const launch = vscode.commands.executeCommand('modbench.modList.launchMedit');

    await waitFor('MissingMaster.esp to gain a chevron mid-load', async () =>
      (await itemFor('MissingMaster.esp')).collapsibleState === vscode.TreeItemCollapsibleState.Collapsed);
    const midLoad = await itemFor('MissingMaster.esp');
    assert.ok(
      !(typeof midLoad.tooltip === 'string' && midLoad.tooltip.includes('Missing master: Ghost.esm')),
      `master issues must not be decorated mid-load, got: ${String(midLoad.tooltip)}`,
    );

    releaseLoadExplicit!();
    await launch;

    const loaded = await itemFor('MissingMaster.esp');
    assert.ok(typeof loaded.tooltip === 'string' && loaded.tooltip.includes('Missing master: Ghost.esm'),
      `expected the missing-master tooltip once the load completed, got: ${String(loaded.tooltip)}`);
    // The other half of the same payload, and the trap this closes: a progressive tick carries
    // empty readOnly/masterIssues, so if a tick were ever allowed to be the *last* setSession
    // call, both these decorations would silently vanish from a fully loaded tree. Asserting one
    // of each proves the completion hand-off still runs, whole, after the last tick.
    const immutable = await itemFor('Immutable.esm');
    assert.ok(typeof immutable.tooltip === 'string' && immutable.tooltip.includes('read-only'),
      `expected the read-only note once the load completed, got: ${String(immutable.tooltip)}`);
    // #342: Immutable.esm never appeared in any progress tick's indexedPlugins — its chevron can
    // only come from the completion hand-off's own `session.files`. The tooltip check above proves
    // the readOnly/masterIssues half of that payload landed; without this, a hand-off that applied
    // readOnly/masterIssues but silently dropped (or never reached) the chevron-bearing file set
    // would pass this test while leaving the row exactly as #342 found it: no chevron, unexpandable.
    assert.strictEqual(
      immutable.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed,
      'Immutable.esm was indexed but never named in a progress tick — its chevron must still come from the completion hand-off',
    );
  });
});

// #534: pickCopyDestination (behind both copy commands) opens with an unguarded
// repository.getPlugins() — a rejection there escaped the command callback as VS Code's raw
// "fetch failed" toast rather than a Modbench-authored one. The real exposure window is the
// backend dying *after* the copy surfaces (record row / record-header context menu) have
// rendered — those are only reachable with a live session, so the pre-launch repro this test
// actually drives is not itself reachable through the UI (established by #530's triage). It
// stands in for that real window on purpose: `resetMockBackend()` below leaves the mock
// session-less, so GET /plugins answers its existing 503 "No session loaded" — a rejection out
// of the exact same unguarded `pickCopyDestination` awaits a post-load backend death would
// produce. The fix's catch is deliberately untargeted (any rejection out of the
// destination-picking step, not just a transport failure), so this stand-in exercises the same
// code path as the literal scenario without needing new mock machinery to simulate a mid-session
// crash.
describe('Copy destination picking degrades to a reported error, never an uncaught rejection (#534)', () => {
  // A record-editor column header's own data-vscode-context payload (ColumnHeaderContext) —
  // always carries `origin`, so runCopyRecordCommand's origin-resolution step short-circuits
  // with no HTTP call, and pickCopyDestination's getPlugins() is the first thing to reach the
  // (refusing) backend. A plugins-tree RecordNode would work identically; the header is picked
  // because it is the shape most immediately in hand with no tree lookup.
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
        // The assertion this bug is about: an escaped rejection out of the command callback
        // fails executeCommand's own returned promise. Awaiting it with no try/catch is the
        // point — a raw rejection here fails the test on its own, with no assertion needed.
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
