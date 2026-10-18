import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalize } from 'node:path';

vi.mock('vscode', async () => (await import('./sourceGestureHarness')).vscodeModule());

import { progressSteps } from '../../test/recordedProgress';
import { handlers, showQuickPick, instanceThatReads, PluginRowStandIn, ModsRowStandIn } from './sourceGestureHarness';

import { registerBuildCommand } from '../buildCommand';
import { BuildProblems } from '../buildProblems';
import { sourceFiles } from '../../instanceLoader/loadOrderSnapshot';
import { modOfOriginIn } from '../../test/mo2/instanceValueFixture';
import { valueWithSourceDirs } from './sourceDirsFixture';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { type PluginAddress } from '../../client';
import { AgentCall } from '../../drivingLib/agentGesture';
import { recordingReporter } from '../../test/surfacingDoubles';
import { FakeDiagnosticCollection, TreeItem } from '../../test/vscodeMock';
import { compiledPluginFixture } from '../../client/test/fixtures';
import { present } from '../../ports/present';

beforeEach(() => {
  handlers.clear();
  progressSteps.length = 0;
  vi.clearAllMocks();
});

describe('modbench.mod.build', () => {
  const PATCH = { name: 'MyPatch.esp', origin: 'ModA' };
  const OTHER = { name: 'Other.esp', origin: 'ModB' };
  const MOD_DIRS = new Map([['ModA', '/mods/ModA'], ['ModB', '/mods/ModB'], ['ModC', '/mods/ModC']]);
  const SOURCE_DIRS = new Map(['ModA', 'ModB', 'ModS'].map((mod) => [mod, `/source/${mod}`]));
  const FILES = valueWithSourceDirs(new Map(['ModA', 'ModB', 'ModS'].map((mod) => [mod, normalize(`/instance/source/${mod}`)])));
  const built = (mod: string, plugins: PluginAddress[] = [], refused: { item: PluginAddress; reason: string }[] = []) =>
    ({ mod, compiled: plugins.map((plugin) => compiledPluginFixture({ plugin })), refused, archivesRefused: [], overwritten: [] });
  const builds: [readonly string[], string | undefined][] = [];
  beforeEach(() => { builds.length = 0; });

  function row(plugin: { name: string; origin: string }): PluginRowStandIn {
    return new PluginRowStandIn(plugin);
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
      modOfOrigin: modOfOriginIn(...MOD_DIRS.keys()), sourceDirs: () => SOURCE_DIRS, pluginsView: 'modbench.pluginListTree',
      sourceFiles: (origin) => sourceFiles(FILES, origin),
      saveUnsaved: (mod) => {
        const files = sourceFiles(FILES, mod);
        if (files === undefined) return Promise.resolve([]);
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

  it('from the palette with only a mod that is not a source mod selected, sends it to source commands without the pick', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', { landed: [], refused: [{ item: 'ModC', reason: 'no repository in the source folder builds it' }] });
    const { handler, reporter } = registered(client, { selection: [new ModsRowStandIn('ModC')] });

    await handler();

    expect(showQuickPick).not.toHaveBeenCalled();
    expect(buildCalls()).toEqual([[['ModC']]]);
    expect(reporter.reports.map((r) => r.detail)).toEqual(['"ModC" (no repository in the source folder builds it)']);
  });

  it.each([
    ['a plugin no mod provides', () => row({ name: 'Game.esm', origin: 'Data' }), '"Game.esm (Data)" (it is not in a mod)'],
    ['a row that carries no mod or plugin', () => new TreeItem('Separator'), '"Separator" (it carries no mod or plugin)'],
  ])('from the palette with only %s selected, refuses it without the pick', async (_what, selected, detail) => {
    const { handler, reporter } = registered(new InMemoryMEditClient(), { selection: [selected()] });

    await handler();

    expect(showQuickPick).not.toHaveBeenCalled();
    expect(buildCalls()).toEqual([]);
    expect(reporter.reports.map((r) => r.detail)).toEqual([detail]);
  });

  it('from the palette with no mod, picks among every source mod, and builds the picks', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('build', { landed: [built('ModA'), built('ModB')], refused: [] });
    showQuickPick.mockResolvedValueOnce([{ label: 'ModA' }, { label: 'ModB' }]);
    const { handler } = registered(client);

    await handler();

    expect(showQuickPick).toHaveBeenCalledWith(
      [{ label: 'ModA' }, { label: 'ModB' }, { label: 'ModS' }], { canPickMany: true, placeHolder: 'Build which mods?' });
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

