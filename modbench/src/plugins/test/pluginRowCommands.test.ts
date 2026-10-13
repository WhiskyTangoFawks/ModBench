import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalize } from 'node:path';

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
        Promise<{ label: string; description?: string }[] | undefined>
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
  registerTrackCommand, registerBuildCommand, registerDecompileCommand, BuildProblems,
} from '../pluginRowCommands';
import { sourceFiles } from '../../instanceLoader/loadOrderSnapshot';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { type PluginAddress } from '../../client';
import { PluginNode } from '../pluginRows';
import { assertAskedOnce, recordingReporter, scriptedDialog } from '../../test/surfacingDoubles';
import { FakeDiagnosticCollection } from '../../test/vscodeMock';
import { compiledPluginFixture } from '../../client/test/fixtures';
import { present } from '../../ports/present';

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

  it('from the palette, tracks the mod of a Plugins selection', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('track', { landed: [modB([OTHER])], refused: [] });
    const { handler, reporter } = invokeTrack(client, undefined, () => [row(OTHER)]);

    await handler();

    expect(trackCalls(client)).toEqual([{ method: 'track', args: [['ModB'], expect.anything()] }]);
    expect(reporter.landings).toEqual(['Tracked "ModB".']);
  });

  it('on an Editor column header, tracks the column plugin\'s mod', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('track', { landed: [modA([FIRST, SECOND])], refused: [] });
    const { handler } = invokeTrack(client);
    const header = {
      webviewSection: 'recordHeader', argument: { kind: 'record', formKey: '000801:Other.esp', plugin: { name: 'Second.esp', origin: 'ModA' } },
      editable: false, preventDefaultContextMenuItems: true,
    };

    await handler(header);

    expect(trackCalls(client)).toEqual([{ method: 'track', args: [['ModA'], expect.anything()] }]);
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


const valueWithSourceDirs = (sourceDirs: ReadonlyMap<string, string>) => instanceValueFixture({
  paths: { overwriteDir: undefined, downloadsDir: undefined, modDirs: new Map(), sourceDirs },
});

describe('modbench.mod.build', () => {
  const PATCH = { name: 'MyPatch.esp', origin: 'ModA' };
  const OTHER = { name: 'Other.esp', origin: 'ModB' };
  const MOD_DIRS = new Map([['ModA', '/mods/ModA'], ['ModB', '/mods/ModB'], ['ModC', '/mods/ModC']]);
  const SOURCE_MODS = new Set(['ModA', 'ModB', 'ModS', 'ModX']);
  const FILES = valueWithSourceDirs(new Map(['ModA', 'ModB', 'ModS'].map((mod) => [mod, normalize(`/instance/source/${mod}`)])));
  const built = (mod: string, plugins: PluginAddress[] = [], refused: { item: PluginAddress; reason: string }[] = []) =>
    ({ mod, compiled: plugins.map((plugin) => compiledPluginFixture({ plugin })), refused });

  class ModsRowStandIn extends TreeItem {
    readonly kind = 'mod';
    readonly argument: { kind: 'mod'; name: string };
    constructor(name: string) { super(name); this.argument = { kind: 'mod', name }; }
  }

  function row(plugin: { name: string; origin: string }): PluginNode {
    return new PluginNode({ name: plugin.name, enabled: true }, plugin.origin);
  }

  function registered(client: InMemoryMEditClient, options: { selection?: readonly unknown[]; unsaved?: Record<string, string[]> } = {}) {
    const reporter = recordingReporter();
    const diagnostics = new FakeDiagnosticCollection();
    registerBuildCommand({
      commands: {
        build: (mods) => {
          progressSteps.push('build');
          return client.build(mods);
        },
      },
      instance: instanceThatReads,
      reporter, problems: new BuildProblems(diagnostics),
      modDirs: () => MOD_DIRS, sourceMods: () => SOURCE_MODS, modsView: 'modbench.modList',
      sourceFiles: (origin) => sourceFiles(FILES, origin),
      saveUnsaved: (mod) => {
        const files = sourceFiles(FILES, mod);
        if (files === undefined) return Promise.resolve(undefined);
        const folder = files.file('');
        progressSteps.push(`save ${folder}`);
        return Promise.resolve(options.unsaved?.[folder] ?? []);
      },
    }, () => options.selection ?? []);
    return {
      handler: present(handlers.get('modbench.mod.build'), 'the build command registerBuildCommand registers'),
      reporter, diagnostics,
    };
  }

  const buildCalls = (client: InMemoryMEditClient) => client.calls.filter((c) => c.method === 'build').map((c) => c.args);

  it('on a Mods row, builds the mod, and the Mods view\'s progress bar closes once the Instance loader has read again, and lands once', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', { landed: [built('ModA', [PATCH])], refused: [] });
    const { handler, reporter } = registered(client);

    await handler(new ModsRowStandIn('ModA'));

    expect(buildCalls(client)).toEqual([[['ModA']]]);
    expect(progressSteps).toEqual([
      `save ${normalize('/instance/source/ModA')}`, 'progress opens on modbench.modList', 'build', 'Instance loader: read every file again', 'progress closes',
    ]);
    expect(reporter.landings).toEqual(['Built "ModA".']);
    expect(reporter.reports).toEqual([]);
  });

  it('on a plugin row, builds the plugin\'s mod', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', { landed: [built('ModA', [PATCH])], refused: [] });
    const { handler } = registered(client);

    await handler(row(PATCH));

    expect(buildCalls(client)).toEqual([[['ModA']]]);
    expect(progressSteps).toContain('progress opens on modbench.pluginListTree');
  });

  it('on a record tab\'s column header, builds the plugin\'s mod', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', { landed: [built('ModB', [OTHER])], refused: [] });
    const { handler } = registered(client, { selection: [row(PATCH)] });

    await handler({
      webviewSection: 'recordHeader', argument: { kind: 'record', formKey: '000801:Other.esp', plugin: OTHER },
      editable: true, inMod: 'tracked', preventDefaultContextMenuItems: true,
    });

    expect(buildCalls(client)).toEqual([[['ModB']]]);
  });

  it('builds the mods of a selection once each, in one call', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', { landed: [built('ModA', [PATCH]), built('ModB', [OTHER])], refused: [] });
    const { handler, reporter } = registered(client);
    const rows = [row(PATCH), new ModsRowStandIn('ModA'), row(OTHER)];

    await handler(rows[0], rows);

    expect(buildCalls(client)).toEqual([[['ModA', 'ModB']]]);
    expect(reporter.landings).toEqual(['Built 2 mods.']);
  });

  it('builds a source mod the mod order does not list', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', { landed: [built('ModS')], refused: [] });
    const { handler, reporter } = registered(client);

    await handler(new ModsRowStandIn('ModS'));

    expect(buildCalls(client)).toEqual([[['ModS']]]);
    expect(reporter.landings).toEqual(['Built "ModS".']);
  });

  it('refuses the build, naming each document VS Code did not save, and calls mEdit not at all', async () => {
    const client = new InMemoryMEditClient();
    const unsaved = normalize('/instance/source/ModA/plugin-source/MyPatch.esp/A.json');
    const { handler, reporter } = registered(client, { unsaved: { [normalize('/instance/source/ModA')]: [unsaved] } });

    await handler(new ModsRowStandIn('ModA'));

    expect(buildCalls(client)).toEqual([]);
    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not build: VS Code did not save its plugin source.', detail: unsaved }]);
    expect(reporter.landings).toEqual([]);
  });

  it('saves every selected mod, refuses when one of them has a document left unsaved, and builds none', async () => {
    const client = new InMemoryMEditClient();
    const unsaved = normalize('/instance/source/ModB/plugin-source/Other.esp/B.json');
    const { handler, reporter } = registered(client, { unsaved: { [normalize('/instance/source/ModB')]: [unsaved] } });
    const rows = [new ModsRowStandIn('ModA'), new ModsRowStandIn('ModB')];

    await handler(rows[0], rows);

    expect(progressSteps).toEqual([`save ${normalize('/instance/source/ModA')}`, `save ${normalize('/instance/source/ModB')}`]);
    expect(buildCalls(client)).toEqual([]);
    expect(reporter.reports.map((r) => r.detail)).toEqual([unsaved]);
  });

  it('refuses, naming the mod, when it has no folder to hold plugin source', async () => {
    const client = new InMemoryMEditClient();
    const { handler, reporter } = registered(client);

    await handler(new ModsRowStandIn('ModX'));

    expect(buildCalls(client)).toEqual([]);
    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not build: no source folder for these mods.', detail: 'ModX' }]);
  });

  it('names each refused mod and why in one notification, and builds the rest', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', {
      landed: [built('ModA', [PATCH])], refused: [{ item: 'ModB', reason: 'git was not found on PATH.' }],
    });
    const { handler, reporter } = registered(client);
    const rows = [new ModsRowStandIn('ModA'), new ModsRowStandIn('ModB')];

    await handler(rows[0], rows);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not build 1 of 2 mods.', detail: '"ModB" (git was not found on PATH.)' },
    ]);
    expect(reporter.landings).toEqual([]);
  });

  it('names each plugin a built mod refused and why, in the same notification', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', { landed: [built('ModA', [PATCH], [{ item: OTHER, reason: 'Other.esp is outside the light range.' }])], refused: [] });
    const { handler, reporter } = registered(client);

    await handler(new ModsRowStandIn('ModA'));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not build 1 of 2 plugins.', detail: '"Other.esp (ModB)" (Other.esp is outside the light range.)' },
    ]);
  });

  it('sends mEdit no mod that is not a source mod, and names it', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', { landed: [built('ModA')], refused: [] });
    const { handler, reporter } = registered(client);
    const rows = [new ModsRowStandIn('ModA'), new ModsRowStandIn('ModC')];

    await handler(rows[0], rows);

    expect(buildCalls(client)).toEqual([[['ModA']]]);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not build 1 of 2 mods.', detail: '"ModC" (it is not a source mod)' },
    ]);
  });

  it('points at the Problems panel when the build left diagnostics, and puts them on the source files', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', {
      landed: [{
        mod: 'ModA', refused: [],
        compiled: [compiledPluginFixture({
          plugin: PATCH,
          diagnostics: [{ formKey: '000800:MyPatch.esp', sourceRelativePath: 'Source/A.json', message: 'Race: points at nothing' }],
        })],
      }],
      refused: [],
    });
    const { handler, reporter, diagnostics } = registered(client);

    await handler(new ModsRowStandIn('ModA'));

    expect(reporter.landings).toEqual(['Built "ModA" with 1 diagnostic. See the Problems panel.']);
    expect([...diagnostics].map(([uri, list]) => [uri.fsPath, list.map((d) => d.message)])).toEqual([
      [normalize('/instance/source/ModA/Source/A.json'), ['Race: points at nothing']],
    ]);
  });

  it('replaces the diagnostics of each plugin that compiled, and keeps a refused plugin\'s of the same mod', async () => {
    const SIBLING = { name: 'Sibling.esp', origin: 'ModA' };
    const diagnosticOf = (plugin: { name: string }) =>
      ({ formKey: `000800:${plugin.name}`, sourceRelativePath: `${plugin.name}/A.json`, message: `${plugin.name} is broken` });
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', {
      landed: [{
        mod: 'ModA', refused: [],
        compiled: [
          compiledPluginFixture({ plugin: PATCH, diagnostics: [diagnosticOf(PATCH)] }),
          compiledPluginFixture({ plugin: SIBLING, diagnostics: [diagnosticOf(SIBLING)] }),
        ],
      }],
      refused: [],
    });
    const { handler, diagnostics } = registered(client);
    await handler(new ModsRowStandIn('ModA'));

    client.setCommandResult('build', { landed: [built('ModA', [PATCH], [{ item: SIBLING, reason: 'no source' }])], refused: [] });
    await handler(new ModsRowStandIn('ModA'));

    expect([...diagnostics].map(([uri, list]) => [uri.fsPath, list.map((d) => d.message)])).toEqual([
      [normalize('/instance/source/ModA/Sibling.esp/A.json'), ['Sibling.esp is broken']],
    ]);
  });

  it('points at the Problems panel from the refusal notification when the plugins that compiled left diagnostics', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', {
      landed: [{
        mod: 'ModA', refused: [{ item: OTHER, reason: 'no source' }],
        compiled: [compiledPluginFixture({
          plugin: PATCH,
          diagnostics: [
            { formKey: '000800:MyPatch.esp', sourceRelativePath: 'Source/A.json', message: 'Race: points at nothing' },
            { formKey: '000801:MyPatch.esp', sourceRelativePath: 'Source/B.json', message: 'Race: points at nothing' },
          ],
        })],
      }],
      refused: [],
    });
    const { handler, reporter } = registered(client);

    await handler(new ModsRowStandIn('ModA'));

    expect(reporter.reports).toEqual([{
      severity: 'error',
      message: 'Could not build 1 of 2 plugins. The rest compiled with 2 diagnostics. See the Problems panel.',
      detail: '"Other.esp (ModB)" (no source)',
    }]);
  });

  it('reports a refusal of the whole selection once, and lands nothing', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', { refused: true, message: 'Could not build 1 mod — No load order has been received.' });
    const { handler, reporter } = registered(client);

    await handler(new ModsRowStandIn('ModA'));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not build 1 mod — No load order has been received.', detail: undefined },
    ]);
    expect(reporter.landings).toEqual([]);
  });

  it('from the palette with a selection, builds the selection', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', { landed: [built('ModB')], refused: [] });
    const { handler } = registered(client, { selection: [new ModsRowStandIn('ModB')] });

    await handler();

    expect(showQuickPick).not.toHaveBeenCalled();
    expect(buildCalls(client)).toEqual([[['ModB']]]);
  });

  it.each([
    ['a mod that is not a source mod', () => new ModsRowStandIn('ModC')],
    ['a plugin no mod provides', () => row({ name: 'Game.esm', origin: 'Data' })],
    ['a row that carries no mod or plugin', () => new TreeItem('Separator')],
  ])('from the palette with %s selected, falls through to the pick of every source mod, and refuses nothing', async (_what, selected) => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', { landed: [built('ModB')], refused: [] });
    showQuickPick.mockResolvedValueOnce([{ label: 'ModB' }]);
    const { handler, reporter } = registered(client, { selection: [selected()] });

    await handler();

    expect(showQuickPick).toHaveBeenCalledOnce();
    expect(buildCalls(client)).toEqual([[['ModB']]]);
    expect(reporter.reports).toEqual([]);
  });

  it('from the palette with no mod, picks among every source mod, and builds the picks', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', { landed: [built('ModA'), built('ModB')], refused: [] });
    showQuickPick.mockResolvedValueOnce([{ label: 'ModA' }, { label: 'ModB' }]);
    const { handler } = registered(client);

    await handler();

    expect(showQuickPick).toHaveBeenCalledWith(
      [{ label: 'ModA' }, { label: 'ModB' }, { label: 'ModS' }, { label: 'ModX' }], { canPickMany: true, placeHolder: 'Build which mods?' });
    expect(buildCalls(client)).toEqual([[['ModA', 'ModB']]]);
  });

  it('from the palette, builds nothing when the pick is dismissed', async () => {
    const client = new InMemoryMEditClient();
    showQuickPick.mockResolvedValueOnce(undefined);
    const { handler, reporter } = registered(client);

    await handler();

    expect(buildCalls(client)).toEqual([]);
    expect(reporter.reports).toEqual([]);
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

describe('BuildProblems', () => {
  const diagnosticAt = (sourceRelativePath: string) => [{ formKey: '000000:MyPatch.esp', sourceRelativePath, message: 'bad' }];

  const publishedPaths = (diagnostics: FakeDiagnosticCollection) => [...diagnostics].map(([uri]) => uri.fsPath);

  it("replaces the plugin's own entries, and leaves every other plugin's, its mod's included", () => {
    const diagnostics = new FakeDiagnosticCollection();
    const problems = new BuildProblems(diagnostics);
    const value = valueWithSourceDirs(new Map([['ModA', normalize('/instance/source/ModA')], ['ModB', normalize('/instance/source/ModB')]]));
    const a = { name: 'A.esp', origin: 'ModA' };
    const also = { name: 'Also.esp', origin: 'ModA' };
    const b = { name: 'B.esp', origin: 'ModB' };
    problems.publish(a, sourceFiles(value, 'ModA'), diagnosticAt('A.esp/Old.json'));
    problems.publish(also, sourceFiles(value, 'ModA'), diagnosticAt('Also.esp/Kept.json'));
    problems.publish(b, sourceFiles(value, 'ModB'), diagnosticAt('B.esp/Other.json'));

    problems.publish(a, sourceFiles(value, 'ModA'), diagnosticAt('A.esp/New.json'));

    expect(publishedPaths(diagnostics)).toEqual([
      normalize('/instance/source/ModA/Also.esp/Kept.json'), normalize('/instance/source/ModB/B.esp/Other.json'), normalize('/instance/source/ModA/A.esp/New.json'),
    ]);
  });

  it('publishes nothing when the value knows no folder for the origin', () => {
    const diagnostics = new FakeDiagnosticCollection();

    new BuildProblems(diagnostics).publish({ name: 'A.esp', origin: 'ModA' }, undefined, diagnosticAt('Source/A.psc'));

    expect(publishedPaths(diagnostics)).toEqual([]);
  });
});

