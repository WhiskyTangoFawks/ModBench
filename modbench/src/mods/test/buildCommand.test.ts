import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import { modsViewOn } from './modsViewOn';
import { answers, seen } from './modsVscode';
import { pluginRow, PLUGINS_VIEW } from './sourceGestureHarness';
import { mod } from './indexedValue';
import { progressSteps } from '../../test/recordedProgress';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { FakeTreeView } from '../../drivingLib/test/nameFilterViewHarness';
import { type PluginAddress } from '../../client';
import { AgentCall } from '../../drivingLib/agentGesture';
import type { SourceCommands } from '../../sourceCommands/sourceCommands';
import { compiledPluginFixture } from '../../client/test/fixtures';

type BuildAnswer = Awaited<ReturnType<SourceCommands['build']>>;

const BUILD = 'modbench.mod.build';

describe('modbench.mod.build', () => {
  const PATCH = { name: 'MyPatch.esp', origin: 'ModA' };
  const OTHER = { name: 'Other.esp', origin: 'ModB' };
  const LOOSE = { name: 'Loose.esp', origin: 'Overwrite' };
  const VALUE = instanceValueFixture({
    mods: [mod('ModA'), mod('ModB'), mod('ModC')],
    paths: { overwriteDir: undefined, downloadsDir: '', modDirs: new Map(), sourceDirs: new Map([['ModA', '/source/ModA'], ['ModB', '/source/ModB'], ['ModS', '/source/ModS']]) },
  });
  const built = (mod: string, plugins: PluginAddress[] = [], refused: { item: PluginAddress; reason: string }[] = []) =>
    ({ mod, compiled: plugins.map((plugin) => compiledPluginFixture({ plugin })), refused, archivesRefused: [] });
  const row = pluginRow;

  function registered(outcome: BuildAnswer) {
    const builds: (readonly string[] | 'every source')[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const shown = modsViewOn({
      value: VALUE,
      sourceCommands: {
        build: (mods, everySource, signal) => {
          progressSteps.push('build');
          signals.push(signal);
          builds.push(everySource === true ? 'every source' : mods);
          return Promise.resolve(outcome);
        },
      },
    });
    const selectInPlugins = (rows: readonly unknown[]) => {
      const plugins = new FakeTreeView();
      shown.focusedView.follow(PLUGINS_VIEW, plugins);
      plugins.selectRows(rows);
    };
    return { ...shown, builds, signals, selectInPlugins, handler: (...args: unknown[]) => shown.run(BUILD, ...args) };
  }

  it('on a Mods row, builds the mod, and the Mods view\'s progress bar closes once the Instance loader has read again, and lands once', async () => {
    const { handler, reporter, row: modRow, builds } = registered({ landed: [built('ModA', [PATCH])], refused: [] });

    await handler(await modRow('ModA'));

    expect(builds).toEqual([['ModA']]);
    expect(progressSteps).toEqual([
      'progress opens on modbench.modList', 'build', 'progress closes',
    ]);
    expect(reporter.landings).toEqual(['Built "ModA".']);
    expect(reporter.reports).toEqual([]);
  });

  it('on a plugin row beside one no mod provides, builds the plugin\'s mod under the Plugins view\'s bar and names the other', async () => {
    const { handler, reporter, builds } = registered({ landed: [built('ModA', [PATCH])], refused: [] });

    await handler(row(PATCH), [row(PATCH), row(LOOSE)]);

    expect(builds).toEqual([['ModA']]);
    expect(progressSteps[0]).toBe('progress opens on modbench.pluginListTree');
    expect(reporter.reports.map((r) => r.detail)).toEqual(['"Loose.esp (Overwrite)" (it is not in a mod)']);
  });

  it('names each plugin a built mod refused and why, in the same notification', async () => {
    const { handler, reporter, row: modRow } = registered({ landed: [built('ModA', [PATCH], [{ item: OTHER, reason: 'Other.esp is outside the light range.' }])], refused: [] });

    await handler(await modRow('ModA'));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not build 1 of 2 plugins.', detail: '"Other.esp (ModB)" (Other.esp is outside the light range.)' },
    ]);
  });

  it('sends every named mod to source commands, names the one they refuse in their words, and builds the rest', async () => {
    const { handler, reporter, row: modRow, builds } = registered({ landed: [built('ModA')], refused: [{ item: 'ModC', reason: 'no repository in the source folder builds it' }] });
    const rows = [await modRow('ModA'), await modRow('ModC')];

    await handler(rows[0], rows);

    expect(builds).toEqual([['ModA', 'ModC']]);
    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not build 1 of 2 mods.', detail: '"ModC" (no repository in the source folder builds it)' },
    ]);
    expect(reporter.landings).toEqual([]);
  });

  it('offers Open User Tasks with a mod refused for a tool this machine has no task for, and opens them when clicked', async () => {
    const { handler, reporter, row: modRow } = registered({
      landed: [], refused: [{ item: 'ModA', reason: 'was not built: this machine has no task for its tool \'Zip\' (https://example.com/zip).', lacksATask: true }],
    });

    await handler(await modRow('ModA'));

    const [report] = reporter.reports;
    expect(report?.action?.title).toBe('Open User Tasks');
    report?.action?.run();
    expect(seen.executed).toContainEqual(['workbench.action.tasks.openUserTasks']);
  });

  it('names a plugin no mod provides before a mod source commands refuse', async () => {
    const { handler, reporter, row: modRow } = registered({ landed: [built('ModA')], refused: [{ item: 'ModC', reason: 'no repository in the source folder builds it' }] });
    const rows = [await modRow('ModA'), await modRow('ModC'), row(LOOSE)];

    await handler(rows[0], rows);

    expect(reporter.reports.map((r) => r.detail)).toEqual(['"Loose.esp (Overwrite)" (it is not in a mod), "ModC" (no repository in the source folder builds it)']);
  });

  it('points at the Problems panel when the build left diagnostics on files', async () => {
    const { handler, reporter, row: modRow } = registered({
      landed: [{
        mod: 'ModA', refused: [], archivesRefused: [],
        compiled: [compiledPluginFixture({
          plugin: PATCH,
          diagnostics: [{ formKey: '000800:MyPatch.esp', sourceRelativePath: 'Source/A.json', message: 'Race: points at nothing' }],
        })],
      }],
      refused: [],
    });

    await handler(await modRow('ModA'));

    expect(reporter.landings).toEqual(['Built "ModA" with 1 diagnostic. See the Problems panel.']);
  });

  it('names a diagnostic that is of the build and on no file itself, and does not point the Problems panel at it', async () => {
    const { handler, reporter, row: modRow } = registered({
      landed: [{
        mod: 'ModA', refused: [], archivesRefused: [],
        compiled: [compiledPluginFixture({
          plugin: PATCH,
          diagnostics: [{ message: 'MyPatch.esp compiled, but its links could not be checked: no cache' }],
        })],
      }],
      refused: [],
    });

    await handler(await modRow('ModA'));

    expect(reporter.landings).toEqual(['Built "ModA".']);
    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'A plugin compiled with a fault of the build.', detail: 'MyPatch.esp compiled, but its links could not be checked: no cache',
    }]);
  });

  it('points at the Problems panel from the refusal notification when the plugins that compiled left diagnostics', async () => {
    const { handler, reporter, row: modRow } = registered({
      landed: [{
        mod: 'ModA', refused: [{ item: OTHER, reason: 'no source' }], archivesRefused: [],
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

    await handler(await modRow('ModA'));

    expect(reporter.reports).toEqual([{
      severity: 'error',
      message: 'Could not build 1 of 2 plugins. The rest compiled with 2 diagnostics. See the Problems panel.',
      detail: '"Other.esp (ModB)" (no source)',
    }]);
  });

  it('names each archive a built mod did not pack and why, in the same notification', async () => {
    const { handler, reporter, row: modRow } = registered({
      landed: [{ ...built('ModA', [PATCH]), archivesRefused: [{ item: 'ModA - Main.ba2', reason: 'Modbench packs no archive for this game.' }] }],
      refused: [],
    });

    await handler(await modRow('ModA'));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not build 1 archive.', detail: '"ModA - Main.ba2 (ModA)" (Modbench packs no archive for this game.)' },
    ]);
  });

  it('names the part of a mod\'s build that failed after it began writing', async () => {
    const { handler, reporter, row: modRow } = registered({
      landed: [{ ...built('ModA'), failure: 'The build stopped before compiling: z.txt is held.' }], refused: [],
    });

    await handler(await modRow('ModA'));

    expect(reporter.reports).toEqual([
      { severity: 'warning', message: 'Built 1 mod only in part.', detail: '"ModA" (The build stopped before compiling: z.txt is held.)' },
    ]);
  });

  it('reports a refusal of the whole selection once, and lands nothing', async () => {
    const { handler, reporter, row: modRow } = registered({ refused: true, message: 'Could not build 1 mod — No load order has been received.' });

    await handler(await modRow('ModA'));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not build 1 mod — No load order has been received.', detail: undefined },
    ]);
    expect(reporter.landings).toEqual([]);
  });

  it('from the palette with a selection, builds the selection without the pick', async () => {
    const { handler, view, row: modRow, builds } = registered({ landed: [built('ModB')], refused: [] });
    view.selectRows([await modRow('ModB')]);

    await handler();

    expect(seen.quickPicks).toEqual([]);
    expect(builds).toEqual([['ModB']]);
  });

  it('from the palette with only a plugin no mod provides selected, refuses it without the pick', async () => {
    const { handler, reporter, builds, selectInPlugins } = registered({ landed: [], refused: [] });
    selectInPlugins([row({ name: 'Game.esm', origin: 'Data' })]);

    await handler();

    expect(seen.quickPicks).toEqual([]);
    expect(builds).toEqual([]);
    expect(reporter.reports.map((r) => r.detail)).toEqual(['"Game.esm (Data)" (it is not in a mod)']);
  });

  it('from the palette with no mod, picks among every source mod, and builds the picks', async () => {
    const { handler, builds } = registered({ landed: [built('ModA'), built('ModB')], refused: [] });
    answers.quickPick = (items) => items.filter(({ label }) => label !== 'ModS');

    await handler();

    expect(seen.quickPicks).toEqual([{ labels: ['ModA', 'ModB', 'ModS'], options: { canPickMany: true, placeHolder: 'Build which mods?' } }]);
    expect(builds).toEqual([['ModA', 'ModB']]);
  });

  it('from the palette, builds nothing when the pick is dismissed', async () => {
    const { handler, reporter, builds } = registered({ landed: [], refused: [] });

    await handler();

    expect(builds).toEqual([]);
    expect(reporter.reports).toEqual([]);
  });

  describe('called by the agent', () => {
    const calling = (...mods: string[]) => new AgentCall(mods.map((name) => ({ kind: 'mod' as const, name })), {});

    it('builds the mods given, never the selection, asking and reporting nothing, and answers the outcome', async () => {
      const outcome = { landed: [built('ModA', [PATCH])], refused: [] };
      const { handler, reporter, builds, selectInPlugins } = registered(outcome);
      selectInPlugins([row(OTHER)]);

      const answered = await handler(calling('ModA'));

      expect(builds).toEqual([['ModA']]);
      expect(answered).toEqual({ applied: true, outcome, partial: [] });
      expect(progressSteps).toContain('progress opens on modbench.modList');
      expect(seen.quickPicks).toEqual([]);
      expect(reporter.reports).toEqual([]);
      expect(reporter.landings).toEqual([]);
    });

    it('hands source commands the call\'s signal, so cancelling the call stops the build', async () => {
      const { handler, signals } = registered({ landed: [built('ModA')], refused: [] });
      const cancelled = new AbortController();

      await handler(new AgentCall([{ kind: 'mod', name: 'ModA' }], {}, cancelled.signal));

      expect(signals).toEqual([cancelled.signal]);
    });

    it('with no mods named, asks source commands for every source, read when it builds, without the pick', async () => {
      const { handler, builds } = registered({ landed: [built('ModA'), built('ModB'), built('ModS')], refused: [] });

      await handler(calling());

      expect(builds).toEqual(['every source']);
      expect(seen.quickPicks).toEqual([]);
    });

    it('sends every named mod to source commands, and answers the refusal they name', async () => {
      const { handler, builds } = registered({ landed: [built('ModA')], refused: [{ item: 'ModC', reason: 'no repository in the source folder builds it' }] });

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

    it('names an archive an unpack refused as unpacked, not packed', async () => {
      const { handler } = registered({ landed: [{ ...built('ModA', [], []), archivesRefused: [{ item: 'Base.ba2', reason: 'it holds a cubemap', unpacking: true }] }], refused: [] });

      const answered = await handler(calling('ModA'));

      expect(answered).toMatchObject({ applied: true, partial: [{ message: 'Could not unpack "Base.ba2" in "ModA".', detail: 'it holds a cubemap', severity: 'log' }] });
    });
  });
});
