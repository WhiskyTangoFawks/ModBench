import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('../../test/taskDouble')).taskModule());

import { executeCommand, runRegisteredTask } from '../../test/taskDouble';
import { recordingReporter } from '../../test/surfacingDoubles';
import type { BuildOutcome } from '../../client';
import { AgentCall, type PartialFailure } from '../../drivingLib/agentGesture';
import { registerBuildTask } from '../buildTask';

type Landed = BuildOutcome['landed'][number];
const landed = (overrides: Partial<Landed> = {}): Landed =>
  ({ mod: 'ModA', compiled: [], refused: [], archivesRefused: [], overwritten: [], steps: [], made: [], ...overrides });
const applied = (outcome: BuildOutcome) => ({ applied: true, outcome });
const DEFINITION = { type: 'modbench.mod.build' };

function build(definition: object, answered: unknown) {
  const reporter = recordingReporter();
  registerBuildTask(reporter);
  return runRegisteredTask(definition, { resolves: answered }).then((run) => ({ ...run, reporter }));
}

describe('the build task', () => {
  it('builds the mods its definition names, as an agent call does, and passes when every mod landed whole', async () => {
    const { written, closedWith, reporter } = await build(
      { ...DEFINITION, mods: ['ModA', 'ModB'] }, applied({ landed: [landed(), landed({ mod: 'ModB' })], refused: [] }),
    );

    expect(executeCommand).toHaveBeenCalledWith('modbench.mod.build', new AgentCall([{ kind: 'mod', name: 'ModA' }, { kind: 'mod', name: 'ModB' }], {}));
    expect([written, closedWith, reporter.shownFailures]).toEqual(['Built "ModA".\r\nBuilt "ModB".\r\n', [0], []]);
  });

  it('names no mod when its definition names none', async () => {
    await build(DEFINITION, applied({ landed: [], refused: [] }));

    expect(executeCommand).toHaveBeenCalledWith('modbench.mod.build', new AgentCall([], {}));
  });

  it('passes when the build only warned, and writes the warning to the terminal and the Output', async () => {
    const warning: PartialFailure = { message: 'Build overwrote 1 file that differed.', detail: '"a.txt (ModA)"', severity: 'warning' };
    const answered = { applied: true, outcome: { landed: [landed({ overwritten: ['a.txt'] })], refused: [] }, partial: [warning] };

    const { written, closedWith, reporter } = await build(DEFINITION, answered);

    expect([written, closedWith, reporter.shownFailures]).toEqual([
      'Build overwrote 1 file that differed. "a.txt (ModA)"\r\nBuilt "ModA".\r\n', [0],
      [{ severity: 'warning', message: 'Build overwrote 1 file that differed.', detail: '"a.txt (ModA)"' }],
    ]);
  });

  it.each([
    ['a mod refused', { landed: [], refused: [{ item: 'ModC', reason: 'no repository' }] }, 'Could not build "ModC": no repository'],
    [
      'a plugin refused in a built mod',
      { landed: [landed({ refused: [{ item: { name: 'A.esp', origin: 'ModA' }, reason: 'light range' }] })], refused: [] },
      'Could not build "A.esp (ModA)" in "ModA". light range',
    ],
    [
      'an archive refused in a built mod',
      { landed: [landed({ archivesRefused: [{ item: 'A.ba2', reason: 'too large' }] })], refused: [] },
      'Could not pack "A.ba2" in "ModA". too large',
    ],
    ['a mod built in part', { landed: [landed({ failure: 'archive step' })], refused: [] }, 'Built 1 mod only in part. "ModA" (archive step)'],
  ])('fails with %s, writing it and no bare line for the mod it left unfinished', async (_name, outcome, text) => {
    const { written, closedWith, reporter } = await build(DEFINITION, applied(outcome));

    expect([written, closedWith, reporter.shownFailures.map(({ severity }) => severity)]).toEqual([`${text}\r\n`, [1], ['error']]);
  });

  it('fails on a refusal beside a mod that landed whole, writing the refusal first and the mod as built', async () => {
    const { written, closedWith } = await build(DEFINITION, applied({
      landed: [landed({ mod: 'ModB' }), landed({ failure: 'archive step' })], refused: [{ item: 'ModC', reason: 'no repository' }],
    }));

    expect([written, closedWith]).toEqual([
      'Could not build "ModC": no repository\r\nBuilt 1 mod only in part. "ModA" (archive step)\r\nBuilt "ModB".\r\n', [1],
    ]);
  });

  it('fails with the refusal of a whole build, and writes its words', async () => {
    const { written, closedWith, reporter } = await build(DEFINITION, { applied: false, refusal: 'Save first.', detail: 'A.psc' });

    expect([written, closedWith, reporter.shownFailures]).toEqual([
      'Save first. A.psc\r\n', [1], [{ severity: 'error', message: 'Save first.', detail: 'A.psc' }],
    ]);
  });

  it('fails on a definition whose mods are not a list of names, without building', async () => {
    const { written, closedWith } = await build({ ...DEFINITION, mods: 'ModA' }, applied({ landed: [], refused: [] }));

    expect([written, closedWith]).toEqual(['A build task\'s "mods" is a list of mod names.\r\n', [1]]);
    expect(executeCommand).not.toHaveBeenCalled();
  });
});
