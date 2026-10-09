import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  handlers, registerCommand, showQuickPick, createQuickPick, executeCommand,
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
    executeCommand: vi.fn().mockResolvedValue(undefined),
  };
});

import {
  TreeItem, ThemeIcon, ThemeColor, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState,
  Diagnostic, DiagnosticSeverity, Range, uriFile, uriFrom,
} from '../../test/vscodeMock';

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return {
    commands: { registerCommand, executeCommand },
    window: { showQuickPick, createQuickPick, withProgress: recordedWithProgress },
    TreeItem, ThemeIcon, ThemeColor, EventEmitter, TreeItemCollapsibleState, TreeItemCheckboxState,
    Diagnostic, DiagnosticSeverity, Range,
    Uri: { file: uriFile, from: uriFrom },
  };
});

import { progressSteps } from '../../test/recordedProgress';

const instanceThatReads = {
  refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(); },
};

import {
  registerTrackCommand, registerCompileCommand, registerDecompileCommand, CompileProblems,
} from '../pluginRowCommands';
import { originFiles } from '../../instanceLoader/loadOrderSnapshot';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { type PluginAddress } from '../../client';
import { PluginNode } from '../PluginsTreeProvider';
import { assertAskedOnce, recordingReporter, scriptedDialog } from '../../test/surfacingDoubles';
import { FakeDiagnosticCollection } from '../../test/vscodeMock';
import { pluginMetadataFixture, compiledPluginFixture } from '../../client/test/fixtures';
import { present } from '../../ports/present';
import { quickPickChoosing } from '../../drivingLib/test/quickPickDouble';

beforeEach(() => {
  handlers.clear();
  progressSteps.length = 0;
  vi.clearAllMocks();
});

describe('modbench.mod.track', () => {
  const FIRST = { name: 'First.esp', origin: 'ModA' };
  const SECOND = { name: 'Second.esp', origin: 'ModA' };
  const OTHER = { name: 'Other.esp', origin: 'ModB' };
  const MOD_DIRS = new Map([['ModA', '/mods/ModA'], ['ModB', '/mods/ModB'], ['ModC', '/mods/ModC']]);
  const modA = (tracked: PluginAddress[]) => ({ mod: 'ModA', tracked });
  const modB = (tracked: PluginAddress[]) => ({ mod: 'ModB', tracked });

  class ModsRowStandIn extends TreeItem {
    readonly kind = 'mod';
    readonly argument: { kind: 'mod'; name: string };
    constructor(name: string) { super(name); this.argument = { kind: 'mod', name }; }
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
      progress, instance: instanceThatReads, client, reporter, onTracked, modsView: 'modbench.modList', modDirs: () => MOD_DIRS,
    }, paletteSelection);
    return {
      handler: present(handlers.get('modbench.mod.track'), 'the track command registerTrackCommand registers'),
      onTracked, reporter, said,
    };
  }

  const trackCalls = (client: InMemoryMEditClient) => client.calls.filter((c) => c.method === 'track');

  it('on a plugin row, tracks the plugin\'s mod, asking nothing', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('track', { landed: [modA([FIRST, SECOND])], refused: [] });
    const { handler, onTracked, reporter } = invokeTrack(client);

    await handler(row(FIRST));

    expect(trackCalls(client)).toEqual([{ method: 'track', args: [['ModA'], expect.anything()] }]);
    expect(createQuickPick).not.toHaveBeenCalled();
    expect(showQuickPick).not.toHaveBeenCalled();
    expect(reporter.landings).toEqual(['Tracked "ModA".']);
    expect(reporter.reports).toEqual([]);
    expect(onTracked).toHaveBeenCalledOnce();
  });

  it('ends the gesture on a read the Instance loader makes after the track, and clears its message line', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('track', { landed: [modA([FIRST, SECOND])], refused: [] });
    const { handler, said } = invokeTrack(client);

    await handler(row(FIRST));

    expect(progressSteps).toEqual([
      'progress opens on modbench.pluginListTree', 'Instance loader: read every file again', 'progress closes',
    ]);
    expect(said.at(-1)).toBeUndefined();
  });

  it('shows the Mods view\'s bar when a Mods row was clicked', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('track', { landed: [modA([FIRST, SECOND])], refused: [] });
    const { handler } = invokeTrack(client);

    await handler(new ModsRowStandIn('ModA'));

    expect(progressSteps[0]).toBe('progress opens on modbench.modList');
  });

  it('on selected plugin rows of one mod, tracks that mod once', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('track', { landed: [modA([FIRST, SECOND])], refused: [] });
    const { handler } = invokeTrack(client);

    await handler(row(SECOND), [row(FIRST), row(SECOND)]);

    expect(trackCalls(client)).toEqual([{ method: 'track', args: [['ModA'], expect.anything()] }]);
  });

  it('on selected Mods rows, tracks every mod in one call', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('track', { landed: [modA([FIRST, SECOND]), modB([OTHER])], refused: [] });
    const { handler, reporter } = invokeTrack(client);
    const mods = [new ModsRowStandIn('ModA'), new ModsRowStandIn('ModB')];

    await handler(mods[1], mods);

    expect(trackCalls(client)).toEqual([{ method: 'track', args: [['ModA', 'ModB'], expect.anything()] }]);
    expect(reporter.landings).toEqual(['Tracked 2 mods.']);
  });

  it('names a row that carries neither a mod nor a plugin, and tracks the rest', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('track', { landed: [modA([FIRST, SECOND])], refused: [] });
    const { handler, reporter } = invokeTrack(client);
    const withoutArgument = { label: 'Odd', kind: 'plugin', plugin: { name: FIRST.name }, origin: FIRST.origin };

    await handler(row(FIRST), [row(FIRST), withoutArgument]);

    expect(trackCalls(client)).toEqual([{ method: 'track', args: [['ModA'], expect.anything()] }]);
    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not track 1 of 3 plugins.', detail: '"Odd" (it carries no mod or plugin)',
    }]);
  });

  it('on an Editor column header, tracks the column plugin\'s mod', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('track', { landed: [modA([FIRST, SECOND])], refused: [] });
    const { handler } = invokeTrack(client);
    const header = {
      webviewSection: 'recordHeader', argument: { kind: 'record', formKey: '000801:Other.esp', plugin: { name: 'Second.esp', origin: 'ModA' } },
      compilable: false, editable: false, preventDefaultContextMenuItems: true,
    };

    await handler(header);

    expect(trackCalls(client)).toEqual([{ method: 'track', args: [['ModA'], expect.anything()] }]);
  });

  it('from the palette, tracks the mods of a Mods selection', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('track', { landed: [modB([OTHER])], refused: [] });
    const { handler, reporter } = invokeTrack(client, undefined, () => [new ModsRowStandIn('ModB')]);

    await handler();

    expect(trackCalls(client)).toEqual([{ method: 'track', args: [['ModB'], expect.anything()] }]);
    expect(reporter.landings).toEqual(['Tracked "ModB".']);
  });

  it('from the palette, tracks the mod of a Plugins selection', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('track', { landed: [modB([OTHER])], refused: [] });
    const { handler, reporter } = invokeTrack(client, undefined, () => [row(OTHER)]);

    await handler();

    expect(trackCalls(client)).toEqual([{ method: 'track', args: [['ModB'], expect.anything()] }]);
    expect(reporter.landings).toEqual(['Tracked "ModB".']);
  });

  it('names a mod mEdit refused while the rest land', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('track', {
      landed: [modA([FIRST])],
      refused: [{ item: 'ModC', reason: 'ModC provides no plugin.' }],
    });
    const { handler, onTracked, reporter } = invokeTrack(client);
    const mods = [new ModsRowStandIn('ModA'), new ModsRowStandIn('ModC')];

    await handler(mods[0], mods);

    expect(trackCalls(client)).toEqual([{ method: 'track', args: [['ModA', 'ModC'], expect.anything()] }]);
    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not track 1 of 2 mods.', detail: '"ModC" (ModC provides no plugin.)',
    }]);
    expect(reporter.landings).toEqual([]);
    expect(onTracked).toHaveBeenCalledOnce();
  });

  it('never sends an origin that is not a mod as a mod name: refuses that plugin as not in a mod and tracks the rest', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('track', { landed: [modB([OTHER])], refused: [] });
    const { handler, onTracked, reporter } = invokeTrack(client);
    const loose = { name: 'Loose.esp', origin: 'Overwrite' };

    await handler(row(OTHER), [row(OTHER), row(loose)]);

    expect(trackCalls(client)).toEqual([{ method: 'track', args: [['ModB'], expect.anything()] }]);
    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not track 1 of 2 plugins.', detail: '"Loose.esp (Overwrite)" (it is not in a mod)',
    }]);
    expect(onTracked).toHaveBeenCalledOnce();
  });

  it('calls mEdit with nothing when every plugin selected is in no mod, and names each', async () => {
    const client = new InMemoryMEditClient();
    const { handler, onTracked, reporter } = invokeTrack(client);

    await handler(row({ name: 'Loose.esp', origin: 'Overwrite' }));

    expect(trackCalls(client)).toEqual([]);
    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not track 1 of 1 plugins.', detail: '"Loose.esp (Overwrite)" (it is not in a mod)',
    }]);
    expect(onTracked).not.toHaveBeenCalled();
  });

  it('sends the mod as the instance spells it when the plugin\'s origin differs in case', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('track', { landed: [modA([FIRST])], refused: [] });
    const { handler } = invokeTrack(client);

    await handler(row({ name: 'First.esp', origin: 'moda' }));

    expect(trackCalls(client)).toEqual([{ method: 'track', args: [['ModA'], expect.anything()] }]);
  });

  it('reports the ready-to-show message at error and lands nothing when the backend refuses the whole selection', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('track', { refused: true, message: 'Could not track 1 mod — git was not found on PATH.' });
    const { handler, onTracked, reporter } = invokeTrack(client);

    await handler(row(OTHER));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not track 1 mod — git was not found on PATH.', detail: undefined },
    ]);
    expect(reporter.landings).toEqual([]);
    expect(onTracked).not.toHaveBeenCalled();
  });

  it('names the mod it is about to track before mEdit answers, then the mod mEdit reports progress on, phase included', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('track', { landed: [modA([FIRST, SECOND]), modB([OTHER])], refused: [] });
    const trackSpy = vi.spyOn(client, 'track');
    const { handler, said } = invokeTrack(client);
    const mods = [new ModsRowStandIn('ModA'), new ModsRowStandIn('ModB')];

    await handler(mods[0], mods);

    expect(said).toContain('Tracking "ModA"…');

    const [, options] = present(trackSpy.mock.calls[0], 'the track call');
    said.length = 0;
    present(options, 'the track options').onProgress?.({ mod: 'ModB', phase: 'Committing', pluginsDone: 2, pluginsTotal: 2 });

    expect(said).toEqual(['Tracking "ModB" — committing to git…']);
  });
});


const valueWithFolders = (folders: { overwriteDir?: string; modDirs?: ReadonlyMap<string, string> }) => instanceValueFixture({
  paths: { overwriteDir: folders.overwriteDir, downloadsDir: undefined, modDirs: folders.modDirs ?? new Map() },
});

describe('modbench.plugin.compile', () => {
  const PATCH = { name: 'MyPatch.esp', origin: 'ModA' };
  const OTHER = { name: 'Other.esp', origin: 'ModB' };
  const FILES = valueWithFolders({ modDirs: new Map([['ModA', '/instance/mods/ModA'], ['ModB', '/instance/mods/ModB']]) });
  const PATCH_FILES = originFiles(FILES, 'ModA');

  function row(plugin: { name: string; origin: string }, contextValue = 'plugin enabled inTrackedMod tracked editable'): PluginNode {
    const node = new PluginNode({ name: plugin.name, enabled: true }, plugin.origin);
    node.contextValue = contextValue;
    return node;
  }

  function registered(client: InMemoryMEditClient, options: { viewSelection?: readonly PluginNode[]; unsaved?: Record<string, string[]> } = {}) {
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
      originFiles: (origin) => (origin === 'ModA' || origin === 'ModB' ? originFiles(FILES, origin) : undefined),
      saveUnsaved: (folder) => {
        progressSteps.push(`save ${folder}`);
        return Promise.resolve(options.unsaved?.[folder] ?? []);
      },
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
      'save /instance/mods/ModA/plugin-source/MyPatch.esp', 'progress opens on modbench.pluginListTree', 'compile', 'Instance loader: read every file again', 'progress closes',
    ]);
    expect(reporter.landings).toEqual(['Compiled "MyPatch.esp".']);
    expect(reporter.reports).toEqual([]);
  });

  it('saves the plugin\'s plugin source folder first, before the compile writes', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('compile', { landed: [compiledPluginFixture({ plugin: PATCH })], refused: [] });
    const { handler } = registered(client);

    await handler(row(PATCH));

    expect(progressSteps.filter((step) => step.startsWith('save') || step === 'compile')).toEqual([
      'save /instance/mods/ModA/plugin-source/MyPatch.esp', 'compile',
    ]);
  });

  it('refuses the compile, naming each document VS Code did not save, and calls mEdit not at all', async () => {
    const client = new InMemoryMEditClient();
    const { handler, reporter } = registered(client, { unsaved: { '/instance/mods/ModA/plugin-source/MyPatch.esp': ['/instance/mods/ModA/plugin-source/MyPatch.esp/A.json'] } });

    await handler(row(PATCH));

    expect(compileCalls(client)).toEqual([]);
    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not compile: VS Code did not save its plugin source.',
      detail: '/instance/mods/ModA/plugin-source/MyPatch.esp/A.json',
    }]);
    expect(reporter.landings).toEqual([]);
  });

  it('saves every selected plugin, refuses when one of them has a document left unsaved, and compiles none', async () => {
    const client = new InMemoryMEditClient();
    const { handler, reporter } = registered(client, {
      unsaved: { '/instance/mods/ModB/plugin-source/Other.esp': ['/instance/mods/ModB/plugin-source/Other.esp/B.json'] },
    });
    const rows = [row(PATCH), row(OTHER)];

    await handler(rows[0], rows);

    expect(progressSteps).toEqual([
      'save /instance/mods/ModA/plugin-source/MyPatch.esp', 'save /instance/mods/ModB/plugin-source/Other.esp',
    ]);
    expect(compileCalls(client)).toEqual([]);
    expect(reporter.reports.map((r) => r.detail)).toEqual(['/instance/mods/ModB/plugin-source/Other.esp/B.json']);
  });

  it('refuses, naming the plugin, when its origin has no folder to hold plugin source', async () => {
    const client = new InMemoryMEditClient();
    const { handler, reporter } = registered(client);
    const stray = { name: 'Stray.esp', origin: 'ModZ' };

    await handler(row(stray));

    expect(compileCalls(client)).toEqual([]);
    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not compile: no folder for the plugin source of these plugins.',
      detail: 'Stray.esp (ModZ)',
    }]);
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
      webviewSection: 'recordHeader', argument: { kind: 'record', formKey: '000801:Other.esp', plugin: { name: 'Other.esp', origin: 'ModB' } },
      compilable: true, editable: true, preventDefaultContextMenuItems: true,
    });

    expect(compileCalls(client)).toEqual([[[OTHER]]]);
  });

  type CompileItem = { label: string; description?: string };
  const scriptCompilePick = (choose: (items: readonly CompileItem[]) => CompileItem | undefined) => {
    const pick = quickPickChoosing<CompileItem>(choose);
    createQuickPick.mockImplementationOnce(() => pick);
    return pick;
  };
  const OTHER_ITEM = { label: 'Other.esp', description: 'ModB' };
  const ALL_ITEMS = [OTHER_ITEM, { label: 'MyPatch.esp', description: 'ModA' }, { label: 'ReadOnly.esp', description: 'ModD' }];

  it('from the palette, picks among the tracked plugins, read-only included, the selected one first and marked, and compiles the pick', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('compile', { landed: [compiledPluginFixture({ plugin: OTHER })], refused: [] });
    const pick = scriptCompilePick((items) => items.find((i) => i.label === 'Other.esp'));
    const { handler } = registered(client, { viewSelection: [row(OTHER)] });

    await handler();

    expect(pick.items).toEqual(ALL_ITEMS);
    expect(pick.activeItems).toEqual([OTHER_ITEM]);
    expect(pick.placeholder).toBe('Compile which plugin?');
    expect(compileCalls(client)).toEqual([[[OTHER]]]);
  });

  it('from the palette, leads with the selected plugin whatever the case of its row\'s name and origin', async () => {
    const client = new InMemoryMEditClient();
    const pick = scriptCompilePick(() => undefined);
    const { handler } = registered(client, { viewSelection: [row({ name: 'other.ESP', origin: 'modb' })] });

    await handler();

    expect(pick.items).toEqual(ALL_ITEMS);
    expect(pick.activeItems).toEqual([OTHER_ITEM]);
  });

  it('from the palette, marks nothing when no compilable plugin is selected', async () => {
    const client = new InMemoryMEditClient();
    const pick = scriptCompilePick(() => undefined);
    const { handler } = registered(client);

    await handler();

    expect(pick.activeItems).toEqual([]);
  });

  it('from the palette, compiles nothing when the pick is dismissed', async () => {
    const client = new InMemoryMEditClient();
    scriptCompilePick(() => undefined);
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
      webviewSection: 'recordHeader', argument: { kind: 'record', formKey: '000801:Second.esp', plugin: { name: 'Second.esp', origin: 'ModA' } },
      compilable: false, editable: false, preventDefaultContextMenuItems: true,
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
    const value = valueWithFolders({ overwriteDir: '/instance/overwrite' });

    new CompileProblems(diagnostics)
      .publish({ name: 'Stray.esp', origin: 'overwrite/' }, originFiles(value, 'overwrite/'), diagnosticAt('Source/Stray.psc'));

    expect(publishedPaths(diagnostics)).toEqual(['/instance/overwrite/Source/Stray.psc']);
  });

  it("replaces the plugin's own entries, and leaves every other plugin's, its mod's included", () => {
    const diagnostics = new FakeDiagnosticCollection();
    const problems = new CompileProblems(diagnostics);
    const value = valueWithFolders({ modDirs: new Map([['ModA', '/instance/mods/ModA'], ['ModB', '/instance/mods/ModB']]) });
    const a = { name: 'A.esp', origin: 'ModA' };
    const also = { name: 'Also.esp', origin: 'ModA' };
    const b = { name: 'B.esp', origin: 'ModB' };
    problems.publish(a, originFiles(value, 'ModA'), diagnosticAt('A.esp/Old.json'));
    problems.publish(also, originFiles(value, 'ModA'), diagnosticAt('Also.esp/Kept.json'));
    problems.publish(b, originFiles(value, 'ModB'), diagnosticAt('B.esp/Other.json'));

    problems.publish(a, originFiles(value, 'ModA'), diagnosticAt('A.esp/New.json'));

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

