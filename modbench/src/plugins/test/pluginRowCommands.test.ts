import { describe, it, expect, vi, beforeEach } from 'vitest';

// Captures every registerCommand(id, handler) so each row's handler can be invoked directly —
// the same idiom recordPanelContextCommands.test.ts already establishes.
const {
  handlers, registerCommand, showQuickPick, withProgress, executeCommand,
} = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void> | void>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    showQuickPick: vi.fn(),
    withProgress: vi.fn((_options: unknown, work: () => Promise<unknown>) => work()),
    executeCommand: vi.fn().mockResolvedValue(undefined),
  };
});

// Every one of this file's own vscode needs, real fakes rather than this file's own stubs.
import {
  TreeItem, ThemeIcon, ThemeColor, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState,
  Diagnostic, DiagnosticSeverity, Range, uriFile,
} from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  commands: { registerCommand, executeCommand },
  window: { showQuickPick, withProgress },
  TreeItem, ThemeIcon, ThemeColor, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState,
  Diagnostic, DiagnosticSeverity, Range,
  Uri: { file: uriFile },
}));

import {
  registerTrackCommand, registerCompileCommand, publishCompileDiagnostics, type PluginsViewProgress,
} from '../pluginRowCommands';
import { originFiles } from '../../instanceLoader/loadOrderSnapshot';
import { InMemoryMEditClient } from '../../client';
import { PluginNode } from '../PluginsTreeProvider';
import { PluginTreeProvider } from '../PluginTreeProvider';
import { recordingReporter, scriptedDialog } from '../../test/surfacingDoubles';
import { FakeLogOutputChannel } from '../../test/fakeOutputChannel';
import { FakeDiagnosticCollection } from '../../test/vscodeMock';
import { pluginMetadataFixture, compiledPluginFixture } from '../../client/test/fixtures';
import { present } from '../../ports/present';

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

function pluginNode(name = 'MyMod.esp'): PluginNode {
  return new PluginNode({ name, enabled: true });
}

function clientWithOrigin(name: string, origin: string): InMemoryMEditClient {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getPlugins', [pluginMetadataFixture({ name, origin, inLoadOrder: true })]);
  return client;
}

// ── registerTrackCommand ──────────────────────────────────────────────────

describe('registerTrackCommand', () => {
  function invokeTrack(
    client: InMemoryMEditClient, onTracked = vi.fn().mockResolvedValue(undefined),
    viewSelection: () => readonly PluginNode[] = () => [],
  ) {
    const said: (string | undefined)[] = [];
    const progress: PluginsViewProgress = { while: (work) => work(), say: (message) => said.push(message) };
    const reporter = recordingReporter();
    const treeProvider = new PluginTreeProvider(client);
    const refresh = vi.spyOn(treeProvider, 'refresh').mockImplementation(() => { /* no-op */ });
    registerTrackCommand(progress, client, new FakeLogOutputChannel(), reporter, treeProvider, onTracked, viewSelection);
    return {
      handler: present(handlers.get('modbench.plugin.track'), 'the track command registerTrackCommand registers'),
      onTracked, reporter, refresh, said,
    };
  }

  it('tracks the right-clicked plugin alone, refreshes the tree and lands the tracked toast', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    const plugin = { name: 'MyMod.esp', origin: 'ModA' };
    client.setCommandResult('track', { landed: [plugin], refused: [] });
    showQuickPick.mockResolvedValue({ label: 'Edits' });
    const { handler, onTracked, reporter, refresh } = invokeTrack(client);

    await handler(pluginNode());

    expect(client.calls).toContainEqual({ method: 'track', args: [[plugin], 'Edits', expect.anything()] });
    expect(refresh).toHaveBeenCalledOnce();
    expect(reporter.landings).toEqual(['Tracked "MyMod.esp".']);
    expect(reporter.reports).toEqual([]);
    expect(onTracked).toHaveBeenCalledOnce();
  });

  // commands.md, "A selection is one gesture": one call with the whole selection, asked once, and
  // one notification naming each refused plugin and why.
  it('tracks the whole selection in one call, asks the preset once, and reports each refused plugin once while the rest land', async () => {
    const client = new InMemoryMEditClient();
    const first = { name: 'First.esp', origin: 'ModA' };
    const second = { name: 'Second.esp', origin: 'ModB' };
    const outcome = { landed: [first], refused: [{ item: second, reason: 'Second.esp does not round-trip.' }] };
    client.setCommandResult('track', outcome);
    showQuickPick.mockResolvedValue({ label: 'Everything' });
    const { handler, onTracked, reporter, refresh } = invokeTrack(client);
    const nodes = [new PluginNode({ name: 'First.esp', enabled: true }, 'ModA'), new PluginNode({ name: 'Second.esp', enabled: true }, 'ModB')];

    await handler(nodes[0], nodes);

    expect(showQuickPick).toHaveBeenCalledOnce();
    expect(client.calls.filter((c) => c.method === 'track')).toEqual([
      { method: 'track', args: [[first, second], 'Everything', expect.anything()] },
    ]);
    expect(reporter.selectionOutcomeCalls).toEqual([{ message: 'Could not track 1 of 2 plugins.', outcome }]);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not track 1 of 2 plugins.', detail: '"Second.esp (ModB)" (Second.esp does not round-trip.)' },
    ]);
    expect(reporter.landings).toEqual([]);
    expect(refresh).toHaveBeenCalledOnce();
    expect(onTracked).toHaveBeenCalledOnce();
  });

  // The rival: landing the toast and refreshing on a refusal too would tell the user a track
  // landed when the backend refused the whole selection.
  it('reports the ready-to-show message at error and refreshes nothing when the backend refuses the whole selection', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    client.setCommandResult('track', { refused: true, message: 'Could not track 1 plugin — git was not found on PATH.' });
    showQuickPick.mockResolvedValue({ label: 'Edits' });
    const { handler, onTracked, reporter, refresh } = invokeTrack(client);

    await handler(pluginNode());

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not track 1 plugin — git was not found on PATH.', detail: undefined },
    ]);
    expect(reporter.landings).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
    expect(onTracked).not.toHaveBeenCalled();
  });

  it('refuses a plugin whose mod cannot be resolved, naming it, and never asks what the .gitignore should hold', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', []);
    const { handler, reporter } = invokeTrack(client);

    await handler(pluginNode());

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not track 1 of 1 plugins.', detail: '"MyMod.esp" (its mod could not be resolved)' },
    ]);
    // ADR-0012: the row's own identity, with no origin invented for it.
    expect(reporter.selectionOutcomeCalls.map((call) => call.outcome.refused.map((r) => r.item))).toEqual([[{ name: 'MyMod.esp' }]]);
    expect(showQuickPick).not.toHaveBeenCalled();
    expect(client.calls.filter((c) => c.method === 'track')).toEqual([]);
  });

  // The palette hands the command no row: it falls back to the view's own selection, the same
  // as every other plural gesture the entry builds.
  it('falls back to the view selection from the palette, where no row is right-clicked', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    const plugin = { name: 'MyMod.esp', origin: 'ModA' };
    client.setCommandResult('track', { landed: [plugin], refused: [] });
    showQuickPick.mockResolvedValue({ label: 'Edits' });
    const { handler, reporter } = invokeTrack(client, undefined, () => [pluginNode()]);

    await handler();

    expect(client.calls).toContainEqual({ method: 'track', args: [[plugin], 'Edits', expect.anything()] });
    expect(reporter.landings).toEqual(['Tracked "MyMod.esp".']);
  });
});

// ── modbench.plugin.compile ────────────────────────────────────────────────

describe('modbench.plugin.compile', () => {
  const PATCH = { name: 'MyPatch.esp', origin: 'ModA' };
  const OTHER = { name: 'Other.esp', origin: 'ModB' };
  const PATCH_FILES = originFiles(
    [{ path: '/instance/mods/ModA/MyPatch.esp', origin: 'ModA' }], 'ModA');

  function row(plugin: { name: string; origin: string }, contextValue = 'plugin enabled inMod tracked editable'): PluginNode {
    const node = new PluginNode({ name: plugin.name, enabled: true }, plugin.origin);
    node.contextValue = contextValue;
    return node;
  }

  function registered(client: InMemoryMEditClient, options: { answers?: (string | undefined)[]; viewSelection?: readonly PluginNode[] } = {}) {
    const reporter = recordingReporter();
    const ask = scriptedDialog(...(options.answers ?? []));
    const diagnostics = new FakeDiagnosticCollection();
    const progress = { running: false, runs: 0 };
    const compiledWhileRunning: boolean[] = [];
    client.setQueryAnswer('getPlugins', [
      pluginMetadataFixture({ name: PATCH.name, origin: PATCH.origin, isTracked: true, isImmutable: false, inLoadOrder: true }),
      pluginMetadataFixture({ name: OTHER.name, origin: OTHER.origin, isTracked: true, isImmutable: false, inLoadOrder: true }),
      pluginMetadataFixture({ name: 'Untracked.esp', origin: 'ModC', isTracked: false, isImmutable: false, inLoadOrder: true }),
      pluginMetadataFixture({ name: 'ReadOnly.esp', origin: 'ModD', isTracked: true, isImmutable: true, inLoadOrder: true }),
    ]);
    registerCompileCommand({
      client: {
        getPlugins: () => client.getPlugins(),
        compile: (plugins, source) => {
          compiledWhileRunning.push(progress.running);
          return client.compile(plugins, source);
        },
      },
      progress: {
        while: async (work) => {
          progress.running = true;
          progress.runs++;
          try { await work(); } finally { progress.running = false; }
        },
        say: () => { /* compile says nothing in the message line */ },
      },
      reporter, ask, diagnostics,
      originFiles: (origin) => (origin === 'ModA' ? PATCH_FILES : undefined),
      log: () => { /* resolveOrigin's log */ },
    }, () => options.viewSelection ?? []);
    return {
      handler: present(handlers.get('modbench.plugin.compile'), 'the compile command registerCompileCommand registers'),
      reporter, ask, diagnostics, progress, compiledWhileRunning,
    };
  }

  const compileCalls = (client: InMemoryMEditClient) => client.calls.filter((c) => c.method === 'compile').map((c) => c.args);

  it('compiles the right-clicked plugin from the working tree without asking, under the view\'s progress bar, and lands once', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('compile', { landed: [compiledPluginFixture({ plugin: PATCH })], refused: [] });
    const { handler, reporter, ask, progress, compiledWhileRunning } = registered(client);

    await handler(row(PATCH));

    expect(ask.asked).toEqual([]);
    expect(compileCalls(client)).toEqual([[[PATCH], 'workingTree']]);
    expect(compiledWhileRunning).toEqual([true]);
    expect(progress.runs).toBe(1);
    expect(reporter.landings).toEqual(['Compiled "MyPatch.esp".']);
    expect(reporter.reports).toEqual([]);
  });

  it('compiles the whole selection in one call, and one notification names each refused plugin and why', async () => {
    const client = new InMemoryMEditClient();
    const refusal = 'Other.esp is not tracked, so there is no source to compile.';
    client.setCommandResult('compile', {
      landed: [compiledPluginFixture({ plugin: PATCH })], refused: [{ item: OTHER, reason: refusal }],
    });
    const { handler, reporter } = registered(client);
    const rows = [row(PATCH), row(OTHER)];

    await handler(rows[0], rows);

    expect(compileCalls(client)).toEqual([[[PATCH, OTHER], 'workingTree']]);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not compile 1 of 2 plugins.', detail: `"Other.esp (ModB)" (${refusal})` },
    ]);
    expect(reporter.landings).toEqual([]);
  });

  it('lands several compiled plugins in one notification', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('compile', {
      landed: [compiledPluginFixture({ plugin: PATCH }), compiledPluginFixture({ plugin: OTHER })], refused: [],
    });
    const { handler, reporter } = registered(client);
    const rows = [row(PATCH), row(OTHER)];

    await handler(rows[1], rows);

    expect(reporter.landings).toEqual(['Compiled 2 plugins.']);
  });

  it('points at the Problems panel when the compile left diagnostics, and puts them on the source files', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('compile', {
      landed: [compiledPluginFixture({
        plugin: PATCH,
        diagnostics: [{ formKey: '000800:MyPatch.esp', sourceRelativePath: 'Source/A.json', message: 'Race: points at nothing' }],
      })],
      refused: [],
    });
    const { handler, reporter, diagnostics } = registered(client);

    await handler(row(PATCH));

    expect(reporter.landings).toEqual(['Compiled "MyPatch.esp" with 1 diagnostic. See the Problems panel.']);
    expect([...diagnostics].map(([uri, list]) => [uri.fsPath, list.map((d) => d.message)])).toEqual([
      ['/instance/mods/ModA/Source/A.json', ['Race: points at nothing']],
    ]);
  });

  it('points at the Problems panel from the refusal notification when the plugins that compiled left diagnostics', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('compile', {
      landed: [compiledPluginFixture({
        plugin: PATCH,
        diagnostics: [
          { formKey: '000800:MyPatch.esp', sourceRelativePath: 'Source/A.json', message: 'Race: points at nothing' },
          { formKey: '000801:MyPatch.esp', sourceRelativePath: 'Source/B.json', message: 'Race: points at nothing' },
        ],
      })],
      refused: [{ item: OTHER, reason: 'no source' }],
    });
    const { handler, reporter } = registered(client);
    const rows = [row(PATCH), row(OTHER)];

    await handler(rows[0], rows);

    expect(reporter.reports).toEqual([{
      severity: 'error',
      message: 'Could not compile 1 of 2 plugins. The rest compiled with 2 diagnostics. See the Problems panel.',
      detail: '"Other.esp (ModB)" (no source)',
    }]);
  });

  it('reports a refusal of the whole selection once, and lands nothing', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('compile', { refused: true, message: 'Could not compile 1 plugin — No load order has been received.' });
    const { handler, reporter } = registered(client);

    await handler(row(PATCH));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not compile 1 plugin — No load order has been received.', detail: undefined },
    ]);
    expect(reporter.landings).toEqual([]);
  });

  it('from main, confirms first, saying the edit branch and working tree stay as they are, then compiles from main', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('compile', { landed: [compiledPluginFixture({ plugin: PATCH })], refused: [] });
    const { handler, reporter, ask } = registered(client, { answers: ['Compile from main'] });
    const clicked = row(PATCH);

    await handler(clicked, [clicked], { source: 'main' });

    expect(ask.asked).toEqual([{
      message: 'Compile "MyPatch.esp" from main?',
      detail: 'Its binary is written from what main holds. Your edit branch and your working tree stay as they are.',
      buttons: ['Compile from main'],
    }]);
    expect(compileCalls(client)).toEqual([[[PATCH], 'main']]);
    expect(reporter.landings).toEqual(['Compiled "MyPatch.esp" from main.']);
  });

  it('from main over a selection, confirms once, naming how many', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('compile', { landed: [], refused: [] });
    const { handler, ask } = registered(client, { answers: [undefined] });
    const rows = [row(PATCH), row(OTHER)];

    await handler(rows[0], rows, { source: 'main' });

    expect(ask.asked.map((q) => q.message)).toEqual(['Compile 2 plugins from main?']);
  });

  it('compiles nothing and says nothing when the main confirmation is dismissed', async () => {
    const client = new InMemoryMEditClient();
    const { handler, reporter, ask, progress } = registered(client, { answers: [undefined] });
    const clicked = row(PATCH);

    await handler(clicked, [clicked], { source: 'main' });

    expect(ask.asked).toHaveLength(1);
    expect(compileCalls(client)).toEqual([]);
    expect(progress.runs).toBe(0);
    expect(reporter.reports).toEqual([]);
    expect(reporter.landings).toEqual([]);
  });

  it('compiles the plugin a record tab\'s column header names, at its own origin, from the working tree', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('compile', { landed: [compiledPluginFixture({ plugin: OTHER })], refused: [] });
    const { handler, ask } = registered(client, { viewSelection: [row(PATCH)] });

    await handler({
      webviewSection: 'recordHeader', formKey: '000801:Other.esp', plugin: 'Other.esp', origin: 'ModB',
      compilable: true, preventDefaultContextMenuItems: true,
    });

    expect(ask.asked).toEqual([]);
    expect(compileCalls(client)).toEqual([[[OTHER], 'workingTree']]);
  });

  it('from the palette, picks among only the tracked, editable plugins, the selected one first, and compiles the pick', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('compile', { landed: [compiledPluginFixture({ plugin: OTHER })], refused: [] });
    showQuickPick.mockResolvedValue({ label: 'Other.esp', description: 'ModB' });
    const { handler } = registered(client, { viewSelection: [row(OTHER)] });

    await handler();

    expect(showQuickPick).toHaveBeenCalledWith(
      [{ label: 'Other.esp', description: 'ModB' }, { label: 'MyPatch.esp', description: 'ModA' }],
      { placeHolder: 'Compile which plugin?' });
    expect(compileCalls(client)).toEqual([[[OTHER], 'workingTree']]);
  });

  it('from the palette, compiles nothing when the pick is dismissed', async () => {
    const client = new InMemoryMEditClient();
    showQuickPick.mockResolvedValue(undefined);
    const { handler, reporter } = registered(client);

    await handler();

    expect(compileCalls(client)).toEqual([]);
    expect(reporter.reports).toEqual([]);
  });

  it('refuses a selected plugin whose mod cannot be resolved, naming it, while the others compile', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('compile', { landed: [compiledPluginFixture({ plugin: PATCH })], refused: [] });
    const { handler, reporter } = registered(client);
    const unresolved = new PluginNode({ name: 'Nowhere.esp', enabled: true });
    const rows = [row(PATCH), unresolved];

    await handler(rows[0], rows);

    expect(compileCalls(client)).toEqual([[[PATCH], 'workingTree']]);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not compile 1 of 2 plugins.', detail: '"Nowhere.esp" (its mod could not be resolved)' },
    ]);
  });
});

// ── publishCompileDiagnostics ──────────────────────────────────────────────

describe('publishCompileDiagnostics', () => {
  const diagnosticAt = (sourceRelativePath: string) => [{ formKey: '000000:MyPatch.esp', sourceRelativePath, message: 'bad' }];

  const publishedPaths = (diagnostics: FakeDiagnosticCollection) => [...diagnostics].map(([uri]) => uri.fsPath);

  it('targets the folder the value gave for the origin, overwrite included', () => {
    const diagnostics = new FakeDiagnosticCollection();
    const plugin = { name: 'Stray.esp', path: '/instance/overwrite/Stray.esp', origin: 'overwrite', slot: null, enabled: false, winning: true };

    publishCompileDiagnostics(diagnostics, originFiles([plugin], 'overwrite'), diagnosticAt('Source/Stray.psc'));

    expect(publishedPaths(diagnostics)).toEqual(['/instance/overwrite/Source/Stray.psc']);
  });

  it("replaces the entries the origin's folder holds, and leaves every other folder's", () => {
    const diagnostics = new FakeDiagnosticCollection();
    const plugins = [
      { name: 'A.esp', path: '/instance/mods/ModA/A.esp', origin: 'ModA', slot: 0, enabled: true, winning: true },
      { name: 'B.esp', path: '/instance/mods/ModB/B.esp', origin: 'ModB', slot: 1, enabled: true, winning: true },
    ];
    publishCompileDiagnostics(diagnostics, originFiles(plugins, 'ModA'), diagnosticAt('Source/Old.psc'));
    publishCompileDiagnostics(diagnostics, originFiles(plugins, 'ModB'), diagnosticAt('Source/Other.psc'));

    publishCompileDiagnostics(diagnostics, originFiles(plugins, 'ModA'), diagnosticAt('Source/A.psc'));

    expect(publishedPaths(diagnostics)).toEqual(['/instance/mods/ModB/Source/Other.psc', '/instance/mods/ModA/Source/A.psc']);
  });

  it('publishes nothing when the value knows no folder for the origin', () => {
    const diagnostics = new FakeDiagnosticCollection();

    publishCompileDiagnostics(diagnostics, undefined, diagnosticAt('Source/A.psc'));

    expect(publishedPaths(diagnostics)).toEqual([]);
  });
});
