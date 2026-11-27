import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import * as vscode from 'vscode';
import { modsViewOn } from './modsViewOn';
import { seen } from './modsVscode';
import { mod } from './indexedValue';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { FakeCancellationToken } from '../../test/vscodeMock';
import type { SourceCommands } from '../../sourceCommands/sourceCommands';
import { present } from '../../ports/present';

type BuildAnswer = Awaited<ReturnType<SourceCommands['build']>>;
type Landed = Extract<BuildAnswer, { landed: unknown }>['landed'][number];
const landed = (overrides: Partial<Landed> = {}): Landed =>
  ({ mod: 'ModA', compiled: [], refused: [], archivesRefused: [], ...overrides });
const DEFINITION = { type: 'modbench.mod.build' };

const startsAPseudoterminal = (execution: unknown): execution is { start: () => Promise<vscode.Pseudoterminal> } =>
  typeof execution === 'object' && execution !== null && typeof Reflect.get(execution, 'start') === 'function';

async function build(definition: vscode.TaskDefinition, answered: BuildAnswer) {
  const builds: (readonly string[] | 'every source')[] = [];
  const { reporter } = modsViewOn({
    value: instanceValueFixture({ mods: [mod('ModA'), mod('ModB')] }),
    sourceCommands: { build: (mods, everySource) => { builds.push(everySource === true ? 'every source' : mods); return Promise.resolve(answered); } },
  });
  const provider = present(seen.taskProviders.get(DEFINITION.type), 'the build task provider');
  const execution = (await provider.resolveTask(new vscode.Task(definition, vscode.TaskScope.Workspace, 'Build', 'modbench'), new FakeCancellationToken()))?.execution;
  if (!startsAPseudoterminal(execution)) throw new Error('the build task runs no pseudoterminal');
  const terminal = await execution.start();
  let written = '';
  terminal.onDidWrite((text) => { written += text; });
  const closedWith = await new Promise((resolve) => { terminal.onDidClose?.(resolve); terminal.open(undefined); });
  return { builds, written, closedWith, reporter };
}

describe('the build task', () => {
  it('builds the mods its definition names, as an agent call, and passes when every mod landed whole', async () => {
    const { builds, written, closedWith, reporter } = await build(
      { ...DEFINITION, mods: ['ModA', 'ModB'] }, { landed: [landed(), landed({ mod: 'ModB' })], refused: [] },
    );

    expect([builds, reporter.landings]).toEqual([[['ModA', 'ModB']], []]);
    expect([written, closedWith, reporter.shownFailures]).toEqual(['Built "ModA".\r\nBuilt "ModB".\r\n', 0, []]);
  });

  it('names no mod when its definition names none', async () => {
    const { builds } = await build(DEFINITION, { landed: [], refused: [] });

    expect(builds).toEqual(['every source']);
  });

  it('fails the task when the build was stopped, naming the mod it stopped and the mod it did not build (source.md, Build, story 14)', async () => {
    const { written, closedWith } = await build(DEFINITION, {
      landed: [landed({ failure: 'The build was stopped before its step 2.' })], refused: [{ item: 'ModB', reason: 'was not built: the build was stopped.' }],
    });

    expect(closedWith).toBe(1);
    expect(written).toContain('Could not build "ModB": was not built: the build was stopped.');
    expect(written).toContain('Built 1 mod only in part. "ModA" (The build was stopped before its step 2.)');
  });

  const WARNING = 'Built 1 mod from changes no commit holds, so the commit the instance repository pins does not rebuild it.';

  it('passes when the build only warned, and writes the warning to the terminal and the Output (source.md, Build, story 15)', async () => {
    const { written, closedWith, reporter } = await build(DEFINITION, { landed: [landed({ uncommitted: true })], refused: [] });

    expect([written, closedWith, reporter.shownFailures]).toEqual([
      `${WARNING} "ModA"\r\nBuilt "ModA".\r\n`, 0,
      [{ severity: 'warning', message: WARNING, detail: '"ModA"' }],
    ]);
  });

  it('warns of a mod built at a commit its remote does not hold (source.md, Build, story 15)', async () => {
    const { reporter } = await build(DEFINITION, { landed: [landed({ unpushed: true })], refused: [] });

    expect(reporter.shownFailures).toEqual([{
      severity: 'warning', message: 'Built 1 mod at a commit its remote does not hold, so a clone elsewhere cannot fetch it.', detail: '"ModA"',
    }]);
  });

  it('warns of each file a step left unwritten because the manifest ignores its path, naming it', async () => {
    const { reporter } = await build(DEFINITION, { landed: [landed({ ignored: ['F4SE/Plugins/Game.mem'] })], refused: [] });

    expect(reporter.shownFailures).toEqual([expect.objectContaining({
      severity: 'warning', message: 'Left "F4SE/Plugins/Game.mem" in "ModA" unwritten, as its manifest ignores it.',
    })]);
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
    const { written, closedWith, reporter } = await build(DEFINITION, outcome);

    expect([written, closedWith, reporter.shownFailures.map(({ severity }) => severity)]).toEqual([`${text}\r\n`, 1, ['error']]);
  });

  it('fails on a refusal beside a mod that landed whole, writing the refusal first and the mod as built', async () => {
    const { written, closedWith } = await build(DEFINITION, {
      landed: [landed({ mod: 'ModB' }), landed({ failure: 'archive step' })], refused: [{ item: 'ModC', reason: 'no repository' }],
    });

    expect([written, closedWith]).toEqual([
      'Could not build "ModC": no repository\r\nBuilt 1 mod only in part. "ModA" (archive step)\r\nBuilt "ModB".\r\n', 1,
    ]);
  });

  it('fails with the refusal of a whole build, and writes its words', async () => {
    const { written, closedWith, reporter } = await build(DEFINITION, { refused: true, message: 'Save first.' });

    expect([written, closedWith, reporter.shownFailures]).toEqual([
      'Save first.\r\n', 1, [{ severity: 'error', message: 'Save first.', detail: undefined }],
    ]);
  });

  it('fails on a definition whose mods are not a list of names, without building', async () => {
    const { builds, written, closedWith } = await build({ ...DEFINITION, mods: 'ModA' }, { landed: [], refused: [] });

    expect([written, closedWith]).toEqual(['A build task\'s "mods" is a list of mod names.\r\n', 1]);
    expect(builds).toEqual([]);
  });
});
