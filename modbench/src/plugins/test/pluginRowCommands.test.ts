import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  handlers, registerCommand, showQuickPick, createQuickPick, executeCommand, openRepository,
} = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void> | void>();
  return {
    handlers,
    openRepository: vi.fn((_uri: unknown) => Promise.resolve({ status: () => Promise.resolve() })),
    registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    showQuickPick: vi.fn<
      (items: readonly { label: string; description?: string }[], options?: unknown) =>
        Promise<{ label: string; description?: string } | undefined>
    >(),
    createQuickPick: vi.fn(),
    executeCommand: vi.fn().mockResolvedValue(undefined),
  };
});

import {
  TreeItem, ThemeIcon, ThemeColor, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState,
  Diagnostic, DiagnosticSeverity, Range, uriFile,
} from '../../test/vscodeMock';

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return {
    commands: { registerCommand, executeCommand },
    extensions: { getExtension: () => ({ isActive: true, exports: { getAPI: () => ({ openRepository }) } }) },
    window: { showQuickPick, createQuickPick, withProgress: recordedWithProgress },
    TreeItem, ThemeIcon, ThemeColor, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState,
    Diagnostic, DiagnosticSeverity, Range,
    Uri: { file: uriFile },
  };
});

import { progressSteps } from '../../test/recordedProgress';

const instanceThatReads = {
  refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(); },
};

import {
  conflictsComputedOver, registerTrackCommand, registerCompileCommand, registerDecompileCommand, CompileProblems,
} from '../pluginRowCommands';
import { originFiles } from '../../instanceLoader/loadOrderSnapshot';
import type { InstanceValue } from '../../instanceLoader/instance';
import { InMemoryMEditClient } from '../../client';
import { PluginNode } from '../PluginsTreeProvider';
import { assertAskedOnce, recordingReporter, scriptedDialog } from '../../test/surfacingDoubles';
import { FakeDiagnosticCollection } from '../../test/vscodeMock';
import { pluginMetadataFixture, compiledPluginFixture } from '../../client/test/fixtures';
import { present } from '../../ports/present';

beforeEach(() => {
  handlers.clear();
  progressSteps.length = 0;
  vi.clearAllMocks();
});

function clientWithOrigin(name: string, origin: string): InMemoryMEditClient {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getPlugins', [pluginMetadataFixture({ name, origin, inLoadOrder: true })]);
  return client;
}

type PresetItem = { label: 'Edits' | 'Everything'; description?: string };

const EDITS_ITEM: PresetItem = { label: 'Edits', description: 'Keeps plugin-source/ and .gitignore' };
const EVERYTHING_ITEM: PresetItem = { label: 'Everything', description: 'Keeps every file except the plugin binaries' };

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

describe('modbench.mod.track', () => {
  const FIRST = { name: 'First.esp', origin: 'ModA' };
  const SECOND = { name: 'Second.esp', origin: 'ModA' };
  const OTHER = { name: 'Other.esp', origin: 'ModB' };
  const INSTANCE_PLUGINS = [FIRST, OTHER, { name: 'Loose.esp', origin: 'overwrite' }, SECOND];
  const SEPARATOR_NAMED_LIKE_A_MOD = { kind: 'separator', name: 'ModA', enabled: true } as const;
  const INSTANCE_MODS: InstanceValue['mods'] = [
    SEPARATOR_NAMED_LIKE_A_MOD,
    { kind: 'mod', name: 'ModA', enabled: true, version: '1.2.3' },
    { kind: 'mod', name: 'ModB', enabled: true },
  ];

  class ModsRowStandIn extends TreeItem {
    constructor(readonly modName: string) { super(modName); }
  }

  function row(plugin: { name: string; origin: string }): PluginNode {
    return new PluginNode({ name: plugin.name, enabled: true }, plugin.origin);
  }

  function invokeTrack(
    client: InMemoryMEditClient, onTracked = vi.fn().mockResolvedValue(undefined),
    paletteSelection: () => readonly unknown[] = () => [],
  ) {
    const said: (string | undefined)[] = [];
    const progress = { say: (message: string | undefined) => said.push(message) };
    const reporter = recordingReporter();
    registerTrackCommand({
      progress, instance: instanceThatReads, client, reporter, onTracked,
      plugins: () => INSTANCE_PLUGINS,
      mods: () => INSTANCE_MODS,
      modOfRow: (value) => (value instanceof ModsRowStandIn ? value.modName : undefined),
      modsView: 'modbench.modList',
    }, paletteSelection);
    return {
      handler: present(handlers.get('modbench.mod.track'), 'the track command registerTrackCommand registers'),
      onTracked, reporter, said,
    };
  }

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

  const trackCalls = (client: InMemoryMEditClient) => client.calls.filter((c) => c.method === 'track');

  it('on a plugin row, tracks the plugin\'s mod: every plugin of it, in one call', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('track', { landed: [FIRST, SECOND], refused: [] });
    const { handler, onTracked, reporter } = invokeTrack(client);

    const qp = await runTrackedWithPreset(handler, EDITS_ITEM, row(FIRST));

    expect(trackCalls(client)).toEqual([{ method: 'track', args: [[FIRST, SECOND], 'Edits', { ModA: '1.2.3' }, expect.anything()] }]);
    expect(qp.placeholder).toBe('Track "ModA"');
    expect(reporter.landings).toEqual(['Tracked "ModA".']);
    expect(reporter.reports).toEqual([]);
    expect(onTracked).toHaveBeenCalledOnce();
  });

  it('ends the gesture on a read the Instance loader makes after the track, and clears its message line', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('track', { landed: [FIRST, SECOND], refused: [] });
    const { handler, said } = invokeTrack(client);

    await runTrackedWithPreset(handler, EDITS_ITEM, row(FIRST));

    expect(progressSteps).toEqual([
      'progress opens on modbench.pluginListTree', 'Instance loader: read every file again', 'progress closes',
    ]);
    expect(said.at(-1)).toBeUndefined();
  });

  it('shows the Mods view\'s bar when a Mods row was clicked', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('track', { landed: [FIRST, SECOND], refused: [] });
    const { handler } = invokeTrack(client);

    await runTrackedWithPreset(handler, EDITS_ITEM, new ModsRowStandIn('ModA'));

    expect(progressSteps[0]).toBe('progress opens on modbench.modList');
  });

  it('on selected plugin rows of one mod, tracks that mod once', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('track', { landed: [FIRST, SECOND], refused: [] });
    const { handler } = invokeTrack(client);

    await runTrackedWithPreset(handler, EDITS_ITEM, row(SECOND), [row(FIRST), row(SECOND)]);

    expect(trackCalls(client)).toEqual([{ method: 'track', args: [[FIRST, SECOND], 'Edits', { ModA: '1.2.3' }, expect.anything()] }]);
  });

  it('on selected Mods rows, tracks every plugin of each mod in one call and asks the preset once', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('track', { landed: [FIRST, SECOND, OTHER], refused: [] });
    const { handler, reporter } = invokeTrack(client);
    const mods = [new ModsRowStandIn('ModA'), new ModsRowStandIn('ModB')];

    const qp = await runTrackedWithPreset(handler, EVERYTHING_ITEM, mods[1], mods);

    expect(createQuickPick).toHaveBeenCalledOnce();
    expect(trackCalls(client)).toEqual([{ method: 'track', args: [[FIRST, SECOND, OTHER], 'Everything', { ModA: '1.2.3' }, expect.anything()] }]);
    expect(qp.placeholder).toBe('Track 2 mods');
    expect(reporter.landings).toEqual(['Tracked 2 mods.']);
  });

  it('on an Editor column header, tracks the column plugin\'s mod', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('track', { landed: [FIRST, SECOND], refused: [] });
    const { handler } = invokeTrack(client);
    const header = {
      webviewSection: 'recordHeader', formKey: '000801:Other.esp', plugin: 'Second.esp', origin: 'ModA',
      editable: false, preventDefaultContextMenuItems: true,
    };

    await runTrackedWithPreset(handler, EDITS_ITEM, header);

    expect(trackCalls(client)).toEqual([{ method: 'track', args: [[FIRST, SECOND], 'Edits', { ModA: '1.2.3' }, expect.anything()] }]);
  });

  it('from the palette, tracks the mods of a Mods selection', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('track', { landed: [OTHER], refused: [] });
    const { handler, reporter } = invokeTrack(client, undefined, () => [new ModsRowStandIn('ModB')]);

    await runTrackedWithPreset(handler, EDITS_ITEM);

    expect(trackCalls(client)).toEqual([{ method: 'track', args: [[OTHER], 'Edits', {}, expect.anything()] }]);
    expect(reporter.landings).toEqual(['Tracked "ModB".']);
  });

  it('from the palette, tracks the mod of a Plugins selection', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('track', { landed: [OTHER], refused: [] });
    const { handler, reporter } = invokeTrack(client, undefined, () => [row(OTHER)]);

    await runTrackedWithPreset(handler, EDITS_ITEM);

    expect(trackCalls(client)).toEqual([{ method: 'track', args: [[OTHER], 'Edits', {}, expect.anything()] }]);
    expect(reporter.landings).toEqual(['Tracked "ModB".']);
  });

  it('a landed track, through the conflicts-computed notice, registers the tracked repository once', async () => {
    const client = clientWithOrigin('Other.esp', 'ModB');
    client.setCommandResult('track', { landed: [OTHER], refused: [] });
    const announce = vi.fn();
    const channel = { warn: vi.fn(), error: vi.fn() };
    const notice = conflictsComputedOver(announce, {
      client, outputChannel: channel, setPluginRepositories: () => {},
      trackedMods: () => new Set(['ModB']), modDirs: () => new Map([['ModB', '/mods/ModB']]),
    });
    const { handler } = invokeTrack(client, vi.fn(notice));

    await runTrackedWithPreset(handler, EDITS_ITEM, row(OTHER));

    expect(announce).toHaveBeenCalledOnce();
    expect(openRepository).toHaveBeenCalledOnce();
    expect(channel.error).not.toHaveBeenCalled();
  });

  it('reports each refused plugin once while the rest land', async () => {
    const client = new InMemoryMEditClient();
    const outcome = { landed: [FIRST], refused: [{ item: SECOND, reason: 'Second.esp does not round-trip.' }] };
    client.setCommandResult('track', outcome);
    const { handler, onTracked, reporter } = invokeTrack(client);

    await runTrackedWithPreset(handler, EDITS_ITEM, new ModsRowStandIn('ModA'));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not track 1 of 2 plugins.', detail: '"Second.esp (ModA)" (Second.esp does not round-trip.)' },
    ]);
    expect(reporter.landings).toEqual([]);
    expect(onTracked).toHaveBeenCalledOnce();
  });

  it('on Mods rows where one provides no plugin, tracks the rest and names the one left out', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('track', { landed: [FIRST, SECOND, OTHER], refused: [] });
    const { handler, onTracked, reporter } = invokeTrack(client);
    const mods = [new ModsRowStandIn('ModA'), new ModsRowStandIn('ModC'), new ModsRowStandIn('ModB')];

    const qp = await runTrackedWithPreset(handler, EDITS_ITEM, mods[0], mods);

    expect(trackCalls(client)).toEqual([{ method: 'track', args: [[FIRST, SECOND, OTHER], 'Edits', { ModA: '1.2.3' }, expect.anything()] }]);
    expect(qp.placeholder).toBe('Track 2 mods');
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not track 1 of 3 mods.', detail: '"ModC" (it provides no plugin)' },
    ]);
    expect(reporter.landings).toEqual([]);
    expect(onTracked).toHaveBeenCalledOnce();
  });

  it('names a mod that provides no plugin and a refused plugin in one notification', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('track', { landed: [FIRST], refused: [{ item: SECOND, reason: 'Second.esp does not round-trip.' }] });
    const { handler, reporter } = invokeTrack(client);
    const mods = [new ModsRowStandIn('ModA'), new ModsRowStandIn('ModC')];

    await runTrackedWithPreset(handler, EDITS_ITEM, mods[0], mods);

    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not track 1 of 2 mods and 1 of 2 plugins.',
      detail: '"ModC" (it provides no plugin), "Second.esp (ModA)" (Second.esp does not round-trip.)',
    }]);
  });

  it('on a Mods row that provides no plugin, asks nothing and says why', async () => {
    const client = new InMemoryMEditClient();
    const { handler, onTracked, reporter } = invokeTrack(client);

    await handler(new ModsRowStandIn('ModC'));

    expect(createQuickPick).not.toHaveBeenCalled();
    expect(trackCalls(client)).toEqual([]);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not track 1 of 1 mods.', detail: '"ModC" (it provides no plugin)' },
    ]);
    expect(onTracked).not.toHaveBeenCalled();
  });

  it('reports the ready-to-show message at error and lands nothing when the backend refuses the whole selection', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('track', { refused: true, message: 'Could not track 1 plugin — git was not found on PATH.' });
    const { handler, onTracked, reporter } = invokeTrack(client);

    await runTrackedWithPreset(handler, EDITS_ITEM, row(OTHER));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not track 1 plugin — git was not found on PATH.', detail: undefined },
    ]);
    expect(reporter.landings).toEqual([]);
    expect(onTracked).not.toHaveBeenCalled();
  });

  it('offers Edits first and pre-selected, then Everything, each in plugins.md\'s own words for what it keeps', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('track', { landed: [OTHER], refused: [] });
    const { handler } = invokeTrack(client);

    const qp = await runTrackedWithPreset(handler, EDITS_ITEM, row(OTHER));

    expect(qp.items).toEqual([EDITS_ITEM, EVERYTHING_ITEM]);
    expect(qp.activeItems).toEqual([EDITS_ITEM]);
  });

  it('shows the preset pick and tracks nothing on Esc', async () => {
    const client = new InMemoryMEditClient();
    const { handler, reporter, onTracked } = invokeTrack(client);

    const qp = await runTrackedWithPreset(handler, undefined, row(OTHER));

    expect(qp.show).toHaveBeenCalledOnce();
    expect(trackCalls(client)).toEqual([]);
    expect(reporter.reports).toEqual([]);
    expect(reporter.landings).toEqual([]);
    expect(onTracked).not.toHaveBeenCalled();
  });

  it('names the mod it is about to track before mEdit answers, then the mod mEdit reports progress on, phase included', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('track', { landed: [FIRST, SECOND, OTHER], refused: [] });
    const trackSpy = vi.spyOn(client, 'track');
    const { handler, said } = invokeTrack(client);
    const mods = [new ModsRowStandIn('ModA'), new ModsRowStandIn('ModB')];

    await runTrackedWithPreset(handler, EDITS_ITEM, mods[0], mods);

    expect(said).toContain('Tracking "ModA"…');

    const [, , , options] = present(trackSpy.mock.calls[0], 'the track call');
    said.length = 0;
    present(options, 'the track options').onProgress?.({ origin: 'ModB', phase: 'Committing', pluginsDone: 2, pluginsTotal: 2 });

    expect(said).toEqual(['Tracking "ModB" — committing to git…']);
  });
});

describe('modbench.plugin.compile', () => {
  const PATCH = { name: 'MyPatch.esp', origin: 'ModA' };
  const OTHER = { name: 'Other.esp', origin: 'ModB' };
  const PATCH_FILES = originFiles(
    [{ path: '/instance/mods/ModA/MyPatch.esp', origin: 'ModA' }], 'ModA');

  function row(plugin: { name: string; origin: string }, contextValue = 'plugin enabled inTrackedMod tracked editable'): PluginNode {
    const node = new PluginNode({ name: plugin.name, enabled: true }, plugin.origin);
    node.contextValue = contextValue;
    return node;
  }

  function registered(client: InMemoryMEditClient, options: { viewSelection?: readonly PluginNode[] } = {}) {
    const reporter = recordingReporter();
    const diagnostics = new FakeDiagnosticCollection();
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
          progressSteps.push('compile');
          return client.compile(plugins);
        },
      },
      instance: instanceThatReads,
      reporter, problems: new CompileProblems(diagnostics),
      originFiles: (origin) => (origin === 'ModA' ? PATCH_FILES : undefined),
    }, () => options.viewSelection ?? []);
    return {
      handler: present(handlers.get('modbench.plugin.compile'), 'the compile command registerCompileCommand registers'),
      reporter, diagnostics,
    };
  }

  const compileCalls = (client: InMemoryMEditClient) => client.calls.filter((c) => c.method === 'compile').map((c) => c.args);

  it('compiles the right-clicked plugin, and the view\'s progress bar closes once the Instance loader has read again, and lands once', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('compile', { landed: [compiledPluginFixture({ plugin: PATCH })], refused: [] });
    const { handler, reporter } = registered(client);

    await handler(row(PATCH));

    expect(compileCalls(client)).toEqual([[[PATCH]]]);
    expect(progressSteps).toEqual([
      'progress opens on modbench.pluginListTree', 'compile', 'Instance loader: read every file again', 'progress closes',
    ]);
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

  it('replaces the diagnostics of each plugin that compiled, and keeps a refused plugin\'s of the same mod', async () => {
    const SIBLING = { name: 'Sibling.esp', origin: 'ModA' };
    const diagnosticOf = (plugin: { name: string }) =>
      ({ formKey: `000800:${plugin.name}`, sourceRelativePath: `${plugin.name}/A.json`, message: `${plugin.name} is broken` });
    const client = new InMemoryMEditClient();
    client.setCommandResult('compile', {
      landed: [
        compiledPluginFixture({ plugin: PATCH, diagnostics: [diagnosticOf(PATCH)] }),
        compiledPluginFixture({ plugin: SIBLING, diagnostics: [diagnosticOf(SIBLING)] }),
      ],
      refused: [],
    });
    const { handler, diagnostics } = registered(client);
    const rows = [row(PATCH), row(SIBLING)];
    await handler(rows[0], rows);

    client.setCommandResult('compile', { landed: [compiledPluginFixture({ plugin: PATCH })], refused: [{ item: SIBLING, reason: 'no source' }] });
    await handler(rows[0], rows);

    expect([...diagnostics].map(([uri, list]) => [uri.fsPath, list.map((d) => d.message)])).toEqual([
      ['/instance/mods/ModA/Sibling.esp/A.json', ['Sibling.esp is broken']],
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

  it('names the one plugin it was asked to compile when that plugin is refused', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('compile', { landed: [], refused: [{ item: PATCH, reason: 'no source' }] });
    const { handler, reporter } = registered(client);

    await handler(row(PATCH));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not compile "MyPatch.esp".', detail: '"MyPatch.esp (ModA)" (no source)' },
    ]);
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
      editable: true, preventDefaultContextMenuItems: true,
    });

    expect(compileCalls(client)).toEqual([[[OTHER]]]);
  });

  it('from the palette, picks among the tracked plugins, read-only included, the selected one first, and compiles the pick', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('compile', { landed: [compiledPluginFixture({ plugin: OTHER })], refused: [] });
    showQuickPick.mockResolvedValue({ label: 'Other.esp', description: 'ModB' });
    const { handler } = registered(client, { viewSelection: [row(OTHER)] });

    await handler();

    expect(showQuickPick).toHaveBeenCalledWith(
      [{ label: 'Other.esp', description: 'ModB' }, { label: 'MyPatch.esp', description: 'ModA' }, { label: 'ReadOnly.esp', description: 'ModD' }],
      { placeHolder: 'Compile which plugin?' });
    expect(compileCalls(client)).toEqual([[[OTHER]]]);
  });

  it('from the palette, leads with the selected plugin whatever the case of its row\'s name and origin', async () => {
    const client = new InMemoryMEditClient();
    showQuickPick.mockResolvedValue(undefined);
    const { handler } = registered(client, { viewSelection: [row({ name: 'other.ESP', origin: 'modb' })] });

    await handler();

    expect(showQuickPick).toHaveBeenCalledWith(
      [{ label: 'Other.esp', description: 'ModB' }, { label: 'MyPatch.esp', description: 'ModA' }, { label: 'ReadOnly.esp', description: 'ModD' }],
      { placeHolder: 'Compile which plugin?' });
  });

  it('from the palette, compiles nothing when the pick is dismissed', async () => {
    const client = new InMemoryMEditClient();
    showQuickPick.mockResolvedValue(undefined);
    const { handler, reporter } = registered(client);

    await handler();

    expect(compileCalls(client)).toEqual([]);
    expect(reporter.reports).toEqual([]);
  });

  it('from the palette, reports at error when the plugins cannot be listed, and compiles nothing', async () => {
    const client = new InMemoryMEditClient();
    const { handler, reporter } = registered(client);
    client.setQueryFailure('getPlugins', new Error('fetch failed'));

    await handler();

    expect(showQuickPick).not.toHaveBeenCalled();
    expect(compileCalls(client)).toEqual([]);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not list the plugins to compile.', detail: 'fetch failed' },
    ]);
  });
});

describe('modbench.plugin.decompile', () => {
  const FIRST = { name: 'First.esp', origin: 'ModA' };
  const SECOND = { name: 'Second.esp', origin: 'ModA' };

  function row(plugin: { name: string; origin: string }): PluginNode {
    const node = new PluginNode({ name: plugin.name, enabled: true }, plugin.origin);
    node.contextValue = 'plugin enabled inTrackedMod untracked editable';
    return node;
  }

  function registered(client: InMemoryMEditClient, answer: string | undefined, viewSelection: readonly PluginNode[] = []) {
    const reporter = recordingReporter();
    const ask = scriptedDialog(answer);
    registerDecompileCommand({
      client: {
        decompile: (plugins) => {
          progressSteps.push('decompile');
          return client.decompile(plugins);
        },
      },
      instance: instanceThatReads,
      reporter, ask,
    }, () => viewSelection);
    return {
      handler: present(handlers.get('modbench.plugin.decompile'), 'the decompile command registerDecompileCommand registers'),
      reporter, ask,
    };
  }

  const decompileCalls = (client: InMemoryMEditClient) => client.calls.filter((c) => c.method === 'decompile').map((c) => c.args);

  it('on a plugin row, asks once naming it, then decompiles it, the view\'s progress bar closing once the Instance loader has read again, and lands once', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('decompile', { landed: [SECOND], refused: [] });
    const { handler, reporter, ask } = registered(client, 'Decompile');

    await handler(row(SECOND));

    assertAskedOnce(ask, { messageContains: '"Second.esp"', buttons: ['Decompile'] });
    expect(ask.asked[0]?.message).toContain('replaces its source in the working tree from its bytes');
    expect(decompileCalls(client)).toEqual([[[SECOND]]]);
    expect(progressSteps).toEqual([
      'progress opens on modbench.pluginListTree', 'decompile', 'Instance loader: read every file again', 'progress closes',
    ]);
    expect(reporter.landings).toEqual(['Decompiled "Second.esp".']);
    expect(reporter.reports).toEqual([]);
  });

  it('on a selection, asks once naming every plugin, and decompiles them in one call', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('decompile', { landed: [FIRST, SECOND], refused: [] });
    const { handler, reporter, ask } = registered(client, 'Decompile');
    const rows = [row(FIRST), row(SECOND)];

    await handler(rows[0], rows);

    expect(ask.asked).toEqual([{
      message: 'Decompile 2 plugins? Decompile replaces their source in the working tree from their bytes.',
      detail: 'First.esp (ModA)\nSecond.esp (ModA)',
      buttons: ['Decompile'],
    }]);
    expect(decompileCalls(client)).toEqual([[[FIRST, SECOND]]]);
    expect(reporter.landings).toEqual(['Decompiled 2 plugins.']);
  });

  it('decompiles nothing and says nothing when the confirmation is dismissed', async () => {
    const client = new InMemoryMEditClient();
    const { handler, reporter } = registered(client, undefined);

    await handler(row(SECOND));

    expect(decompileCalls(client)).toEqual([]);
    expect(reporter.reports).toEqual([]);
    expect(reporter.landings).toEqual([]);
  });

  it('decompiles the plugin a record tab\'s column header names, at its own origin', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('decompile', { landed: [SECOND], refused: [] });
    const { handler } = registered(client, 'Decompile', [row(FIRST)]);

    await handler({
      webviewSection: 'recordHeader', formKey: '000801:Second.esp', plugin: 'Second.esp', origin: 'ModA',
      editable: false, preventDefaultContextMenuItems: true,
    });

    expect(decompileCalls(client)).toEqual([[[SECOND]]]);
  });

  it('from the palette, decompiles the Plugins view\'s selection', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('decompile', { landed: [FIRST], refused: [] });
    const { handler } = registered(client, 'Decompile', [row(FIRST)]);

    await handler();

    expect(decompileCalls(client)).toEqual([[[FIRST]]]);
  });

  it('names each refused plugin and why in one notification while the rest land', async () => {
    const client = new InMemoryMEditClient();
    const refusal = 'First.esp does not round-trip through its own source.';
    client.setCommandResult('decompile', { landed: [SECOND], refused: [{ item: FIRST, reason: refusal }] });
    const { handler, reporter } = registered(client, 'Decompile');
    const rows = [row(FIRST), row(SECOND)];

    await handler(rows[0], rows);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not decompile 1 of 2 plugins.', detail: `"First.esp (ModA)" (${refusal})` },
    ]);
    expect(reporter.landings).toEqual([]);
  });

  it('reports a refusal of the whole selection once, and lands nothing', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('decompile', { refused: true, message: 'Could not decompile 1 plugin — git was not found on PATH.' });
    const { handler, reporter } = registered(client, 'Decompile');

    await handler(row(SECOND));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not decompile 1 plugin — git was not found on PATH.', detail: undefined },
    ]);
    expect(reporter.landings).toEqual([]);
  });
});

describe('CompileProblems', () => {
  const diagnosticAt = (sourceRelativePath: string) => [{ formKey: '000000:MyPatch.esp', sourceRelativePath, message: 'bad' }];

  const publishedPaths = (diagnostics: FakeDiagnosticCollection) => [...diagnostics].map(([uri]) => uri.fsPath);

  it('targets the folder the value gave for the origin, overwrite included', () => {
    const diagnostics = new FakeDiagnosticCollection();
    const plugin = { name: 'Stray.esp', path: '/instance/overwrite/Stray.esp', origin: 'overwrite', slot: null, enabled: false, winning: true };

    new CompileProblems(diagnostics).publish(plugin, originFiles([plugin], 'overwrite'), diagnosticAt('Source/Stray.psc'));

    expect(publishedPaths(diagnostics)).toEqual(['/instance/overwrite/Source/Stray.psc']);
  });

  it("replaces the plugin's own entries, and leaves every other plugin's, its mod's included", () => {
    const diagnostics = new FakeDiagnosticCollection();
    const problems = new CompileProblems(diagnostics);
    const plugins = [
      { name: 'A.esp', path: '/instance/mods/ModA/A.esp', origin: 'ModA', slot: 0, enabled: true, winning: true },
      { name: 'Also.esp', path: '/instance/mods/ModA/Also.esp', origin: 'ModA', slot: 1, enabled: true, winning: true },
      { name: 'B.esp', path: '/instance/mods/ModB/B.esp', origin: 'ModB', slot: 2, enabled: true, winning: true },
    ];
    const [a, also, b] = plugins;
    problems.publish(present(a, 'A.esp'), originFiles(plugins, 'ModA'), diagnosticAt('A.esp/Old.json'));
    problems.publish(present(also, 'Also.esp'), originFiles(plugins, 'ModA'), diagnosticAt('Also.esp/Kept.json'));
    problems.publish(present(b, 'B.esp'), originFiles(plugins, 'ModB'), diagnosticAt('B.esp/Other.json'));

    problems.publish(present(a, 'A.esp'), originFiles(plugins, 'ModA'), diagnosticAt('A.esp/New.json'));

    expect(publishedPaths(diagnostics)).toEqual([
      '/instance/mods/ModA/Also.esp/Kept.json', '/instance/mods/ModB/B.esp/Other.json', '/instance/mods/ModA/A.esp/New.json',
    ]);
  });

  it('publishes nothing when the value knows no folder for the origin', () => {
    const diagnostics = new FakeDiagnosticCollection();

    new CompileProblems(diagnostics).publish({ name: 'A.esp', origin: 'ModA' }, undefined, diagnosticAt('Source/A.psc'));

    expect(publishedPaths(diagnostics)).toEqual([]);
  });
});

