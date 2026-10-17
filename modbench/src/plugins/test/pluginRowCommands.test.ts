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
  registerDecompileAndCommitCommand, registerBuildCommand, registerDecompileCommand, BuildProblems,
} from '../pluginRowCommands';
import { sourceFiles } from '../../instanceLoader/loadOrderSnapshot';
import { instanceValueFixture, modOfOriginIn } from '../../test/mo2/instanceValueFixture';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { type InitOutcome, type InitStatus, type PluginAddress, type WriteRefused } from '../../client';
import { PluginNode } from '../pluginRows';
import { AgentCall } from '../../drivingLib/agentGesture';
import { assertAskedOnce, recordingReporter, scriptedDialog } from '../../test/surfacingDoubles';
import { FakeDiagnosticCollection } from '../../test/vscodeMock';
import { compiledPluginFixture } from '../../client/test/fixtures';
import { present } from '../../ports/present';

beforeEach(() => {
  handlers.clear();
  progressSteps.length = 0;
  vi.clearAllMocks();
});

describe('modbench.mod.decompileAndCommit', () => {
  const FIRST = { name: 'First.esp', origin: 'ModA' };
  const SECOND = { name: 'Second.esp', origin: 'ModA' };
  const OTHER = { name: 'Other.esp', origin: 'ModB' };
  const MOD_DIRS = new Map([['ModA', '/mods/ModA'], ['ModB', '/mods/ModB'], ['ModC', '/mods/ModC']]);
  const modA = (plugins: PluginAddress[]) => ({ mod: 'ModA', plugins });
  const modB = (plugins: PluginAddress[]) => ({ mod: 'ModB', plugins });

  class ModsRowStandIn extends TreeItem {
    readonly kind = 'mod';
    readonly argument: { kind: 'mod'; name: string };
    constructor(name: string) { super(name); this.argument = { kind: 'mod', name }; }
  }

  function row(plugin: { name: string; origin: string }): PluginNode {
    return new PluginNode({ name: plugin.name, enabled: true }, plugin.origin);
  }

  function decompileAndCommitCommands() {
    let answer: InitOutcome | WriteRefused = { landed: [], refused: [] };
    const decompileAndCommit = vi.fn((_mods: readonly string[], _options?: { onProgress?: (status: InitStatus) => void }) => Promise.resolve(answer));
    return {
      decompileAndCommit,
      answers: (next: InitOutcome | WriteRefused) => { answer = next; },
      sent: () => decompileAndCommit.mock.calls.map(([mods]) => mods),
    };
  }

  function invokeDecompileAndCommit(
    commands: ReturnType<typeof decompileAndCommitCommands>, onCommitted = vi.fn().mockResolvedValue(undefined),
    paletteSelection: () => readonly unknown[] = () => [],
  ) {
    const said: (string | undefined)[] = [];
    const progress = { say: (message: string | undefined) => said.push(message) };
    const reporter = recordingReporter();
    registerDecompileAndCommitCommand({
      progress, instance: instanceThatReads, commands, reporter, onCommitted, modsView: 'modbench.modList', modOfOrigin: modOfOriginIn(...MOD_DIRS.keys()),
    }, paletteSelection);
    return {
      handler: present(handlers.get('modbench.mod.decompileAndCommit'), 'the decompile and commit command registerDecompileAndCommitCommand registers'),
      onCommitted, reporter, said,
    };
  }

  it('on a plugin row, decompiles and commits the plugin\'s mod, asking nothing', async () => {
    const commands = decompileAndCommitCommands();
    commands.answers({ landed: [modA([FIRST, SECOND])], refused: [] });
    const { handler, onCommitted, reporter } = invokeDecompileAndCommit(commands);

    await handler(row(FIRST));

    expect(commands.sent()).toEqual([['ModA']]);
    expect(createQuickPick).not.toHaveBeenCalled();
    expect(showQuickPick).not.toHaveBeenCalled();
    expect(reporter.landings).toEqual(['Decompiled and committed "ModA".']);
    expect(reporter.reports).toEqual([]);
    expect(onCommitted).toHaveBeenCalledOnce();
  });

  it('ends the gesture on a read the Instance loader makes after the decompile and commit, and clears its message line', async () => {
    const commands = decompileAndCommitCommands();
    commands.answers({ landed: [modA([FIRST, SECOND])], refused: [] });
    const { handler, said } = invokeDecompileAndCommit(commands);

    await handler(row(FIRST));

    expect(progressSteps).toEqual([
      'progress opens on modbench.pluginListTree', 'Instance loader: read every file again', 'progress closes',
    ]);
    expect(said.at(-1)).toBeUndefined();
  });

  it('shows the Mods view\'s bar when a Mods row was clicked', async () => {
    const commands = decompileAndCommitCommands();
    commands.answers({ landed: [modA([FIRST, SECOND])], refused: [] });
    const { handler } = invokeDecompileAndCommit(commands);

    await handler(new ModsRowStandIn('ModA'));

    expect(progressSteps[0]).toBe('progress opens on modbench.modList');
  });

  it('on selected plugin rows of one mod, decompiles and commits that mod once', async () => {
    const commands = decompileAndCommitCommands();
    commands.answers({ landed: [modA([FIRST, SECOND])], refused: [] });
    const { handler } = invokeDecompileAndCommit(commands);

    await handler(row(SECOND), [row(FIRST), row(SECOND)]);

    expect(commands.sent()).toEqual([['ModA']]);
  });

  it('on selected Mods rows, decompiles and commits every mod in one call', async () => {
    const commands = decompileAndCommitCommands();
    commands.answers({ landed: [modA([FIRST, SECOND]), modB([OTHER])], refused: [] });
    const { handler, reporter } = invokeDecompileAndCommit(commands);
    const mods = [new ModsRowStandIn('ModA'), new ModsRowStandIn('ModB')];

    await handler(mods[1], mods);

    expect(commands.sent()).toEqual([['ModA', 'ModB']]);
    expect(reporter.landings).toEqual(['Decompiled and committed 2 mods.']);
  });

  it('names a row that carries neither a mod nor a plugin, and decompiles and commits the rest', async () => {
    const commands = decompileAndCommitCommands();
    commands.answers({ landed: [modA([FIRST, SECOND])], refused: [] });
    const { handler, reporter } = invokeDecompileAndCommit(commands);
    const withoutArgument = { label: 'Odd', kind: 'plugin', plugin: { name: FIRST.name }, origin: FIRST.origin };

    await handler(row(FIRST), [row(FIRST), withoutArgument]);

    expect(commands.sent()).toEqual([['ModA']]);
    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not decompile and commit 1 of 3 plugins.', detail: '"Odd" (it carries no mod or plugin)',
    }]);
  });

  it('from the palette, decompiles and commits the mod of a Plugins selection', async () => {
    const commands = decompileAndCommitCommands();
    commands.answers({ landed: [modB([OTHER])], refused: [] });
    const { handler, reporter } = invokeDecompileAndCommit(commands, undefined, () => [row(OTHER)]);

    await handler();

    expect(commands.sent()).toEqual([['ModB']]);
    expect(reporter.landings).toEqual(['Decompiled and committed "ModB".']);
  });

  it('on an Editor column header, decompiles and commits the column plugin\'s mod', async () => {
    const commands = decompileAndCommitCommands();
    commands.answers({ landed: [modA([FIRST, SECOND])], refused: [] });
    const { handler } = invokeDecompileAndCommit(commands);
    const header = {
      webviewSection: 'recordHeader', argument: { kind: 'record', formKey: '000801:Other.esp', plugin: { name: 'Second.esp', origin: 'ModA' } },
      editable: false, preventDefaultContextMenuItems: true,
    };

    await handler(header);

    expect(commands.sent()).toEqual([['ModA']]);
  });

  it('names a mod mEdit refused while the rest land', async () => {
    const commands = decompileAndCommitCommands();
    commands.answers({
      landed: [modA([FIRST])],
      refused: [{ item: 'ModC', reason: 'ModC provides no plugin.' }],
    });
    const { handler, onCommitted, reporter } = invokeDecompileAndCommit(commands);
    const mods = [new ModsRowStandIn('ModA'), new ModsRowStandIn('ModC')];

    await handler(mods[0], mods);

    expect(commands.sent()).toEqual([['ModA', 'ModC']]);
    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not decompile and commit 1 of 2 mods.', detail: '"ModC" (ModC provides no plugin.)',
    }]);
    expect(reporter.landings).toEqual([]);
    expect(onCommitted).toHaveBeenCalledOnce();
  });

  it('never sends an origin that is not a mod as a mod name: refuses that plugin as not in a mod and decompiles and commits the rest', async () => {
    const commands = decompileAndCommitCommands();
    commands.answers({ landed: [modB([OTHER])], refused: [] });
    const { handler, onCommitted, reporter } = invokeDecompileAndCommit(commands);
    const loose = { name: 'Loose.esp', origin: 'Overwrite' };

    await handler(row(OTHER), [row(OTHER), row(loose)]);

    expect(commands.sent()).toEqual([['ModB']]);
    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not decompile and commit 1 of 2 plugins.', detail: '"Loose.esp (Overwrite)" (it is not in a mod)',
    }]);
    expect(onCommitted).toHaveBeenCalledOnce();
  });

  it('calls mEdit with nothing when every plugin selected is in no mod, and names each', async () => {
    const commands = decompileAndCommitCommands();
    const { handler, onCommitted, reporter } = invokeDecompileAndCommit(commands);

    await handler(row({ name: 'Loose.esp', origin: 'Overwrite' }));

    expect(commands.sent()).toEqual([]);
    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not decompile and commit 1 of 1 plugins.', detail: '"Loose.esp (Overwrite)" (it is not in a mod)',
    }]);
    expect(onCommitted).not.toHaveBeenCalled();
  });

  it('sends the mod as the instance spells it when the plugin\'s origin differs in case', async () => {
    const commands = decompileAndCommitCommands();
    commands.answers({ landed: [modA([FIRST])], refused: [] });
    const { handler } = invokeDecompileAndCommit(commands);

    await handler(row({ name: 'First.esp', origin: 'moda' }));

    expect(commands.sent()).toEqual([['ModA']]);
  });

  it('reports the ready-to-show message at error and lands nothing when the backend refuses the whole selection', async () => {
    const commands = decompileAndCommitCommands();
    commands.answers({ refused: true, message: 'Could not decompile and commit 1 mod — git was not found on PATH.' });
    const { handler, onCommitted, reporter } = invokeDecompileAndCommit(commands);

    await handler(row(OTHER));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not decompile and commit 1 mod — git was not found on PATH.', detail: undefined },
    ]);
    expect(reporter.landings).toEqual([]);
    expect(onCommitted).not.toHaveBeenCalled();
  });

  it('names the mod it is about to decompile and commit before mEdit answers, then the mod mEdit reports progress on, phase included', async () => {
    const commands = decompileAndCommitCommands();
    commands.answers({ landed: [modA([FIRST, SECOND]), modB([OTHER])], refused: [] });
    const { handler, said } = invokeDecompileAndCommit(commands);
    const mods = [new ModsRowStandIn('ModA'), new ModsRowStandIn('ModB')];

    await handler(mods[0], mods);

    expect(said).toContain('Decompiling and committing "ModA"…');

    const [, options] = present(commands.decompileAndCommit.mock.calls[0], 'the decompile and commit call');
    said.length = 0;
    present(options, 'the decompile and commit options').onProgress?.({ mod: 'ModB', phase: 'Committing', pluginsDone: 2, pluginsTotal: 2 });

    expect(said).toEqual(['Decompiling and committing "ModB" — committing to git…']);
  });

  describe('called by the agent', () => {
    const calling = (...mods: string[]) => new AgentCall(mods.map((name) => ({ kind: 'mod' as const, name })), {});

    it('decompiles and commits the mods given, never the selection, reporting nothing, and answers the outcome', async () => {
      const commands = decompileAndCommitCommands();
      const outcome = { landed: [modB([OTHER])], refused: [{ item: 'ModC', reason: 'its name gives it no source folder' }] };
      commands.answers(outcome);
      const { handler, onCommitted, reporter } = invokeDecompileAndCommit(commands, undefined, () => [row(FIRST)]);

      const answered = await handler(calling('ModB', 'ModC'));

      expect(commands.sent()).toEqual([['ModB', 'ModC']]);
      expect(answered).toEqual({ applied: true, outcome });
      expect(onCommitted).toHaveBeenCalledOnce();
      expect(reporter.reports).toEqual([]);
      expect(reporter.landings).toEqual([]);
    });

    it('answers the refusal of the whole call', async () => {
      const commands = decompileAndCommitCommands();
      commands.answers({ refused: true, message: 'the executable was not found on PATH.' });
      const { handler, onCommitted } = invokeDecompileAndCommit(commands);

      expect(await handler(calling('ModA'))).toEqual({ applied: false, refusal: 'the executable was not found on PATH.' });
      expect(onCommitted).not.toHaveBeenCalled();
    });
  });
});


const valueWithSourceDirs = (sourceDirs: ReadonlyMap<string, string>) => instanceValueFixture({
  paths: { overwriteDir: undefined, downloadsDir: undefined, modDirs: new Map(), sourceDirs },
});

describe('modbench.mod.build', () => {
  const PATCH = { name: 'MyPatch.esp', origin: 'ModA' };
  const OTHER = { name: 'Other.esp', origin: 'ModB' };
  const MOD_DIRS = new Map([['ModA', '/mods/ModA'], ['ModB', '/mods/ModB'], ['ModC', '/mods/ModC']]);
  const SOURCE_DIRS = new Map(['ModA', 'ModB', 'ModS', 'ModX'].map((mod) => [mod, `/source/${mod}`]));
  const FILES = valueWithSourceDirs(new Map(['ModA', 'ModB', 'ModS'].map((mod) => [mod, normalize(`/instance/source/${mod}`)])));
  const built = (mod: string, plugins: PluginAddress[] = [], refused: { item: PluginAddress; reason: string }[] = []) =>
    ({ mod, compiled: plugins.map((plugin) => compiledPluginFixture({ plugin })), refused, archivesRefused: [], overwritten: [] });
  const builds: [readonly string[], string | undefined][] = [];
  beforeEach(() => { builds.length = 0; });

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
        build: (mods, gameRelease, sourceDirs) => {
          progressSteps.push('build');
          builds.push([mods, gameRelease]);
          expect(sourceDirs).toBe(SOURCE_DIRS);
          return client.build([], { excludedSuffix: '', archives: null, statCache: '' });
        },
      },
      instance: instanceThatReads, gameRelease: () => 'Fallout4',
      reporter, problems: new BuildProblems(diagnostics),
      modOfOrigin: modOfOriginIn(...MOD_DIRS.keys()), sourceDirs: () => SOURCE_DIRS, modsView: 'modbench.modList',
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

  const buildCalls = () => builds.map(([mods]) => [mods]);

  it('on a Mods row, builds the mod, and the Mods view\'s progress bar closes once the Instance loader has read again, and lands once', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', { landed: [built('ModA', [PATCH])], refused: [] });
    const { handler, reporter } = registered(client);

    await handler(new ModsRowStandIn('ModA'));

    expect(builds).toEqual([[['ModA'], 'Fallout4']]);
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

    expect(buildCalls()).toEqual([[['ModA']]]);
    expect(progressSteps).toContain('progress opens on modbench.pluginListTree');
  });

  it('on a record tab\'s column header, builds the plugin\'s mod', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', { landed: [built('ModB', [OTHER])], refused: [] });
    const { handler } = registered(client, { selection: [row(PATCH)] });

    await handler({
      webviewSection: 'recordHeader', argument: { kind: 'record', formKey: '000801:Other.esp', plugin: OTHER },
      editable: true, inMod: 'sourceMod', preventDefaultContextMenuItems: true,
    });

    expect(buildCalls()).toEqual([[['ModB']]]);
  });

  it('builds the mods of a selection once each, in one call', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', { landed: [built('ModA', [PATCH]), built('ModB', [OTHER])], refused: [] });
    const { handler, reporter } = registered(client);
    const rows = [row(PATCH), new ModsRowStandIn('ModA'), row(OTHER)];

    await handler(rows[0], rows);

    expect(buildCalls()).toEqual([[['ModA', 'ModB']]]);
    expect(reporter.landings).toEqual(['Built 2 mods.']);
  });

  it('builds a source mod the mod order does not list', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', { landed: [built('ModS')], refused: [] });
    const { handler, reporter } = registered(client);

    await handler(new ModsRowStandIn('ModS'));

    expect(buildCalls()).toEqual([[['ModS']]]);
    expect(reporter.landings).toEqual(['Built "ModS".']);
  });

  it('refuses the build, naming each document VS Code did not save, and calls mEdit not at all', async () => {
    const client = new InMemoryMEditClient();
    const unsaved = normalize('/instance/source/ModA/plugin-source/MyPatch.esp/A.json');
    const { handler, reporter } = registered(client, { unsaved: { [normalize('/instance/source/ModA')]: [unsaved] } });

    await handler(new ModsRowStandIn('ModA'));

    expect(buildCalls()).toEqual([]);
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
    expect(buildCalls()).toEqual([]);
    expect(reporter.reports.map((r) => r.detail)).toEqual([unsaved]);
  });

  it('sends a mod with no folder to hold plugin source to source commands, which refuse it', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', { landed: [], refused: [{ item: 'ModX', reason: 'no repository in the source folder builds it' }] });
    const { handler, reporter } = registered(client);

    await handler(new ModsRowStandIn('ModX'));

    expect(buildCalls()).toEqual([[['ModX']]]);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not build 1 of 1 mods.', detail: '"ModX" (no repository in the source folder builds it)' },
    ]);
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

  it('sends every named mod to source commands, and names the one they refuse in their words', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', { landed: [built('ModA')], refused: [{ item: 'ModC', reason: 'no repository in the source folder builds it' }] });
    const { handler, reporter } = registered(client);
    const rows = [new ModsRowStandIn('ModA'), new ModsRowStandIn('ModC')];

    await handler(rows[0], rows);

    expect(buildCalls()).toEqual([[['ModA', 'ModC']]]);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not build 1 of 2 mods.', detail: '"ModC" (no repository in the source folder builds it)' },
    ]);
  });

  it('names a plugin no mod provides before a mod source commands refuse', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', { landed: [built('ModA')], refused: [{ item: 'ModC', reason: 'no repository in the source folder builds it' }] });
    const { handler, reporter } = registered(client);
    const rows = [new ModsRowStandIn('ModA'), new ModsRowStandIn('ModC'), row({ name: 'Loose.esp', origin: 'Overwrite' })];

    await handler(rows[0], rows);

    expect(reporter.reports.map((r) => r.detail)).toEqual(['"Loose.esp (Overwrite)" (it is not in a mod), "ModC" (no repository in the source folder builds it)']);
  });

  it('points at the Problems panel when the build left diagnostics, and puts them on the source files', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', {
      landed: [{
        mod: 'ModA', refused: [], archivesRefused: [], overwritten: [],
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
        mod: 'ModA', refused: [], archivesRefused: [], overwritten: [],
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
        mod: 'ModA', refused: [{ item: OTHER, reason: 'no source' }], archivesRefused: [], overwritten: [],
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

  it('names each archive a built mod did not pack and why, in the same notification', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', {
      landed: [{ ...built('ModA', [PATCH]), archivesRefused: [{ item: 'ModA - Main.ba2', reason: 'Modbench packs no archive for this game.' }] }],
      refused: [],
    });
    const { handler, reporter } = registered(client);

    await handler(new ModsRowStandIn('ModA'));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not build 1 archive.', detail: '"ModA - Main.ba2 (ModA)" (Modbench packs no archive for this game.)' },
    ]);
  });

  it('names the part of a mod\'s build that failed after it began writing, beside the files it overwrote', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', {
      landed: [{ ...built('ModA'), overwritten: ['a.txt'], failure: 'The build stopped before compiling: z.txt is held.' }], refused: [],
    });
    const { handler, reporter } = registered(client);

    await handler(new ModsRowStandIn('ModA'));

    expect(reporter.reports).toEqual([
      { severity: 'warning', message: 'Built 1 mod only in part.', detail: '"ModA" (The build stopped before compiling: z.txt is held.)' },
      { severity: 'warning', message: 'Build overwrote 1 file that differed.', detail: '"a.txt (ModA)"' },
    ]);
  });

  it('names each file the build overwrote that differed, beside the landing', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', {
      landed: [{ ...built('ModA', [PATCH]), overwritten: ['MyPatch.esp', 'textures/a.dds'] }, { ...built('ModB'), overwritten: ['b.nif'] }],
      refused: [],
    });
    const { handler, reporter } = registered(client);
    const rows = [new ModsRowStandIn('ModA'), new ModsRowStandIn('ModB')];

    await handler(rows[0], rows);

    expect(reporter.landings).toEqual(['Built 2 mods.']);
    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Build overwrote 3 files that differed.', detail: '"MyPatch.esp (ModA)", "textures/a.dds (ModA)", "b.nif (ModB)"',
    }]);
  });

  it.each([
    ['uncommitted', ['ModA'], 'Built 1 mod from changes no commit holds, so its manifest\'s commit does not rebuild it.', '"ModA"'],
    ['uncommitted', ['ModA', 'ModB'], 'Built 2 mods from changes no commit holds, so their manifests\' commits do not rebuild them.', '"ModA", "ModB"'],
    ['unpushed', ['ModA'], 'Built 1 mod at a commit its remote does not hold, so a clone elsewhere cannot fetch it.', '"ModA"'],
    ['unpushed', ['ModA', 'ModB'], 'Built 2 mods at commits their remotes do not hold, so a clone elsewhere cannot fetch them.', '"ModA", "ModB"'],
  ] as const)('names each mod whose manifest\'s commit does not rebuild it, %s, beside the landing', async (flag, mods, message, detail) => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', { landed: mods.map((mod) => ({ ...built(mod), [flag]: true })), refused: [] });
    const { handler, reporter } = registered(client);
    const rows = mods.map((mod) => new ModsRowStandIn(mod));

    await handler(rows[0], rows);

    expect(reporter.reports).toEqual([{ severity: 'warning', message, detail }]);
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
    expect(buildCalls()).toEqual([[['ModB']]]);
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
    expect(buildCalls()).toEqual([[['ModB']]]);
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
    expect(buildCalls()).toEqual([[['ModA', 'ModB']]]);
  });

  it('from the palette, builds nothing when the pick is dismissed', async () => {
    const client = new InMemoryMEditClient();
    showQuickPick.mockResolvedValueOnce(undefined);
    const { handler, reporter } = registered(client);

    await handler();

    expect(buildCalls()).toEqual([]);
    expect(reporter.reports).toEqual([]);
  });

  describe('called by the agent', () => {
    const calling = (...mods: string[]) => new AgentCall(mods.map((name) => ({ kind: 'mod' as const, name })), {});

    it('builds the mods given, never the selection, asking and reporting nothing, and answers the outcome', async () => {
      const client = new InMemoryMEditClient();
      const outcome = { landed: [built('ModA', [PATCH])], refused: [] };
      client.setCommandResult('build', outcome);
      const { handler, reporter, diagnostics } = registered(client, { selection: [row(OTHER)] });

      const answered = await handler(calling('ModA'));

      expect(builds).toEqual([[['ModA'], 'Fallout4']]);
      expect(answered).toEqual({ applied: true, outcome, partial: [] });
      expect(progressSteps).toContain('progress opens on modbench.modList');
      expect(showQuickPick).not.toHaveBeenCalled();
      expect(reporter.reports).toEqual([]);
      expect(reporter.landings).toEqual([]);
      expect([...diagnostics]).toEqual([]);
    });

    it('sends every named mod to source commands, and answers the refusal they name', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('build', { landed: [built('ModA')], refused: [{ item: 'ModC', reason: 'no repository in the source folder builds it' }] });
      const { handler } = registered(client);

      const answered = await handler(calling('ModA', 'ModC'));

      expect(builds).toEqual([[['ModA', 'ModC'], 'Fallout4']]);
      expect(answered).toMatchObject({ applied: true, outcome: { refused: [{ item: 'ModC', reason: 'no repository in the source folder builds it' }] } });
    });

    it('answers a plugin and an archive refused inside a built mod as partial failures', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('build', { landed: [{
        ...built('ModA', [], [{ item: PATCH, reason: 'it does not compile' }]), archivesRefused: [{ item: 'ModA - Main.ba2', reason: 'it is too large' }],
      }], refused: [] });
      const { handler, reporter } = registered(client);

      const answered = await handler(calling('ModA'));

      expect(answered).toMatchObject({ applied: true, partial: [
        { message: 'Could not build "MyPatch.esp (ModA)" in "ModA".', detail: 'it does not compile', severity: 'log' },
        { message: 'Could not pack "ModA - Main.ba2" in "ModA".', detail: 'it is too large', severity: 'log' },
      ] });
      expect(reporter.reports).toEqual([]);
    });

    it('answers a mod built in part and a file it overwrote as partial failures', async () => {
      const client = new InMemoryMEditClient();
      client.setCommandResult('build', { landed: [{ ...built('ModA'), failure: 'the archive step failed', overwritten: ['Data/A.esp'] }], refused: [] });
      const { handler } = registered(client);

      const answered = await handler(calling('ModA'));

      expect(answered).toMatchObject({ applied: true, partial: [
        { message: 'Built 1 mod only in part.', detail: '"ModA" (the archive step failed)', severity: 'warning' },
        { message: 'Build overwrote 1 file that differed.', detail: '"Data/A.esp (ModA)"', severity: 'warning' },
      ] });
    });

    it('answers the refusal when VS Code leaves a plugin source unsaved, and builds nothing', async () => {
      const client = new InMemoryMEditClient();
      const unsaved = normalize('/instance/source/ModA/plugin-source/A.json');
      const { handler, reporter } = registered(client, { unsaved: { [normalize('/instance/source/ModA')]: [unsaved] } });

      expect(await handler(calling('ModA'))).toEqual({ applied: false, refusal: 'Could not build: VS Code did not save its plugin source.', detail: unsaved });
      expect(builds).toEqual([]);
      expect(reporter.reports).toEqual([]);
    });
  });
});

describe('modbench.plugin.decompile', () => {
  const FIRST = { name: 'First.esp', origin: 'ModA' };
  const SECOND = { name: 'Second.esp', origin: 'ModA' };

  function row(plugin: { name: string; origin: string }): PluginNode {
    const node = new PluginNode({ name: plugin.name, enabled: true }, plugin.origin);
    node.contextValue = 'plugin enabled inSourceMod nonCompiledPlugin editable';
    return node;
  }

  function registered(client: InMemoryMEditClient, answer: string | undefined, viewSelection: readonly PluginNode[] = []) {
    const reporter = recordingReporter();
    const ask = scriptedDialog(answer);
    registerDecompileCommand({
      client: {
        decompile: (plugins, force) => {
          progressSteps.push('decompile');
          return client.decompile(plugins, force);
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
    expect(decompileCalls(client)).toEqual([[[SECOND], true]]);
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
    expect(decompileCalls(client)).toEqual([[[FIRST, SECOND], true]]);
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

    expect(decompileCalls(client)).toEqual([[[SECOND], true]]);
  });

  it('from the palette, decompiles the Plugins view\'s selection', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('decompile', { landed: [FIRST], refused: [] });
    const { handler } = registered(client, 'Decompile', [row(FIRST)]);

    await handler();

    expect(decompileCalls(client)).toEqual([[[FIRST], true]]);
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

describe('modbench.plugin.decompile, called by the agent', () => {
  const FIRST = { name: 'First.esp', origin: 'ModA' };
  const SECOND = { name: 'Second.esp', origin: 'ModA' };
  const calling = (...plugins: { name: string; origin: string }[]) => new AgentCall(plugins.map((plugin) => ({ kind: 'plugin' as const, plugin })), {});

  function registered(client: InMemoryMEditClient) {
    const reporter = recordingReporter();
    const ask = scriptedDialog('Decompile');
    registerDecompileCommand({ client, instance: instanceThatReads, reporter, ask }, () => [new PluginNode({ name: 'Selected.esp', enabled: true }, 'ModA')]);
    return { handler: present(handlers.get('modbench.plugin.decompile'), 'the decompile command'), reporter, ask };
  }

  it('decompiles the plugins given, never the selection, asking nothing and reporting nothing, and answers the outcome', async () => {
    const client = new InMemoryMEditClient();
    const outcome = { landed: [SECOND], refused: [{ item: FIRST, reason: 'First.esp does not round-trip through its own source.' }] };
    client.setCommandResult('decompile', outcome);
    const { handler, reporter, ask } = registered(client);

    const answered = await handler(calling(FIRST, SECOND));

    expect(client.calls.filter((c) => c.method === 'decompile').map((c) => c.args)).toEqual([[[FIRST, SECOND], false]]);
    expect(answered).toEqual({ applied: true, outcome });
    expect(ask.asked).toEqual([]);
    expect(reporter.reports).toEqual([]);
    expect(reporter.landings).toEqual([]);
  });

  it('requests the decompile forced when its options say force', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('decompile', { landed: [SECOND], refused: [] });
    const { handler } = registered(client);

    await handler(new AgentCall([{ kind: 'plugin', plugin: SECOND }], { force: true }));

    expect(client.calls.filter((c) => c.method === 'decompile').map((c) => c.args)).toEqual([[[SECOND], true]]);
  });

  it('answers the refusal of the whole selection', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('decompile', { refused: true, message: 'git was not found on PATH.' });
    const { handler, reporter } = registered(client);

    expect(await handler(calling(SECOND))).toEqual({ applied: false, refusal: 'git was not found on PATH.' });
    expect(reporter.reports).toEqual([]);
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

