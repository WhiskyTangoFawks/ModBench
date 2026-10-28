import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalize } from 'node:path';

vi.mock('vscode', async () => (await import('./sourceGestureHarness')).vscodeModule());

import { instanceThatReads, progressSteps } from '../../test/recordedProgress';
import { handlers, showQuickPick, PluginRowStandIn } from './sourceGestureHarness';

import * as vscode from 'vscode';
import { registerBuildCommand } from '../buildCommand';
import { BuildProblems } from '../buildProblems';
import { ModNode } from '../ModListProvider';
import { sourceFiles } from '../../instanceLoader/loadOrderSnapshot';
import { modOfOriginIn } from '../../test/mo2/instanceValueFixture';
import { valueWithSourceDirs } from './sourceDirsFixture';
import { type PluginAddress } from '../../client';
import { AgentCall } from '../../drivingLib/agentGesture';
import { recordingReporter } from '../../test/surfacingDoubles';
import { FakeDiagnosticCollection } from '../../test/vscodeMock';
import { compiledPluginFixture } from '../../client/test/fixtures';
import { present } from '../../ports/present';

beforeEach(() => {
  handlers.clear();
  progressSteps.length = 0;
  vi.clearAllMocks();
});

type BuildDeps = Parameters<typeof registerBuildCommand>[0];
type BuildAnswer = Awaited<ReturnType<BuildDeps['commands']['build']>>;

describe('modbench.mod.build', () => {
  const PATCH = { name: 'MyPatch.esp', origin: 'ModA' };
  const OTHER = { name: 'Other.esp', origin: 'ModB' };
  const LOOSE = { name: 'Loose.esp', origin: 'Overwrite' };
  const MOD_DIRS = new Map([['ModA', '/mods/ModA'], ['ModB', '/mods/ModB'], ['ModC', '/mods/ModC']]);
  const SOURCE_MODS = ['ModA', 'ModB', 'ModS'];
  const FILES = valueWithSourceDirs(new Map(['ModA', 'ModB', 'ModS'].map((mod) => [mod, normalize(`/instance/source/${mod}`)])));
  const built = (mod: string, plugins: PluginAddress[] = [], refused: { item: PluginAddress; reason: string }[] = []) =>
    ({ mod, compiled: plugins.map((plugin) => compiledPluginFixture({ plugin })), refused, archivesRefused: [], overwritten: [], steps: [], made: [] });
  const builds: (readonly string[])[] = [];
  beforeEach(() => { builds.length = 0; });

  const row = (plugin: { name: string; origin: string }) => new PluginRowStandIn(plugin);
  const modRow = (name: string) => new ModNode({ kind: 'mod', name, enabled: true });

  function registered(outcome: BuildAnswer, options: { selection?: readonly unknown[] } = {}) {
    const reporter = recordingReporter();
    const diagnostics = new FakeDiagnosticCollection();
    registerBuildCommand({
      commands: {
        build: (mods) => {
          progressSteps.push('build');
          builds.push(mods);
          return Promise.resolve(outcome);
        },
      },
      instance: instanceThatReads,
      reporter, problems: new BuildProblems(diagnostics),
      modOfOrigin: modOfOriginIn(...MOD_DIRS.keys()), sourceModNames: () => SOURCE_MODS, pluginsView: 'modbench.pluginListTree',
      sourceFiles: (origin) => sourceFiles(FILES, origin),
    }, () => options.selection ?? []);
    return {
      handler: present(handlers.get('modbench.mod.build'), 'the build command registerBuildCommand registers'),
      reporter, diagnostics,
    };
  }

  it('on a Mods row, builds the mod, and the Mods view\'s progress bar closes once the Instance loader has read again, and lands once', async () => {
    const { handler, reporter } = registered({ landed: [built('ModA', [PATCH])], refused: [] });

    await handler(modRow('ModA'));

    expect(builds).toEqual([['ModA']]);
    expect(progressSteps).toEqual([
      'progress opens on modbench.modList', 'build', 'Instance loader: read every file again', 'progress closes',
    ]);
    expect(reporter.landings).toEqual(['Built "ModA".']);
    expect(reporter.reports).toEqual([]);
  });

  it('on a plugin row beside one no mod provides, builds the plugin\'s mod under the Plugins view\'s bar and names the other', async () => {
    const { handler, reporter } = registered({ landed: [built('ModA', [PATCH])], refused: [] });

    await handler(row(PATCH), [row(PATCH), row(LOOSE)]);

    expect(builds).toEqual([['ModA']]);
    expect(progressSteps[0]).toBe('progress opens on modbench.pluginListTree');
    expect(reporter.reports.map((r) => r.detail)).toEqual(['"Loose.esp (Overwrite)" (it is not in a mod)']);
  });

  it('names each plugin a built mod refused and why, in the same notification', async () => {
    const { handler, reporter } = registered({ landed: [built('ModA', [PATCH], [{ item: OTHER, reason: 'Other.esp is outside the light range.' }])], refused: [] });

    await handler(modRow('ModA'));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not build 1 of 2 plugins.', detail: '"Other.esp (ModB)" (Other.esp is outside the light range.)' },
    ]);
  });

  it('sends every named mod to source commands, names the one they refuse in their words, and builds the rest', async () => {
    const { handler, reporter } = registered({ landed: [built('ModA')], refused: [{ item: 'ModC', reason: 'no repository in the source folder builds it' }] });
    const rows = [modRow('ModA'), modRow('ModC')];

    await handler(rows[0], rows);

    expect(builds).toEqual([['ModA', 'ModC']]);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not build 1 of 2 mods.', detail: '"ModC" (no repository in the source folder builds it)' },
    ]);
    expect(reporter.landings).toEqual([]);
  });

  it('offers Open User Tasks with a mod refused for a tool this machine has no task for, and opens them when clicked', async () => {
    const { handler, reporter } = registered({
      landed: [], refused: [{ item: 'ModA', reason: 'was not built: this machine has no task for its tool \'Zip\' (https://example.com/zip).', refusal: 'NoTaskForTool' }],
    });

    await handler(modRow('ModA'));

    const [report] = reporter.reports;
    expect(report?.action?.title).toBe('Open User Tasks');
    report?.action?.run();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.tasks.openUserTasks');
  });

  it('names a plugin no mod provides before a mod source commands refuse', async () => {
    const { handler, reporter } = registered({ landed: [built('ModA')], refused: [{ item: 'ModC', reason: 'no repository in the source folder builds it' }] });
    const rows = [modRow('ModA'), modRow('ModC'), row(LOOSE)];

    await handler(rows[0], rows);

    expect(reporter.reports.map((r) => r.detail)).toEqual(['"Loose.esp (Overwrite)" (it is not in a mod), "ModC" (no repository in the source folder builds it)']);
  });

  it('points at the Problems panel when the build left diagnostics, and puts them on the source files', async () => {
    const { handler, reporter, diagnostics } = registered({
      landed: [{
        mod: 'ModA', refused: [], archivesRefused: [], overwritten: [], steps: [], made: [],
        compiled: [compiledPluginFixture({
          plugin: PATCH,
          diagnostics: [{ formKey: '000800:MyPatch.esp', sourceRelativePath: 'Source/A.json', message: 'Race: points at nothing' }],
        })],
      }],
      refused: [],
    });

    await handler(modRow('ModA'));

    expect(reporter.landings).toEqual(['Built "ModA" with 1 diagnostic. See the Problems panel.']);
    expect([...diagnostics].map(([uri, list]) => [uri.fsPath, list.map((d) => d.message)])).toEqual([
      [normalize('/instance/source/ModA/Source/A.json'), ['Race: points at nothing']],
    ]);
  });

  it('points at the Problems panel from the refusal notification when the plugins that compiled left diagnostics', async () => {
    const { handler, reporter } = registered({
      landed: [{
        mod: 'ModA', refused: [{ item: OTHER, reason: 'no source' }], archivesRefused: [], overwritten: [], steps: [], made: [],
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

    await handler(modRow('ModA'));

    expect(reporter.reports).toEqual([{
      severity: 'error',
      message: 'Could not build 1 of 2 plugins. The rest compiled with 2 diagnostics. See the Problems panel.',
      detail: '"Other.esp (ModB)" (no source)',
    }]);
  });

  it('names each archive a built mod did not pack and why, in the same notification', async () => {
    const { handler, reporter } = registered({
      landed: [{ ...built('ModA', [PATCH]), archivesRefused: [{ item: 'ModA - Main.ba2', reason: 'Modbench packs no archive for this game.' }] }],
      refused: [],
    });

    await handler(modRow('ModA'));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not build 1 archive.', detail: '"ModA - Main.ba2 (ModA)" (Modbench packs no archive for this game.)' },
    ]);
  });

  it('names the part of a mod\'s build that failed after it began writing, beside the files it overwrote', async () => {
    const { handler, reporter } = registered({
      landed: [{ ...built('ModA'), overwritten: ['a.txt'], failure: 'The build stopped before compiling: z.txt is held.' }], refused: [],
    });

    await handler(modRow('ModA'));

    expect(reporter.reports).toEqual([
      { severity: 'warning', message: 'Built 1 mod only in part.', detail: '"ModA" (The build stopped before compiling: z.txt is held.)' },
      { severity: 'warning', message: 'Build overwrote 1 file that differed.', detail: '"a.txt (ModA)"' },
    ]);
  });

  it('names each file the build overwrote that differed, beside the landing', async () => {
    const { handler, reporter } = registered({
      landed: [{ ...built('ModA', [PATCH]), overwritten: ['MyPatch.esp', 'textures/a.dds'] }, { ...built('ModB'), overwritten: ['b.nif'] }],
      refused: [],
    });
    const rows = [modRow('ModA'), modRow('ModB')];

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
    const { handler, reporter } = registered({ landed: mods.map((mod) => ({ ...built(mod), [flag]: true })), refused: [] });
    const rows = mods.map(modRow);

    await handler(rows[0], rows);

    expect(reporter.reports).toEqual([{ severity: 'warning', message, detail }]);
  });

  it('reports a refusal of the whole selection once, and lands nothing', async () => {
    const { handler, reporter } = registered({ refused: true, message: 'Could not build 1 mod — No load order has been received.' });

    await handler(modRow('ModA'));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not build 1 mod — No load order has been received.', detail: undefined },
    ]);
    expect(reporter.landings).toEqual([]);
  });

  it('from the palette with a selection, builds the selection without the pick', async () => {
    const { handler } = registered({ landed: [built('ModB')], refused: [] }, { selection: [modRow('ModB')] });

    await handler();

    expect(showQuickPick).not.toHaveBeenCalled();
    expect(builds).toEqual([['ModB']]);
  });

  it('from the palette with only a plugin no mod provides selected, refuses it without the pick', async () => {
    const { handler, reporter } = registered({ landed: [], refused: [] }, { selection: [row({ name: 'Game.esm', origin: 'Data' })] });

    await handler();

    expect(showQuickPick).not.toHaveBeenCalled();
    expect(builds).toEqual([]);
    expect(reporter.reports.map((r) => r.detail)).toEqual(['"Game.esm (Data)" (it is not in a mod)']);
  });

  it('from the palette with no mod, picks among every source mod, and builds the picks', async () => {
    showQuickPick.mockResolvedValueOnce([{ label: 'ModA' }, { label: 'ModB' }]);
    const { handler } = registered({ landed: [built('ModA'), built('ModB')], refused: [] });

    await handler();

    expect(showQuickPick).toHaveBeenCalledWith(
      [{ label: 'ModA' }, { label: 'ModB' }, { label: 'ModS' }], { canPickMany: true, placeHolder: 'Build which mods?' });
    expect(builds).toEqual([['ModA', 'ModB']]);
  });

  it('from the palette, builds nothing when the pick is dismissed', async () => {
    showQuickPick.mockResolvedValueOnce(undefined);
    const { handler, reporter } = registered({ landed: [], refused: [] });

    await handler();

    expect(builds).toEqual([]);
    expect(reporter.reports).toEqual([]);
  });

  describe('called by the agent', () => {
    const calling = (...mods: string[]) => new AgentCall(mods.map((name) => ({ kind: 'mod' as const, name })), {});

    it('builds the mods given, never the selection, asking and reporting nothing, and answers the outcome', async () => {
      const outcome = { landed: [built('ModA', [PATCH])], refused: [] };
      const { handler, reporter, diagnostics } = registered(outcome, { selection: [row(OTHER)] });

      const answered = await handler(calling('ModA'));

      expect(builds).toEqual([['ModA']]);
      expect(answered).toEqual({ applied: true, outcome, partial: [] });
      expect(progressSteps).toContain('progress opens on modbench.modList');
      expect(showQuickPick).not.toHaveBeenCalled();
      expect(reporter.reports).toEqual([]);
      expect(reporter.landings).toEqual([]);
      expect([...diagnostics]).toEqual([]);
    });

    it('with no mods named, builds every source in the source folder without the pick', async () => {
      const { handler } = registered({ landed: [built('ModA'), built('ModB'), built('ModS')], refused: [] });

      await handler(new AgentCall([], {}));

      expect(builds).toEqual([SOURCE_MODS]);
      expect(showQuickPick).not.toHaveBeenCalled();
    });

    it('sends every named mod to source commands, and answers the refusal they name', async () => {
      const { handler } = registered({ landed: [built('ModA')], refused: [{ item: 'ModC', reason: 'no repository in the source folder builds it' }] });

      const answered = await handler(calling('ModA', 'ModC'));

      expect(builds).toEqual([['ModA', 'ModC']]);
      expect(answered).toMatchObject({ applied: true, outcome: { refused: [{ item: 'ModC', reason: 'no repository in the source folder builds it' }] } });
    });

    it('answers a plugin and an archive refused inside a built mod as partial failures', async () => {
      const { handler, reporter } = registered({ landed: [{
        ...built('ModA', [], [{ item: PATCH, reason: 'it does not compile' }]), archivesRefused: [{ item: 'ModA - Main.ba2', reason: 'it is too large' }],
      }], refused: [] });

      const answered = await handler(calling('ModA'));

      expect(answered).toMatchObject({ applied: true, partial: [
        { message: 'Could not build "MyPatch.esp (ModA)" in "ModA".', detail: 'it does not compile', severity: 'log' },
        { message: 'Could not pack "ModA - Main.ba2" in "ModA".', detail: 'it is too large', severity: 'log' },
      ] });
      expect(reporter.reports).toEqual([]);
    });
  });
});
