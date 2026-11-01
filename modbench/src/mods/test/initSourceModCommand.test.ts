import { afterAll, describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('vscode', async () => (await import('./sourceGestureHarness')).vscodeModule());

import { instanceThatReads, progressSteps } from '../../test/recordedProgress';
import { handlers, showQuickPick, createQuickPick, PluginRowStandIn } from './sourceGestureHarness';

import { registerInitSourceModCommand } from '../initSourceModCommand';
import { modOfOriginIn } from '../../test/mo2/instanceValueFixture';
import { type InitSourceModOutcome, type InitSourceModProgress, type PluginAddress, type WriteRefused } from '../../client';
import { AgentCall } from '../../drivingLib/agentGesture';
import { recordingReporter } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';
import { ModNode } from '../ModListProvider';
import { sourceCommands } from '../../sourceCommands/sourceCommands';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { fakeInstanceAdapter, modFoldersIn, readingFixture } from '../../test/fakeInstanceAdapter';
import { recordingTasks } from '../../test/recordingTasks';

const MODS = mkdtempSync(join(tmpdir(), 'init-source-mod-mods-'));
for (const mod of ['ModA', 'ModB', 'ModC']) mkdirSync(join(MODS, mod));
afterAll(() => { rmSync(MODS, { recursive: true, force: true }); });

const picking = (picked: { commit: boolean } | undefined): void => { showQuickPick.mockResolvedValue(picked); };

beforeEach(() => {
  handlers.clear();
  progressSteps.length = 0;
  vi.clearAllMocks();
  picking({ commit: true });
});

describe('modbench.mod.initSourceMod', () => {
  const FIRST = { name: 'First.esp', origin: 'ModA' };
  const SECOND = { name: 'Second.esp', origin: 'ModA' };
  const OTHER = { name: 'Other.esp', origin: 'ModB' };
  const MOD_DIRS = new Map([['ModA', '/mods/ModA'], ['ModB', '/mods/ModB'], ['ModC', '/mods/ModC']]);
  const modA = (plugins: PluginAddress[]) => ({ mod: 'ModA', plugins });
  const modB = (plugins: PluginAddress[]) => ({ mod: 'ModB', plugins });

  const row = (plugin: { name: string; origin: string }) => new PluginRowStandIn(plugin);
  const modRow = (name: string) => new ModNode({ kind: 'mod', name, enabled: true });

  function initSourceModCommands() {
    let answer: InitSourceModOutcome | WriteRefused = { landed: [], refused: [] };
    const sent: string[][] = [];
    const commits: boolean[] = [];
    const progressListeners: (((status: InitSourceModProgress) => void) | undefined)[] = [];
    const client = new InMemoryMEditClient();
    client.setCommandHandler('initSourceMod', (mods, options) => {
      sent.push(mods.map((mod) => mod.name));
      commits.push(...mods.map((mod) => mod.commit));
      progressListeners.push(options?.onProgress);
      return Promise.resolve(answer);
    });
    return {
      ...sourceCommands({
        client, adapter: fakeInstanceAdapter(readingFixture({ modFolders: modFoldersIn(MODS, 'ModA', 'ModB', 'ModC') })).adapter, saveUnsaved: () => Promise.resolve([]), tasks: recordingTasks(), trash: vi.fn()
      }),
      answers: (next: InitSourceModOutcome | WriteRefused) => { answer = next; },
      sent: () => sent,
      commits: () => commits,
      progressListeners: () => progressListeners,
    };
  }

  function invokeInitSourceMod(
    commands: ReturnType<typeof initSourceModCommands>, onCommitted = vi.fn().mockResolvedValue(undefined),
    paletteSelection: () => readonly unknown[] = () => [],
  ) {
    const said: (string | undefined)[] = [];
    const saidInMods: (string | undefined)[] = [];
    const progressIn = (view: string) => ({ say: (message: string | undefined) => (view === 'modbench.modList' ? saidInMods : said).push(message) });
    const reporter = recordingReporter();
    registerInitSourceModCommand({
      progressIn, instance: instanceThatReads, commands, reporter, onCommitted, pluginsView: 'modbench.pluginListTree', modOfOrigin: modOfOriginIn(...MOD_DIRS.keys()),
    }, paletteSelection);
    return {
      handler: present(handlers.get('modbench.mod.initSourceMod'), 'the init source mod command registerInitSourceModCommand registers'),
      onCommitted, reporter, said, saidInMods,
    };
  }

  it('on a plugin row, inits the plugin\'s mod after the one pick', async () => {
    const commands = initSourceModCommands();
    commands.answers({ landed: [modA([FIRST, SECOND])], refused: [] });
    const { handler, onCommitted, reporter } = invokeInitSourceMod(commands);

    await handler(row(FIRST));

    expect(commands.sent()).toEqual([['ModA']]);
    expect(createQuickPick).not.toHaveBeenCalled();
    expect(showQuickPick).toHaveBeenCalledOnce();
    expect(reporter.landings).toEqual(['"ModA" is a source mod.']);
    expect(reporter.reports).toEqual([]);
    expect(onCommitted).toHaveBeenCalledOnce();
  });

  it('offers not committing first, and hands mEdit the pick', async () => {
    picking({ commit: false });
    const commands = initSourceModCommands();
    commands.answers({ landed: [modA([FIRST])], refused: [] });
    const { handler } = invokeInitSourceMod(commands);

    await handler(row(FIRST));

    expect(showQuickPick.mock.calls[0]?.[0]).toEqual([expect.objectContaining({ commit: false }), expect.objectContaining({ commit: true })]);
    expect(commands.commits()).toEqual([false]);
  });

  it('inits nothing and writes nothing on Esc at the pick', async () => {
    picking(undefined);
    const commands = initSourceModCommands();
    const { handler, onCommitted, reporter } = invokeInitSourceMod(commands);

    await handler(row(FIRST));

    expect([commands.sent(), reporter.reports, reporter.landings, onCommitted.mock.calls.length]).toEqual([[], [], [], 0]);
  });

  it('ends the gesture on a read the Instance loader makes after the init source mod, and clears its message line', async () => {
    const commands = initSourceModCommands();
    commands.answers({ landed: [modA([FIRST, SECOND])], refused: [] });
    const { handler, said } = invokeInitSourceMod(commands);

    await handler(row(FIRST));

    expect(progressSteps).toEqual([
      'progress opens on modbench.pluginListTree', 'Instance loader: read every file again', 'progress closes',
    ]);
    expect(said.at(-1)).toBeUndefined();
  });

  it('on selected Mods rows, inits every mod in one call under the Mods view\'s bar', async () => {
    const commands = initSourceModCommands();
    commands.answers({ landed: [modA([FIRST, SECOND]), modB([OTHER])], refused: [] });
    const { handler, reporter } = invokeInitSourceMod(commands);
    const mods = [modRow('ModA'), modRow('ModB')];

    await handler(mods[1], mods);

    expect(commands.sent()).toEqual([['ModA', 'ModB']]);
    expect(progressSteps[0]).toBe('progress opens on modbench.modList');
    expect(reporter.landings).toEqual(['2 mods are source mods.']);
  });

  it('from the palette, inits the mod of a Plugins selection', async () => {
    const commands = initSourceModCommands();
    commands.answers({ landed: [modB([OTHER])], refused: [] });
    const { handler, reporter } = invokeInitSourceMod(commands, undefined, () => [row(OTHER)]);

    await handler();

    expect(commands.sent()).toEqual([['ModB']]);
    expect(reporter.landings).toEqual(['"ModB" is a source mod.']);
  });

  it('warns of a note on a downloaded file that could not be read whole, and the mod still lands', async () => {
    const commands = {
      ...initSourceModCommands(),
      initSourceMod: () => Promise.resolve({ landed: [modA([FIRST])], refused: [], notes: ['the hash index could not be written'] }),
    };
    const { handler, reporter, onCommitted } = invokeInitSourceMod(commands);

    await handler(row(FIRST));

    expect([reporter.reports, reporter.landings]).toEqual([
      [{ severity: 'warning', message: 'Init source mod:', detail: 'the hash index could not be written' }], ['"ModA" is a source mod.'],
    ]);
    expect(onCommitted).toHaveBeenCalledOnce();
  });

  it('names a mod mEdit refused while the rest land', async () => {
    const commands = initSourceModCommands();
    commands.answers({
      landed: [modA([FIRST])],
      refused: [{ item: 'ModC', reason: 'ModC provides no plugin.' }],
    });
    const { handler, onCommitted, reporter } = invokeInitSourceMod(commands);
    const mods = [modRow('ModA'), modRow('ModC')];

    await handler(mods[0], mods);

    expect(commands.sent()).toEqual([['ModA', 'ModC']]);
    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not init source mod for 1 of 2 mods.', detail: '"ModC" (ModC provides no plugin.)',
    }]);
    expect(reporter.landings).toEqual([]);
    expect(onCommitted).toHaveBeenCalledOnce();
  });

  it('never sends an origin that is not a mod as a mod name: refuses that plugin as not in a mod and inits the rest', async () => {
    const commands = initSourceModCommands();
    commands.answers({ landed: [modB([OTHER])], refused: [] });
    const { handler, onCommitted, reporter } = invokeInitSourceMod(commands);
    const loose = { name: 'Loose.esp', origin: 'Overwrite' };

    await handler(row(OTHER), [row(OTHER), row(loose)]);

    expect(commands.sent()).toEqual([['ModB']]);
    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not init source mod for 1 of 2 plugins.', detail: '"Loose.esp (Overwrite)" (it is not in a mod)',
    }]);
    expect(onCommitted).toHaveBeenCalledOnce();
  });

  it('calls mEdit with nothing when every plugin selected is in no mod, and names each', async () => {
    const commands = initSourceModCommands();
    const { handler, onCommitted, reporter } = invokeInitSourceMod(commands);

    await handler(row({ name: 'Loose.esp', origin: 'Overwrite' }));

    expect(commands.sent()).toEqual([]);
    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not init source mod for 1 of 1 plugins.', detail: '"Loose.esp (Overwrite)" (it is not in a mod)',
    }]);
    expect(onCommitted).not.toHaveBeenCalled();
  });

  it('reports the ready-to-show message at error and lands nothing when the backend refuses the whole selection', async () => {
    const commands = initSourceModCommands();
    commands.answers({ refused: true, message: 'Could not init source mod 1 mod — git was not found on PATH.' });
    const { handler, onCommitted, reporter } = invokeInitSourceMod(commands);

    await handler(row(OTHER));

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Could not init source mod 1 mod — git was not found on PATH.', detail: undefined },
    ]);
    expect(reporter.landings).toEqual([]);
    expect(onCommitted).not.toHaveBeenCalled();
  });

  it('says the mod and the phase on the message line of the view the gesture was fired from', async () => {
    const commands = initSourceModCommands();
    commands.answers({ landed: [modA([FIRST])], refused: [] });
    const { handler, said, saidInMods } = invokeInitSourceMod(commands);

    await handler(modRow('ModA'));

    expect([said, saidInMods.at(0)]).toEqual([[], 'Initializing source mod "ModA"…']);
  });

  it('names the mod it is about to init source mod before mEdit answers, then the mod mEdit reports progress on, phase included', async () => {
    const commands = initSourceModCommands();
    commands.answers({ landed: [modA([FIRST, SECOND]), modB([OTHER])], refused: [] });
    const { handler, saidInMods: said } = invokeInitSourceMod(commands);
    const mods = [modRow('ModA'), modRow('ModB')];

    await handler(mods[0], mods);

    expect(said).toContain('Initializing source mod "ModA"…');

    const onProgress = present(commands.progressListeners()[0], 'the progress listener the init source mod carried to mEdit');
    said.length = 0;
    onProgress({ mod: 'ModB', phase: 'Committing', modsDone: 0, modsTotal: 1 });

    expect(said).toEqual(['Initializing source mod "ModB" — writing the repository…']);
  });

  describe('called by the agent', () => {
    const calling = (...mods: string[]) => callingWith({ commit: true }, ...mods);
    const callingWith = (options: { commit: boolean }, ...mods: string[]) => new AgentCall(mods.map((name) => ({ kind: 'mod' as const, name })), options);

    it('inits the mods given, never the selection, reporting nothing, and answers the outcome', async () => {
      const commands = initSourceModCommands();
      const outcome = { landed: [modB([OTHER])], refused: [{ item: 'ModC', reason: 'its name gives it no source folder' }] };
      commands.answers(outcome);
      const { handler, onCommitted, reporter } = invokeInitSourceMod(commands, undefined, () => [row(FIRST)]);

      const answered = await handler(calling('ModB', 'ModC'));

      expect(commands.sent()).toEqual([['ModB', 'ModC']]);
      expect(answered).toEqual({ applied: true, outcome });
      expect(onCommitted).toHaveBeenCalledOnce();
      expect(reporter.reports).toEqual([]);
      expect(reporter.landings).toEqual([]);
    });

    it('hands mEdit the commit the call gives, and asks no pick', async () => {
      const commands = initSourceModCommands();
      const { handler } = invokeInitSourceMod(commands);

      await handler(callingWith({ commit: false }, 'ModA'));

      expect([commands.commits(), showQuickPick.mock.calls.length]).toEqual([[false], 0]);
    });

    it('answers the refusal of the whole call', async () => {
      const commands = initSourceModCommands();
      commands.answers({ refused: true, message: 'the executable was not found on PATH.' });
      const { handler, onCommitted } = invokeInitSourceMod(commands);

      expect(await handler(calling('ModA'))).toEqual({ applied: false, refusal: 'the executable was not found on PATH.' });
      expect(onCommitted).not.toHaveBeenCalled();
    });
  });
});
