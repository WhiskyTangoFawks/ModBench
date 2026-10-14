import { describe, it, expect, vi, beforeEach } from 'vitest';

const { handlers, registerCommand } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void> | void>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
  };
});

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return {
    commands: { registerCommand },
    window: { withProgress: recordedWithProgress },
    TreeItem: class { constructor(readonly label: string) {} },
  };
});

import { TreeItem } from 'vscode';
import { progressSteps } from '../../test/recordedProgress';
import { registerModlistCommands } from '../modlistGestures';
import { recordingReporter, scriptedDialog, type ScriptedDialog } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';
import type { ModlistSourceCommands } from '../../sourceCommands/modlistSourceCommands';

const init = vi.fn<ModlistSourceCommands['init']>();
const stage = vi.fn<ModlistSourceCommands['stage']>();
const discardChanges = vi.fn<ModlistSourceCommands['discardChanges']>();
const modsHolding = vi.fn<ModlistSourceCommands['modsHolding']>();

const value = instanceValueFixture({
  mods: [
    { kind: 'mod', name: 'ModA', enabled: true },
    { kind: 'separator', name: 'Weapons', enabled: true },
    { kind: 'mod', name: 'ModB', enabled: false },
  ],
});

const modRow = (name: string) => ({ argument: { kind: 'mod', name }, name });

function register(over: Partial<Parameters<typeof registerModlistCommands>[0]> = {}, ask: ScriptedDialog = scriptedDialog('Discard Changes')) {
  const reporter = recordingReporter();
  const said: (string | undefined)[] = [];
  registerModlistCommands({
    commands: { init, stage, discardChanges, modsHolding }, ask,
    instance: { value, refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(undefined); } },
    reporter, say: (message) => { said.push(message); }, modsView: 'modbench.modList',
    focusedView: { id: () => undefined, selection: () => [] }, ...over,
  });
  return { reporter, said, ask, run: (id: string, ...args: unknown[]) => present(handlers.get(id), `the handler for "${id}"`)(...args) };
}

beforeEach(() => {
  handlers.clear();
  progressSteps.length = 0;
  vi.clearAllMocks();
  init.mockResolvedValue({ applied: true });
  stage.mockResolvedValue({ applied: true, landed: [], refused: [] });
  discardChanges.mockResolvedValue({ applied: true, landed: [], refused: [] });
});

describe('Init', () => {
  it('makes the repository under the Toolbox\'s progress, which closes once the Instance loader has read again, and says nothing', async () => {
    init.mockImplementationOnce(() => { progressSteps.push('init'); return Promise.resolve({ applied: true }); });
    const { reporter, run } = register();

    await run('modbench.modlist.init');

    expect(progressSteps).toEqual(['progress opens on modbench.toolbox', 'init', 'Instance loader: read every file again', 'progress closes']);
    expect([reporter.reports, reporter.landings]).toEqual([[], []]);
  });

  it('reports a refusal at error, naming why', async () => {
    init.mockResolvedValueOnce({ applied: false, refusal: '/instance already holds a repository.' });
    const { reporter, run } = register();

    await run('modbench.modlist.init');

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not init the modlist.', detail: '/instance already holds a repository.' }]);
  });
});

describe('Stage', () => {
  it('says its phase on the Toolbox\'s message line while it runs, and gives the line back when it ends', async () => {
    stage.mockImplementationOnce((_mods, _instance, options) => {
      options?.onProgress?.({ phase: 'ReadingFiles', mod: 'ModA' });
      options?.onProgress?.({ phase: 'Staging', mod: 'ModA', modsDone: 0, modsTotal: 2 });
      return Promise.resolve({ applied: true, landed: [], refused: [] });
    });
    const { said, run } = register();

    await run('modbench.modlist.stage');

    expect(said).toEqual(['Staging "ModA" — reading its files…', 'Staging "ModA" — 0 of 2 mods staged…', undefined]);
  });

  it('gives the message line back when stage throws', async () => {
    stage.mockRejectedValueOnce(new Error('boom'));
    const { said, run } = register();

    await expect(run('modbench.modlist.stage')).rejects.toThrow('boom');

    expect(said).toEqual([undefined]);
  });

  it('stages every mod, no separator, disabled or not, from the palette with no Mods selection', async () => {
    const { run } = register();

    await run('modbench.modlist.stage');

    expect(stage.mock.calls.map(([mods]) => mods)).toEqual([['ModA', 'ModB']]);
  });

  it('stages the Mods selection from the palette, under the Mods view\'s progress', async () => {
    const { run } = register({ focusedView: { id: () => 'modbench.modList', selection: () => [modRow('ModB')] } });

    await run('modbench.modlist.stage');

    expect([stage.mock.calls.map(([mods]) => mods), progressSteps[0]]).toEqual([[['ModB']], 'progress opens on modbench.modList']);
  });

  it('stages every mod from the palette while another view has the focus', async () => {
    const { run } = register({ focusedView: { id: () => 'modbench.pluginListTree', selection: () => [modRow('ModB')] } });

    await run('modbench.modlist.stage');

    expect(stage.mock.calls.map(([mods]) => mods)).toEqual([['ModA', 'ModB']]);
  });

  it.each([
    ['the Source Control title bar, which passes its source control', { rootUri: undefined }],
    ['a click on the Toolbox\'s Modlist row', new TreeItem('Modlist')],
  ])('stages every mod from %s, whatever the Mods view has selected', async (_where, clicked) => {
    const { run } = register({ focusedView: { id: () => 'modbench.modList', selection: () => [modRow('ModB')] } });

    await run('modbench.modlist.stage', clicked);

    expect(stage.mock.calls.map(([mods]) => mods)).toEqual([['ModA', 'ModB']]);
  });

  it('stages the selected mods from the Mod menu', async () => {
    const { run } = register();

    await run('modbench.modlist.stage', modRow('ModB'), [modRow('ModA'), modRow('ModB')]);

    expect(stage.mock.calls.map(([mods]) => mods)).toEqual([['ModA', 'ModB']]);
  });

  it('stages under the Mods view\'s progress when a Mods row asked, and asks nothing', async () => {
    stage.mockImplementationOnce(() => { progressSteps.push('stage'); return Promise.resolve({ applied: true, landed: [], refused: [] }); });
    const { run } = register();

    await run('modbench.modlist.stage', modRow('ModA'));

    expect(progressSteps).toEqual(['progress opens on modbench.modList', 'stage', 'Instance loader: read every file again', 'progress closes']);
  });

  it('stages under the Toolbox\'s progress from anywhere else', async () => {
    const { run } = register();

    await run('modbench.modlist.stage');

    expect(progressSteps[0]).toBe('progress opens on modbench.toolbox');
  });

  it('says what it staged', async () => {
    stage.mockResolvedValueOnce({ applied: true, landed: [{ mod: 'ModA', manifestWritten: true, noProvider: [] }], refused: [] });
    const { reporter, run } = register();

    await run('modbench.modlist.stage', modRow('ModA'));

    expect(reporter.landings).toEqual(['Staged "ModA".']);
  });

  it('names each refused mod with why, and does not call the mods that landed failed', async () => {
    stage.mockResolvedValueOnce({
      applied: true,
      landed: [{ mod: 'ModA', manifestWritten: true, noProvider: [] }],
      refused: [{ item: 'ModB', reason: "'ModB' was not staged: 'B.zip' not in the downloads folder." }],
    });
    const { reporter, run } = register();

    await run('modbench.modlist.stage');

    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not stage 1 of 2 mods.', detail: `"ModB" ('ModB' was not staged: 'B.zip' not in the downloads folder.)`,
    }]);
    expect(reporter.landings).toEqual([]);
  });

  it('reports each file nothing provides, by mod, and still says the rest landed', async () => {
    stage.mockResolvedValueOnce({
      applied: true,
      landed: [{ mod: 'ModA', manifestWritten: true, noProvider: ['a.nif', 'b/c.dds'] }],
      refused: [],
    });
    const { reporter, run } = register();

    await run('modbench.modlist.stage', modRow('ModA'));

    expect(reporter.reports).toEqual([{
      severity: 'warning', message: '2 files have no provider.', detail: 'ModA: a.nif\nModA: b/c.dds',
    }]);
    expect(reporter.landings).toEqual(['Staged "ModA".']);
  });

  it('refuses a selected row that is not a mod, naming it', async () => {
    const { reporter, run } = register();

    await run('modbench.modlist.stage', modRow('ModA'), [modRow('ModA'), { argument: { kind: 'separator', name: 'Weapons' }, name: 'Weapons' }]);

    expect(stage.mock.calls.map(([mods]) => mods)).toEqual([['ModA']]);
    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not stage 1 of 2 mods.', detail: '"Weapons" (it is not a mod)' }]);
  });

  it('reports a stage mEdit refused whole', async () => {
    stage.mockResolvedValueOnce({ applied: false, refusal: 'Could not stage 2 mods — mEdit is not running.' });
    const { reporter, run } = register();

    await run('modbench.modlist.stage');

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not stage 2 mods — mEdit is not running.', detail: undefined }]);
  });
});

describe('Discard changes', () => {
  const DISCARD = 'modbench.modlist.discardChanges';
  const asked = (ask: ScriptedDialog) => ask.asked.map(({ message, detail, buttons }) => ({ message, detail, buttons }));

  it('asks once, naming the selected mods and that changes not staged and committed are lost, then discards them under the Mods view\'s progress', async () => {
    discardChanges.mockImplementationOnce(() => { progressSteps.push('discard'); return Promise.resolve({ applied: true, landed: [], refused: [] }); });
    const { ask, run } = register();

    await run(DISCARD, modRow('ModB'), [modRow('ModA'), modRow('ModB')]);

    expect(asked(ask)).toEqual([{
      message: 'Are you sure you want to discard changes in "ModA", "ModB"?', detail: 'Changes not staged and committed are lost.', buttons: ['Discard Changes'],
    }]);
    expect(discardChanges.mock.calls.map(([mods]) => mods)).toEqual([['ModA', 'ModB']]);
    expect(progressSteps).toEqual(['progress opens on modbench.modList', 'discard', 'Instance loader: read every file again', 'progress closes']);
  });

  it.each([
    ['the palette with no Mods selection', undefined],
    ['the Source Control title bar, which passes its source control', { rootUri: undefined }],
  ])('asks about every mod, and discards every mod, from %s', async (_where, clicked) => {
    const { ask, run } = register();

    await run(DISCARD, clicked);

    expect(ask.asked.map(({ message }) => message)).toEqual(['Are you sure you want to discard changes in every mod?']);
    expect([discardChanges.mock.calls.map(([mods]) => mods), progressSteps[0]]).toEqual([[['ModA', 'ModB']], 'progress opens on modbench.toolbox']);
  });

  it('discards nothing and says nothing when the question is cancelled', async () => {
    const { reporter, run } = register({}, scriptedDialog(undefined));

    await run(DISCARD, modRow('ModA'));

    expect([discardChanges.mock.calls, progressSteps, reporter.reports, reporter.landings]).toEqual([[], [], [], []]);
  });

  it('discards the mod whose folder holds each Source Control row it is given, naming a row in none', async () => {
    modsHolding.mockReturnValueOnce({ mods: ['ModA'], refused: [{ item: '/instance/profiles/Default/modlist.txt', reason: 'it is not in a mod folder' }] });
    discardChanges.mockResolvedValueOnce({ applied: true, landed: [{ mod: 'ModA', written: ['a.nif'] }], refused: [] });
    const { ask, reporter, run } = register();

    await run('modbench.modlist.discardChangesInModFolder',
      { resourceUri: { fsPath: '/instance/mods/ModA/ModA.manifest' } }, { resourceUri: { fsPath: '/instance/profiles/Default/modlist.txt' } });

    expect(modsHolding.mock.calls.map(([files]) => files)).toEqual([['/instance/mods/ModA/ModA.manifest', '/instance/profiles/Default/modlist.txt']]);
    expect(ask.asked.map(({ message }) => message)).toEqual(['Are you sure you want to discard changes in "ModA"?']);
    expect(discardChanges.mock.calls.map(([mods]) => mods)).toEqual([['ModA']]);
    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not discard changes in 1 of 2 mods.', detail: '"/instance/profiles/Default/modlist.txt" (it is not in a mod folder)',
    }]);
  });

  it('asks nothing when no selected row is a mod, and names each', async () => {
    const { ask, reporter, run } = register();

    await run(DISCARD, modRow('ModA'), [{ argument: { kind: 'separator', name: 'Weapons' }, name: 'Weapons' }]);

    expect([ask.asked, discardChanges.mock.calls]).toEqual([[], []]);
    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not discard changes in 1 of 1 mods.', detail: '"Weapons" (it is not a mod)' }]);
  });

  it('says its phase on the Toolbox\'s message line while it runs, and gives the line back when it ends', async () => {
    discardChanges.mockImplementationOnce((_mods, _instance, options) => {
      options?.onProgress?.({ phase: 'ReadingFiles', mod: 'ModA' });
      options?.onProgress?.({ phase: 'Discarding', mod: 'ModA', modsDone: 0, modsTotal: 2 });
      options?.onProgress?.({ phase: 'ReadingDownloadedFile', file: 'Deltas.7z' });
      return Promise.resolve({ applied: true, landed: [], refused: [] });
    });
    const { said, run } = register();

    await run(DISCARD);

    expect(said).toEqual([
      'Discarding changes in "ModA" — reading its files…', 'Discarding changes in "ModA" — 0 of 2 mods done…',
      'Discarding changes — searching "Deltas.7z" for deltas…', undefined,
    ]);
  });

  it.each([
    [[{ mod: 'ModA', written: ['a.nif'] }, { mod: 'ModB', written: [] }], ['Discarded changes in "ModA".']],
    [[{ mod: 'ModA', written: ['a.nif'] }, { mod: 'ModB', written: ['b.nif'] }], ['Discarded changes in 2 mods.']],
    [[{ mod: 'ModA', written: [] }, { mod: 'ModB', written: [] }], []],
  ])('says what it discarded, and nothing when it wrote nothing: %j', async (landed, landings) => {
    discardChanges.mockResolvedValueOnce({ applied: true, landed, refused: [] });
    const { reporter, run } = register();

    await run(DISCARD);

    expect([reporter.landings, reporter.reports]).toEqual([landings, []]);
  });

  it('names each skipped mod with what it lacks, and does not call the mods that landed failed', async () => {
    discardChanges.mockResolvedValueOnce({
      applied: true, landed: [{ mod: 'ModA', written: ['a.nif'] }], refused: [{ item: 'ModB', reason: "'ModB' was skipped: 'b.nif' has no provider." }],
    });
    const { reporter, run } = register();

    await run(DISCARD);

    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not discard changes in 1 of 2 mods.', detail: `"ModB" ('ModB' was skipped: 'b.nif' has no provider.)`,
    }]);
    expect(reporter.landings).toEqual([]);
  });

  it('names the mods a discard interrupted part way did not finish', async () => {
    discardChanges.mockResolvedValueOnce({ applied: false, refusal: 'Could not discard changes in 2 mods — mEdit stopped.', unfinished: ['ModB'] });
    const { reporter, run } = register();

    await run(DISCARD);

    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not discard changes in 2 mods — mEdit stopped.', detail: 'Not finished: "ModB". Discarding changes again finishes them.',
    }]);
  });

  it('gives the message line back when discard throws', async () => {
    discardChanges.mockRejectedValueOnce(new Error('boom'));
    const { said, run } = register();

    await expect(run(DISCARD)).rejects.toThrow('boom');

    expect(said).toEqual([undefined]);
  });
});
