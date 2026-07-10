import * as assert from 'assert';
import * as http from 'http';
import * as vscode from 'vscode';
import { before, after, describe, it } from 'mocha';

const TEST_PORT = 15172;
let mockBackend: http.Server;
let ext: vscode.Extension<unknown> | undefined;

function createMockBackend(): http.Server {
  return http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.url === '/plugins') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

// Start a mock backend that answers GET /health → 200 and GET /plugins → []
// so the extension activates in 'attached' state. Uses port 15172 (set via workspace settings).
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
    'modbench.closeMedit',
    'modbench.reloadSession',
    'modbench.refreshTree',
    'modbench.newPlugin',
    'modbench.copyAsOverrideInto',
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
    'modbench.downloads.open',
    'modbench.pluginListTree.refresh',
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
