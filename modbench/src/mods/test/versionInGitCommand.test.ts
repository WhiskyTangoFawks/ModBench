import { afterAll, describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import { modsViewOn, revealed } from './modsViewOn';
import { answers, seen } from './modsVscode';
import { pluginRow, PLUGINS_VIEW } from './sourceGestureHarness';
import { mod } from './indexedValue';
import { progressSteps } from '../../test/recordedProgress';
import { ORDER_SENT } from '../../test/orderSent';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { FakeTreeView } from '../../drivingLib/test/nameFilterViewHarness';
import { type VersionInGitOutcome, type PluginAddress, type WriteRefused } from '../../client';
import { AgentCall } from '../../drivingLib/agentGesture';
import { gestureName, phrase } from '../../ports/phrase';
import { sourceCommands, type SourceCommands } from '../../sourceCommands/sourceCommands';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { fakeInstanceAdapter, modFoldersIn, readingFixture } from '../../test/fakeInstanceAdapter';
import { recordingTasks } from '../../test/recordingTasks';

const MODS = mkdtempSync(join(tmpdir(), 'version-in-git-mods-'));
for (const name of ['ModA', 'ModB', 'ModC']) mkdirSync(join(MODS, name));
afterAll(() => { rmSync(MODS, { recursive: true, force: true }); });

const VERSION_IN_GIT = 'modbench.mod.versionInGit';
const WHERE = {
  NewRepository: 'A source mod in a new repository', InstanceRepository: 'A source mod in the instance repository', WholeFolder: 'The mod\'s whole folder in the instance repository',
} as const;

describe('modbench.mod.versionInGit', () => {
  const FIRST = { name: 'First.esp', origin: 'ModA' };
  const SECOND = { name: 'Second.esp', origin: 'ModA' };
  const OTHER = { name: 'Other.esp', origin: 'ModB' };
  const modA = (plugins: PluginAddress[]) => ({ mod: 'ModA', plugins });
  const modB = (plugins: PluginAddress[]) => ({ mod: 'ModB', plugins });
  const row = pluginRow;

  function invokeVersionInGit({ holdsRepository = false, versionInGit }: { holdsRepository?: boolean; versionInGit?: SourceCommands['versionInGit'] } = {}) {
    let answer: VersionInGitOutcome | WriteRefused = { landed: [], refused: [] };
    const sent: string[][] = [];
    const commits: boolean[] = [];
    const wheres: (string | null | undefined)[] = [];
    const said: (string | undefined)[] = [];
    const saidInMods: (string | undefined)[] = [];
    const onCommitted = vi.fn<() => Promise<void>>().mockResolvedValue();
    const client = new InMemoryMEditClient();
    const adapter = fakeInstanceAdapter(readingFixture({ modFolders: modFoldersIn(MODS, 'ModA', 'ModB', 'ModC') }), { repositoryOnDisk: true });
    const commands = sourceCommands({ client, adapter: adapter.adapter, saveUnsaved: () => Promise.resolve([]), loadOrderSnapshot: ORDER_SENT, tasks: recordingTasks(), trash: vi.fn() });
    const shown = modsViewOn({
      value: instanceValueFixture({
        holdsRepository, mods: [mod('ModA'), mod('ModB'), mod('ModC')],
        paths: { overwriteDir: undefined, downloadsDir: '', modDirs: new Map(), sourceDirs: new Map([['ModA', '/source/ModA'], ['ModB', '/source/ModB']]) },
      }),
      adapter,
      sourceGestures: {
        commands: versionInGit === undefined ? commands : {
          ...commands,
          versionInGit: (mods, options) => {
            saidInMods.push(shown.view.message);
            return versionInGit(mods, { ...options, onProgress: (status) => { options.onProgress?.(status); saidInMods.push(shown.view.message); } });
          },
        },
        pluginsView: PLUGINS_VIEW,
        say: (message) => { said.push(message); }, registerRepositories: onCommitted,
      },
    });
    client.setCommandHandler('versionInGit', (mods) => {
      sent.push(mods.map(({ name }) => name));
      commits.push(...mods.map((each) => each.commit === true));
      wheres.push(...mods.map((each) => each.sourceFolder.in));
      return Promise.resolve(answer);
    });
    picking('Commit');
    const selectInPlugins = (rows: readonly unknown[]) => {
      const plugins = new FakeTreeView();
      shown.focusedView.follow(PLUGINS_VIEW, plugins);
      plugins.selectRows(rows);
    };
    return {
      ...shown, onCommitted, said, saidInMods, selectInPlugins,
      handler: (...args: unknown[]) => shown.run(VERSION_IN_GIT, ...args),
      answers: (next: VersionInGitOutcome | WriteRefused) => { answer = next; },
      sent: () => sent,
      commits: () => commits,
      wheres: () => wheres,
    };
  }

  const picking = (...labels: (string | undefined)[]): void => {
    answers.quickPick = (items) => { const label = labels.shift(); return items.find((item) => item.label === label); };
  };
  const pickedAmong = () => seen.quickPicks.map(({ labels }) => labels);

  it('on a plugin row, puts the plugin\'s mod under git after the one pick', async () => {
    const commands = invokeVersionInGit();
    commands.answers({ landed: [modA([FIRST, SECOND])], refused: [] });
    const { handler, onCommitted, reporter } = commands;

    await handler(row(FIRST));

    expect([commands.sent(), commands.wheres()]).toEqual([[['ModA']], ['NewRepository']]);
    expect([seen.createdQuickPicks, pickedAmong()]).toEqual([[], [['Do not commit', 'Commit']]]);
    expect(reporter.landings).toEqual(['"ModA" is a source mod.']);
    expect(reporter.reports).toEqual([]);
    expect(onCommitted).toHaveBeenCalledOnce();
  });

  it('offers not committing first', async () => {
    const commands = invokeVersionInGit();
    const { handler } = commands;

    await handler(row(FIRST));

    expect(pickedAmong()).toEqual([['Do not commit', 'Commit']]);
  });

  it('hands mEdit the pick not to commit', async () => {
    const commands = invokeVersionInGit();
    picking('Do not commit');
    commands.answers({ landed: [modA([FIRST])], refused: [] });
    const { handler } = commands;

    await handler(row(FIRST));

    expect(commands.commits()).toEqual([false]);
  });

  it('while the instance holds a repository, asks first where git holds the mod, a new repository first', async () => {
    const { handler } = invokeVersionInGit({ holdsRepository: true });
    picking(undefined);

    await handler(row(FIRST));

    expect(pickedAmong()).toEqual([[WHERE.NewRepository, WHERE.InstanceRepository, WHERE.WholeFolder]]);
  });

  it('puts a mod\'s whole folder in the instance repository without asking mEdit, and shows no source in the Explorer', async () => {
    const commands = invokeVersionInGit({ holdsRepository: true });
    picking(WHERE.WholeFolder, 'Commit');
    const { handler, onCommitted, reporter } = commands;

    await handler(row(FIRST));

    expect([commands.sent(), revealed(), reporter.landings, reporter.reports, onCommitted.mock.calls.length]).toEqual([[], [], ['"ModA" is held whole by git.'], [], 0]);
  });

  it('hands mEdit the repository picked, then the commit picked', async () => {
    const commands = invokeVersionInGit({ holdsRepository: true });
    picking(WHERE.InstanceRepository, 'Commit');
    commands.answers({ landed: [modA([FIRST])], refused: [] });
    const { handler, reporter } = commands;

    await handler(row(FIRST));

    expect([commands.wheres(), commands.commits(), reporter.landings]).toEqual([['InstanceRepository'], [true], ['"ModA" is a source mod.']]);
  });

  it('puts nothing under git and writes nothing on Esc at where git holds the mod', async () => {
    const commands = invokeVersionInGit({ holdsRepository: true });
    picking(undefined);
    const { handler, onCommitted, reporter } = commands;

    await handler(row(FIRST));

    expect([commands.sent(), reporter.reports, pickedAmong().length, onCommitted.mock.calls.length]).toEqual([[], [], 1, 0]);
  });

  it('puts nothing under git and writes nothing on Esc at the pick', async () => {
    const commands = invokeVersionInGit();
    picking(undefined);
    const { handler, onCommitted, reporter } = commands;

    await handler(row(FIRST));

    expect([commands.sent(), reporter.reports, reporter.landings, onCommitted.mock.calls.length]).toEqual([[], [], [], 0]);
  });

  it('ends the gesture on a read the Instance loader makes after version in git, and clears its message line', async () => {
    const commands = invokeVersionInGit();
    commands.answers({ landed: [modA([FIRST, SECOND])], refused: [] });
    const { handler, said } = commands;

    await handler(row(FIRST));

    expect(progressSteps).toEqual([
      'progress opens on modbench.pluginListTree', 'progress closes',
    ]);
    expect(said.at(-1)).toBeUndefined();
  });

  it('on selected Mods rows, puts every mod under git in one call under the Mods view\'s bar', async () => {
    const commands = invokeVersionInGit();
    commands.answers({ landed: [modA([FIRST, SECOND]), modB([OTHER])], refused: [] });
    const { handler, reporter, row: modRow } = commands;
    const mods = [await modRow('ModA'), await modRow('ModB')];

    await handler(mods[1], mods);

    expect(commands.sent()).toEqual([['ModA', 'ModB']]);
    expect(progressSteps[0]).toBe('progress opens on modbench.modList');
    expect(reporter.landings).toEqual(['2 mods are source mods.']);
  });

  it('from the palette, puts the mod of a Plugins selection under git', async () => {
    const commands = invokeVersionInGit();
    commands.answers({ landed: [modB([OTHER])], refused: [] });
    const { handler, reporter } = commands;
    commands.selectInPlugins([row(OTHER)]);

    await handler();

    expect(commands.sent()).toEqual([['ModB']]);
    expect(reporter.landings).toEqual(['"ModB" is a source mod.']);
  });

  it('shows the source of the last mod that landed in the Explorer', async () => {
    const commands = invokeVersionInGit();
    commands.answers({ landed: [modA([FIRST]), modB([OTHER])], refused: [] });
    const { handler, row: modRow } = commands;
    const mods = [await modRow('ModA'), await modRow('ModB')];

    await handler(mods[0], mods);

    expect(revealed()).toEqual(['/source/ModB']);
  });

  it('shows no source when nothing landed', async () => {
    const commands = invokeVersionInGit();
    commands.answers({ landed: [], refused: [] });
    const { handler, row: modRow } = commands;

    await handler(await modRow('ModA'));

    expect(revealed()).toEqual([]);
  });

  it('warns when the source cannot be shown, and the mod still stands', async () => {
    const commands = invokeVersionInGit();
    seen.commands.set('revealInExplorer', () => { throw new Error('no explorer'); });
    commands.answers({ landed: [modA([FIRST])], refused: [] });
    const { handler, reporter } = commands;

    await handler(row(FIRST));

    expect(reporter.reports).toEqual([
      { severity: 'warning', message: 'Version in git:', detail: '"ModA" is a source mod, but its source could not be shown in the Explorer: no explorer' },
    ]);
    expect(reporter.landings).toEqual(['"ModA" is a source mod.']);
  });

  it('warns of a note on a downloaded file that could not be read whole, and the mod still lands', async () => {
    const commands = invokeVersionInGit({ versionInGit: () => Promise.resolve({ landed: [modA([FIRST])], refused: [], notes: ['the hash index could not be written'] }) });
    const { handler, reporter, onCommitted } = commands;

    await handler(row(FIRST));

    expect([reporter.reports, reporter.landings]).toEqual([
      [{ severity: 'warning', message: 'Version in git:', detail: 'the hash index could not be written' }], ['"ModA" is a source mod.'],
    ]);
    expect(onCommitted).toHaveBeenCalledOnce();
  });

  it('names a mod mEdit refused while the rest land', async () => {
    const commands = invokeVersionInGit();
    commands.answers({
      landed: [modA([FIRST])],
      refused: [{ item: 'ModC', reason: 'ModC was not initialized.' }],
    });
    const { handler, onCommitted, reporter, row: modRow } = commands;
    const mods = [await modRow('ModA'), await modRow('ModC')];

    await handler(mods[0], mods);

    expect(commands.sent()).toEqual([['ModA', 'ModC']]);
    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not put 1 of 2 mods under git.', detail: '"ModC" (ModC was not initialized.)',
    }]);
    expect(reporter.landings).toEqual([]);
    expect(onCommitted).toHaveBeenCalledOnce();
  });

  it('never sends an origin that is not a mod as a mod name: refuses that plugin as not in a mod and puts the rest under git', async () => {
    const commands = invokeVersionInGit();
    commands.answers({ landed: [modB([OTHER])], refused: [] });
    const { handler, onCommitted, reporter } = commands;
    const loose = { name: 'Loose.esp', origin: 'Overwrite' };

    await handler(row(OTHER), [row(OTHER), row(loose)]);

    expect(commands.sent()).toEqual([['ModB']]);
    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not put 1 of 2 plugins under git.', detail: '"Loose.esp (Overwrite)" (it is not in a mod)',
    }]);
    expect(onCommitted).toHaveBeenCalledOnce();
  });

  it('calls mEdit with nothing when every plugin selected is in no mod, and names each', async () => {
    const commands = invokeVersionInGit();
    const { handler, onCommitted, reporter } = commands;

    await handler(row({ name: 'Loose.esp', origin: 'Overwrite' }));

    expect(commands.sent()).toEqual([]);
    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not put 1 of 1 plugins under git.', detail: '"Loose.esp (Overwrite)" (it is not in a mod)',
    }]);
    expect(onCommitted).not.toHaveBeenCalled();
  });

  it('reports the ready-to-show message at error and lands nothing when the backend refuses the whole selection', async () => {
    const commands = invokeVersionInGit();
    commands.answers({ refused: true, message: 'Could not put 1 mod under git — git was not found on PATH.' });
    const { handler, onCommitted, reporter } = commands;

    await handler(row(OTHER));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not put 1 mod under git — git was not found on PATH.', detail: undefined },
    ]);
    expect(reporter.landings).toEqual([]);
    expect(onCommitted).not.toHaveBeenCalled();
  });

  it('says the mod and the phase on the message line of the view the gesture was fired from', async () => {
    const commands = invokeVersionInGit({ versionInGit: (_mods, { onProgress }) => {
      onProgress?.({ mod: 'ModA', phase: 'Parsing', modsDone: 0, modsTotal: 1 });
      return Promise.resolve({ landed: [modA([FIRST])], refused: [] });
    } });
    const { handler, said, saidInMods, row: modRow } = commands;

    await handler(await modRow('ModA'));

    expect([said, saidInMods]).toEqual([[], ['Version in git "ModA"…', 'Version in git "ModA" — parsing…']]);
  });

  it('names the mod it is about to version in git before mEdit answers, then the mod mEdit reports progress on, phase included', async () => {
    const commands = invokeVersionInGit({ versionInGit: (_mods, { onProgress }) => {
      onProgress?.({ mod: 'ModB', phase: 'Committing', modsDone: 0, modsTotal: 1 });
      return Promise.resolve({ landed: [modA([FIRST, SECOND]), modB([OTHER])], refused: [] });
    } });
    const { handler, saidInMods: said, row: modRow } = commands;
    const mods = [await modRow('ModA'), await modRow('ModB')];

    await handler(mods[0], mods);

    expect(said).toEqual(['Version in git "ModA"…', 'Version in git "ModB" — writing the repository…']);
  });

  describe.each([
    ['AlreadyInitialized', 'its source folder is a source mod\'s.',
      phrase`its source folder is a source mod's. To put a plugin's source into its working tree, run ${gestureName('modbench.plugin.decompile', 'decompile')} on it.`,
      "To put a plugin's source into its working tree, run decompile on it."],
    ['MalformedRepairable', 'Malformed.esp is a malformed plugin.',
      phrase`Malformed.esp is a malformed plugin. Run ${gestureName('modbench.plugin.decompileAndRepair', 'decompile and repair')} on its plugins.`,
      'Run decompile and repair on its plugins.'],
  ] as const)('a mod refused as %s', (refusal, fact, reason, remedy) => {
    const refusedAnswer = () => {
      const commands = invokeVersionInGit();
      commands.answers({ landed: [], refused: [{ item: 'ModA', reason: fact, refusal }] });
      return commands;
    };

    it('tells the view the gesture that clears it', async () => {
      const { handler, reporter, row: modRow } = refusedAnswer();

      await handler(await modRow('ModA'));

      expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not put 1 of 1 mods under git.', detail: `"ModA" (${fact} ${remedy})` }]);
    });

    it('names the gesture as data for the agent, which reads the tool that runs it', async () => {
      const { handler } = refusedAnswer();

      const answered = await handler(new AgentCall([{ kind: 'mod', name: 'ModA' }], { commit: true, where: 'NewRepository' }));

      expect(answered).toMatchObject({ applied: true, outcome: { landed: [], refused: [{ item: 'ModA', reason }] } });
    });
  });

  describe('called by the agent', () => {
    const calling = (...mods: string[]) => callingWith({ commit: true, where: 'NewRepository' }, ...mods);
    const callingWith = (options: { commit: boolean; where: string }, ...mods: string[]) => new AgentCall(mods.map((name) => ({ kind: 'mod' as const, name })), options);

    it('puts the mods given under git, never the selection, reporting nothing, and answers the outcome', async () => {
      const commands = invokeVersionInGit();
      const outcome = { landed: [modB([OTHER])], refused: [{ item: 'ModC', reason: 'its name gives it no source folder' }] };
      commands.answers(outcome);
      const { handler, onCommitted, reporter } = commands;
      commands.selectInPlugins([row(FIRST)]);

      const answered = await handler(calling('ModB', 'ModC'));

      expect(commands.sent()).toEqual([['ModB', 'ModC']]);
      expect(answered).toEqual({ applied: true, outcome });
      expect(onCommitted).toHaveBeenCalledOnce();
      expect(reporter.reports).toEqual([]);
      expect(reporter.landings).toEqual([]);
    });

    it('hands mEdit the repository and the commit the call gives, and asks no pick', async () => {
      const commands = invokeVersionInGit({ holdsRepository: true });
      const { handler } = commands;

      await handler(callingWith({ commit: false, where: 'InstanceRepository' }, 'ModA'));

      expect([commands.wheres(), commands.commits(), pickedAmong()]).toEqual([['InstanceRepository'], [false], []]);
    });

    it('answers the refusal of the whole call', async () => {
      const commands = invokeVersionInGit();
      commands.answers({ refused: true, message: 'the executable was not found on PATH.' });
      const { handler, onCommitted } = commands;

      expect(await handler(calling('ModA'))).toEqual({ applied: false, refusal: 'the executable was not found on PATH.' });
      expect(onCommitted).not.toHaveBeenCalled();
    });
  });
});
