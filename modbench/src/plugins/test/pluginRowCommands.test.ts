import { describe, it, expect, vi, beforeEach } from 'vitest';

// Captures every registerCommand(id, handler) so each row's handler can be invoked directly —
// the same idiom recordPanelContextCommands.test.ts already establishes.
const {
  handlers, registerCommand, showQuickPick, createQuickPick, withProgress, executeCommand,
} = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void> | void>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    showQuickPick: vi.fn<
      (items: readonly { label: string; description?: string }[], options?: unknown) =>
        Promise<{ label: string; description?: string } | undefined>
    >(),
    createQuickPick: vi.fn(),
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
  window: { showQuickPick, createQuickPick, withProgress },
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
import { recordingReporter } from '../../test/surfacingDoubles';
import { FakeLogOutputChannel } from '../../test/fakeOutputChannel';
import { FakeDiagnosticCollection } from '../../test/vscodeMock';
import { pluginMetadataFixture, compiledPluginFixture } from '../../client/test/fixtures';
import { present } from '../../ports/present';

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

function pluginNode(name = 'MyMod.esp'): PluginNode {
  return new PluginNode({ name, enabled: true }, 'ModA');
}

function clientWithOrigin(name: string, origin: string): InMemoryMEditClient {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getPlugins', [pluginMetadataFixture({ name, origin, inLoadOrder: true })]);
  return client;
}

type PresetItem = { label: 'Edits' | 'Everything'; description?: string };

// plugins.md, Track, story 2, in the QuickPick items' own words (plugins.md, Track, story 1:
// "each with a line saying what it keeps").
const EDITS_ITEM: PresetItem = { label: 'Edits', description: 'Keeps source/ and .gitignore' };
const EVERYTHING_ITEM: PresetItem = { label: 'Everything', description: 'Keeps every file except the plugin binaries' };

// Stands in for vscode.QuickPick with no VS Code host: listener registries the test triggers
// directly, matching DownloadsPanel.test.ts's own fake.
function makeFakeQuickPick() {
  const acceptListeners: Array<() => void> = [];
  const hideListeners: Array<() => void> = [];
  const qp = {
    items: [] as PresetItem[],
    placeholder: undefined as string | undefined,
    activeItems: [] as PresetItem[],
    selectedItems: [] as PresetItem[],
    show: vi.fn(),
    hide: vi.fn(() => { hideListeners.forEach((cb) => cb()); }),
    dispose: vi.fn(),
    onDidAccept: (cb: () => void) => { acceptListeners.push(cb); return { dispose: () => {} }; },
    onDidHide: (cb: () => void) => { hideListeners.push(cb); return { dispose: () => {} }; },
  };
  return {
    qp,
    accept: (picked: PresetItem) => { qp.selectedItems = [picked]; acceptListeners.forEach((cb) => cb()); },
    escape: () => { hideListeners.forEach((cb) => cb()); },
  };
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
    registerTrackCommand(progress, client, reporter, onTracked, viewSelection);
    return {
      handler: present(handlers.get('modbench.plugin.track'), 'the track command registerTrackCommand registers'),
      onTracked, reporter, said,
    };
  }

  // Runs `handler(...)` and settles the preset pick it opens once `createQuickPick` has been
  // called, so the QuickPick's own async wiring (onDidAccept/onDidHide) has a chance to attach.
  async function runTrackedWithPreset(
    handler: (...args: unknown[]) => unknown, picked: PresetItem | undefined, ...args: unknown[]
  ): Promise<ReturnType<typeof makeFakeQuickPick>['qp']> {
    const { qp, accept, escape } = makeFakeQuickPick();
    createQuickPick.mockReturnValue(qp);
    const pending = handler(...args);
    await vi.waitFor(() => expect(createQuickPick).toHaveBeenCalled());
    if (picked) accept(picked); else escape();
    await pending;
    return qp;
  }

  it('tracks the right-clicked plugin alone and lands the tracked toast', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    const plugin = { name: 'MyMod.esp', origin: 'ModA' };
    client.setCommandResult('track', { landed: [plugin], refused: [] });
    const { handler, onTracked, reporter } = invokeTrack(client);

    await runTrackedWithPreset(handler, EDITS_ITEM, pluginNode());

    expect(client.calls).toContainEqual({ method: 'track', args: [[plugin], 'Edits', expect.anything()] });
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
    const { handler, onTracked, reporter } = invokeTrack(client);
    const nodes = [new PluginNode({ name: 'First.esp', enabled: true }, 'ModA'), new PluginNode({ name: 'Second.esp', enabled: true }, 'ModB')];

    await runTrackedWithPreset(handler, EVERYTHING_ITEM, nodes[0], nodes);

    expect(createQuickPick).toHaveBeenCalledOnce();
    expect(client.calls.filter((c) => c.method === 'track')).toEqual([
      { method: 'track', args: [[first, second], 'Everything', expect.anything()] },
    ]);
    expect(reporter.selectionOutcomeCalls).toEqual([{ message: 'Could not track 1 of 2 plugins.', outcome }]);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not track 1 of 2 plugins.', detail: '"Second.esp (ModB)" (Second.esp does not round-trip.)' },
    ]);
    expect(reporter.landings).toEqual([]);
    expect(onTracked).toHaveBeenCalledOnce();
  });

  // The rival: landing the toast on a refusal too would tell the user a track landed when the
  // backend refused the whole selection.
  it('reports the ready-to-show message at error when the backend refuses the whole selection', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    client.setCommandResult('track', { refused: true, message: 'Could not track 1 plugin — git was not found on PATH.' });
    const { handler, onTracked, reporter } = invokeTrack(client);

    await runTrackedWithPreset(handler, EDITS_ITEM, pluginNode());

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not track 1 plugin — git was not found on PATH.', detail: undefined },
    ]);
    expect(reporter.landings).toEqual([]);
    expect(onTracked).not.toHaveBeenCalled();
  });

  // The palette hands the command no row: it falls back to the view's own selection, the same
  // as every other plural gesture the entry builds.
  it('falls back to the view selection from the palette, where no row is right-clicked', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    const plugin = { name: 'MyMod.esp', origin: 'ModA' };
    client.setCommandResult('track', { landed: [plugin], refused: [] });
    const { handler, reporter } = invokeTrack(client, undefined, () => [pluginNode()]);

    await runTrackedWithPreset(handler, EDITS_ITEM);

    expect(client.calls).toContainEqual({ method: 'track', args: [[plugin], 'Edits', expect.anything()] });
    expect(reporter.landings).toEqual(['Tracked "MyMod.esp".']);
  });

  it('offers Edits first and pre-selected, then Everything, each in plugins.md\'s own words for what it keeps', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    client.setCommandResult('track', { landed: [{ name: 'MyMod.esp', origin: 'ModA' }], refused: [] });
    const { handler } = invokeTrack(client);

    const qp = await runTrackedWithPreset(handler, EDITS_ITEM, pluginNode());

    expect(qp.items).toEqual([EDITS_ITEM, EVERYTHING_ITEM]);
    expect(qp.activeItems).toEqual([EDITS_ITEM]);
    expect(qp.placeholder).toBe('Track "MyMod.esp"');
  });

  it('shows the preset pick and tracks nothing on Esc', async () => {
    const client = clientWithOrigin('MyMod.esp', 'ModA');
    const { handler, reporter, onTracked } = invokeTrack(client);

    const qp = await runTrackedWithPreset(handler, undefined, pluginNode());

    expect(qp.show).toHaveBeenCalledOnce();
    expect(client.calls.filter((c) => c.method === 'track')).toEqual([]);
    expect(reporter.reports).toEqual([]);
    expect(reporter.landings).toEqual([]);
    expect(onTracked).not.toHaveBeenCalled();
  });

  it('names the plugin it is about to track before mEdit answers, then the mod mEdit reports progress on, phase included', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getPlugins', [
      pluginMetadataFixture({ name: 'First.esp', origin: 'ModA', inLoadOrder: true }),
      pluginMetadataFixture({ name: 'Second.esp', origin: 'ModB', inLoadOrder: true }),
    ]);
    client.setCommandResult('track', { landed: [{ name: 'First.esp', origin: 'ModA' }, { name: 'Second.esp', origin: 'ModB' }], refused: [] });
    const trackSpy = vi.spyOn(client, 'track');
    const { handler, said } = invokeTrack(client);
    const nodes = [new PluginNode({ name: 'First.esp', enabled: true }, 'ModA'), new PluginNode({ name: 'Second.esp', enabled: true }, 'ModB')];

    await runTrackedWithPreset(handler, EDITS_ITEM, nodes[0], nodes);

    expect(said).toContain('Tracking "ModA"…');

    const [, , options] = present(trackSpy.mock.calls[0], 'the track call');
    said.length = 0;
    present(options, 'the track options').onProgress?.({ origin: 'ModB', phase: 'Committing', pluginsDone: 2, pluginsTotal: 2 });

    expect(said).toEqual(['Tracking "ModB" — committing to git…']);
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

  function registered(client: InMemoryMEditClient, options: { viewSelection?: readonly PluginNode[] } = {}) {
    const reporter = recordingReporter();
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
        compile: (plugins) => {
          compiledWhileRunning.push(progress.running);
          return client.compile(plugins);
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
      reporter, diagnostics,
      originFiles: (origin) => (origin === 'ModA' ? PATCH_FILES : undefined),
    }, () => options.viewSelection ?? []);
    return {
      handler: present(handlers.get('modbench.plugin.compile'), 'the compile command registerCompileCommand registers'),
      reporter, diagnostics, progress, compiledWhileRunning,
    };
  }

  const compileCalls = (client: InMemoryMEditClient) => client.calls.filter((c) => c.method === 'compile').map((c) => c.args);

  it('compiles the right-clicked plugin under the view\'s progress bar, and lands once', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('compile', { landed: [compiledPluginFixture({ plugin: PATCH })], refused: [] });
    const { handler, reporter, progress, compiledWhileRunning } = registered(client);

    await handler(row(PATCH));

    expect(compileCalls(client)).toEqual([[[PATCH]]]);
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

    expect(compileCalls(client)).toEqual([[[PATCH, OTHER]]]);
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

  it('compiles the plugin a record tab\'s column header names, at its own origin', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('compile', { landed: [compiledPluginFixture({ plugin: OTHER })], refused: [] });
    const { handler } = registered(client, { viewSelection: [row(PATCH)] });

    await handler({
      webviewSection: 'recordHeader', formKey: '000801:Other.esp', plugin: 'Other.esp', origin: 'ModB',
      compilable: true, preventDefaultContextMenuItems: true,
    });

    expect(compileCalls(client)).toEqual([[[OTHER]]]);
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
    expect(compileCalls(client)).toEqual([[[OTHER]]]);
  });

  it('from the palette, compiles nothing when the pick is dismissed', async () => {
    const client = new InMemoryMEditClient();
    showQuickPick.mockResolvedValue(undefined);
    const { handler, reporter } = registered(client);

    await handler();

    expect(compileCalls(client)).toEqual([]);
    expect(reporter.reports).toEqual([]);
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
