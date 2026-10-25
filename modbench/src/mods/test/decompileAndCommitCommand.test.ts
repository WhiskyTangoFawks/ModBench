import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => (await import('./sourceGestureHarness')).vscodeModule());

import { instanceThatReads, progressSteps } from '../../test/recordedProgress';
import { handlers, showQuickPick, createQuickPick, PluginRowStandIn } from './sourceGestureHarness';

import { registerDecompileAndCommitCommand } from '../decompileAndCommitCommand';
import { modOfOriginIn } from '../../test/mo2/instanceValueFixture';
import { type DecompileAndCommitOutcome, type DecompileAndCommitProgress, type PluginAddress, type WriteRefused } from '../../client';
import { AgentCall } from '../../drivingLib/agentGesture';
import { recordingReporter } from '../../test/surfacingDoubles';
import { present } from '../../ports/present';
import { ModNode } from '../ModListProvider';

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

  const row = (plugin: { name: string; origin: string }) => new PluginRowStandIn(plugin);
  const modRow = (name: string) => new ModNode({ kind: 'mod', name, enabled: true });

  function decompileAndCommitCommands() {
    let answer: DecompileAndCommitOutcome | WriteRefused = { landed: [], refused: [] };
    const decompileAndCommit = vi.fn((_mods: readonly string[], _options?: { onProgress?: (status: DecompileAndCommitProgress) => void }) => Promise.resolve(answer));
    return {
      decompileAndCommit,
      answers: (next: DecompileAndCommitOutcome | WriteRefused) => { answer = next; },
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
      progress, instance: instanceThatReads, commands, reporter, onCommitted, pluginsView: 'modbench.pluginListTree', modOfOrigin: modOfOriginIn(...MOD_DIRS.keys()),
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

  it('on selected Mods rows, decompiles and commits every mod in one call under the Mods view\'s bar', async () => {
    const commands = decompileAndCommitCommands();
    commands.answers({ landed: [modA([FIRST, SECOND]), modB([OTHER])], refused: [] });
    const { handler, reporter } = invokeDecompileAndCommit(commands);
    const mods = [modRow('ModA'), modRow('ModB')];

    await handler(mods[1], mods);

    expect(commands.sent()).toEqual([['ModA', 'ModB']]);
    expect(progressSteps[0]).toBe('progress opens on modbench.modList');
    expect(reporter.landings).toEqual(['Decompiled and committed 2 mods.']);
  });

  it('from the palette, decompiles and commits the mod of a Plugins selection', async () => {
    const commands = decompileAndCommitCommands();
    commands.answers({ landed: [modB([OTHER])], refused: [] });
    const { handler, reporter } = invokeDecompileAndCommit(commands, undefined, () => [row(OTHER)]);

    await handler();

    expect(commands.sent()).toEqual([['ModB']]);
    expect(reporter.landings).toEqual(['Decompiled and committed "ModB".']);
  });

  it('names a mod mEdit refused while the rest land', async () => {
    const commands = decompileAndCommitCommands();
    commands.answers({
      landed: [modA([FIRST])],
      refused: [{ item: 'ModC', reason: 'ModC provides no plugin.' }],
    });
    const { handler, onCommitted, reporter } = invokeDecompileAndCommit(commands);
    const mods = [modRow('ModA'), modRow('ModC')];

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
    const mods = [modRow('ModA'), modRow('ModB')];

    await handler(mods[0], mods);

    expect(said).toContain('Decompiling and committing "ModA"…');

    const [, options] = present(commands.decompileAndCommit.mock.calls[0], 'the decompile and commit call');
    said.length = 0;
    present(options, 'the decompile and commit options').onProgress?.({ mod: 'ModB', phase: 'Committing', modsDone: 0, modsTotal: 1 });

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
