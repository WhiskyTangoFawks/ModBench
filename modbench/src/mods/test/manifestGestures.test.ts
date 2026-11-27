import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => (await import('./modsVscode')).vscodeModule);

import { modsViewOn } from './modsViewOn';
import { separatorCarrier } from './sourceGestureHarness';
import { cancelNotification, seen } from './modsVscode';
import { file, folder, indexedValueOf, mod } from './indexedValue';
import { TreeItem } from '../../test/vscodeMock';
import { progressSteps } from '../../test/recordedProgress';
import { restoredMod } from '../../test/restoredMod';
import { AgentCall } from '../../drivingLib/agentGesture';
import type { InstanceRepositoryCommands } from '../../sourceCommands/instanceRepositoryCommands';

const updateManifest = vi.fn<InstanceRepositoryCommands['updateManifest']>();
const restoreFromManifest = vi.fn<InstanceRepositoryCommands['restoreFromManifest']>();

const UPDATE = 'modbench.mod.updateManifest';
const RESTORE = 'modbench.mod.restoreFromManifest';

const MOD_FOLDERS = [
  { kind: 'mod' as const, name: 'ModA', path: '/instance/mods/ModA', modName: 'ModA' },
  { kind: 'separator' as const, name: 'Weapons', path: '/instance/mods/Weapons_separator', modName: 'Weapons_separator' },
  { kind: 'mod' as const, name: 'ModB', path: '/instance/mods/ModB', modName: 'ModB' },
  { kind: 'mod' as const, name: 'InAnotherProfile', path: '/instance/mods/InAnotherProfile', modName: 'InAnotherProfile' },
];
const EVERY_MOD = ['ModA', 'ModB', 'InAnotherProfile'];
const SOURCE_DIRS = new Map([['ModA', '/instance/source/ModA']]);
const sourceFolderRow = { argument: { kind: 'folder', path: '/instance/source/ModA' }, name: 'ModA' };

async function register({ sourceDirs = new Map<string, string>() }: { sourceDirs?: ReadonlyMap<string, string> } = {}) {
  const value = await indexedValueOf(
    [mod('ModA'), { kind: 'separator', name: 'Weapons', enabled: true }, mod('ModB', false)],
    { ModA: { files: [file('ModA', 'meshes/a.nif')], folders: [folder('ModA', 'meshes')] } },
  );
  const said: (string | undefined)[] = [];
  const shown = modsViewOn({
    value: { ...value, modFolders: MOD_FOLDERS, paths: { ...value.paths, sourceDirs } },
    manifestGestures: { toolboxView: 'modbench.toolbox', say: (message) => { said.push(message); }, commands: { updateManifest, restoreFromManifest, ignoreFiles: vi.fn() } },
  });
  const modA = async () => shown.row('ModA', await shown.row('Weapons'));
  const folderRow = async () => shown.row('meshes', await modA());
  return { ...shown, said, modA, folderRow };
}

type Shown = Awaited<ReturnType<typeof register>>;

const sentMods = (mock: typeof updateManifest | typeof restoreFromManifest): unknown[] => mock.mock.calls.map(([mods]) => mods);

beforeEach(() => {
  vi.clearAllMocks();
  updateManifest.mockResolvedValue({ notes: [], repositoryNotes: [], landed: [], refused: [] });
  restoreFromManifest.mockResolvedValue({ landed: [], refused: [] });
});

describe('Every mod (update manifest and restore from manifest)', () => {
  it('acts on every mod from the palette with no Mods selection, under the Toolbox\'s progress', async () => {
    const { run } = await register();

    await run(UPDATE);

    expect([sentMods(updateManifest), progressSteps[0]]).toEqual([[EVERY_MOD], 'progress opens on modbench.toolbox']);
  });

  it.each([
    ['the Source Control title bar, which passes its source control', { rootUri: undefined }],
    ['the Toolbox\'s Modlist menu', new TreeItem('Modlist')],
  ])('acts on every mod from %s, under the Toolbox\'s progress, whatever the Mods view has selected', async (_where, clicked) => {
    const { run, row, view } = await register();
    view.selectRows([await row('ModB')]);

    await run(UPDATE, clicked);

    expect([sentMods(updateManifest), progressSteps[0]]).toEqual([[EVERY_MOD], 'progress opens on modbench.toolbox']);
  });

  it.each([
    ['modbench.modList.updateManifestHere', updateManifest],
    ['modbench.modList.restoreFromManifestHere', restoreFromManifest],
  ])('acts on every mod from the Mods title bar\'s %s, under the Mods view\'s progress, whatever the view has selected', async (entryPoint, command) => {
    const { run, row, view } = await register();
    view.selectRows([await row('ModB')]);

    await run(entryPoint);

    expect([sentMods(command), progressSteps[0]]).toEqual([[EVERY_MOD], 'progress opens on modbench.modList']);
  });

  it('acts on the selected mods from the Mod menu', async () => {
    const { run, modA, row } = await register();

    await run(UPDATE, await row('ModB'), [await modA(), await row('ModB')]);

    expect(sentMods(updateManifest)).toEqual([['ModA', 'ModB']]);
  });

  it.each<[string, (shown: Shown) => Promise<unknown[]>, string[], string[]]>([
    ['from the Explorer menu, with no mod', () => Promise.resolve([sourceFolderRow]), [], ['ModA']],
    ['beside the mods of a selection', async ({ row }) => [sourceFolderRow, await row('ModB')], ['ModB'], ['ModA']],
  ])('records the source folder a row names, %s', async (_where, selection, mods, sourceMods) => {
    const shown = await register({ sourceDirs: SOURCE_DIRS });

    await shown.run(UPDATE, sourceFolderRow, await selection(shown));

    expect(updateManifest.mock.calls.map(([sent, , everyMod, sentSourceMods]) => [sent, everyMod, sentSourceMods])).toEqual([[mods, false, sourceMods]]);
  });

  it('refuses a selected row that is neither a mod nor a separator, naming it, and acts on the rest', async () => {
    const { reporter, run, modA, folderRow } = await register();

    await run(UPDATE, await modA(), [await modA(), await folderRow()]);

    expect(sentMods(updateManifest)).toEqual([['ModA']]);
    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Update manifest: 0 mods unchanged, 0 updated, 1 refused; their packages do not hold 0 files and hold 0 files with other bytes.',
      detail: '"meshes" (it is not a mod or a separator)',
    }]);
  });

  it.each([
    [UPDATE, () => updateManifest.mockImplementationOnce((_mods, options) => {
      options?.onProgress?.({ phase: 'Updating', mod: 'ModA', modsDone: 0, modsTotal: 2 });
      return Promise.resolve({ notes: [], repositoryNotes: [], landed: [], refused: [] });
    })],
    [RESTORE, () => restoreFromManifest.mockImplementationOnce((_mods, options) => {
      options?.onProgress?.({ phase: 'Restoring', mod: 'ModA', modsDone: 0, modsTotal: 2 });
      return Promise.resolve({ landed: [], refused: [] });
    })],
  ])('%s shows its progress by mod in a notification with Cancel', async (id, reportsProgress) => {
    reportsProgress();
    const { run, modA } = await register();

    await run(id, await modA());

    expect([seen.notifications.map(({ cancellable }) => cancellable), seen.notifications.flatMap(({ messages }) => messages)]).toEqual([[true], [expect.stringContaining('"ModA", 0 of 2 mods done') as unknown]]);
  });

  it('update manifest, cancelled, says it was cancelled and the counts of what landed before, and does not report a landing', async () => {
    updateManifest.mockResolvedValueOnce({
      cancelled: true, notes: [], repositoryNotes: [], refused: [],
      landed: [{ mod: 'ModA', manifestWritten: true, repositoryWritten: false, notInPackage: [], otherBytes: [] }],
    });
    const { reporter, run, modA, row } = await register();

    await run(UPDATE, await modA(), [await modA(), await row('ModB')]);

    expect([reporter.landings, reporter.reports]).toEqual([[], [{
      severity: 'warning',
      message: 'Update manifest cancelled: 0 mods unchanged, 1 updated, 0 refused; their packages do not hold 0 files and hold 0 files with other bytes.',
      detail: '',
    }]]);
  });

  it('restore from manifest, cancelled, aborts the signal it handed the command, and reports each mod it did not finish', async () => {
    let signal: AbortSignal | undefined;
    const cancelled = 'was not finished: the restore was cancelled. Restoring it again finishes it.';
    restoreFromManifest.mockImplementationOnce((_mods, options) => {
      cancelNotification();
      signal = options?.signal;
      return Promise.resolve({ landed: [], refused: [{ item: 'ModB', reason: cancelled }] });
    });
    const { reporter, run, modA, row } = await register();

    await run(RESTORE, await modA(), [await modA(), await row('ModB')]);

    expect([signal?.aborted, reporter.reports]).toEqual([true, [{ severity: 'error', message: 'Could not restore 1 of 2 mods.', detail: `"ModB" (${cancelled})` }]]);
  });

});

describe('Update manifest', () => {
  it('says its phase on the Toolbox\'s message line while it runs, and gives the line back when it ends', async () => {
    updateManifest.mockImplementationOnce((_mods, options) => {
      options?.onProgress?.({ phase: 'ReadingFiles', mod: 'ModA' });
      options?.onProgress?.({ phase: 'Hashing', left: 3 });
      options?.onProgress?.({ phase: 'Updating', mod: 'ModA', modsDone: 0, modsTotal: 2 });
      return Promise.resolve({ notes: [], repositoryNotes: [], landed: [], refused: [] });
    });
    const { said, run } = await register();

    await run(UPDATE);

    expect(said).toEqual([
      'Update manifest — reading the files of "ModA"…', 'Update manifest — hashing downloaded files, 3 left…', 'Update manifest — "ModA", 0 of 2 mods done…', undefined,
    ]);
  });

  it('gives the message line back when update manifest throws', async () => {
    updateManifest.mockRejectedValueOnce(new Error('boom'));
    const { said, run } = await register();

    await expect(run(UPDATE)).rejects.toThrow('boom');

    expect(said).toEqual([undefined]);
  });

  it('runs under the Mods view\'s progress when a Mods row asked', async () => {
    updateManifest.mockImplementationOnce(() => { progressSteps.push('update manifest'); return Promise.resolve({ notes: [], repositoryNotes: [], landed: [], refused: [] }); });
    const { run, modA } = await register();

    await run(UPDATE, await modA());

    expect(progressSteps).toEqual(['progress opens on modbench.modList', 'update manifest', 'progress closes']);
  });

  it('says in one line how many mods were unchanged, updated and refused, and that no file is outside its package', async () => {
    updateManifest.mockResolvedValueOnce({
      notes: [], repositoryNotes: [], refused: [],
      landed: [{ mod: 'ModA', manifestWritten: true, repositoryWritten: false, notInPackage: [], otherBytes: [] }, { mod: 'ModB', manifestWritten: false, repositoryWritten: false, notInPackage: [], otherBytes: [] }, { mod: 'C', manifestWritten: false, repositoryWritten: false, notInPackage: [], otherBytes: [] }],
    });
    const { reporter, run } = await register();

    await run(UPDATE);

    expect([reporter.landings, reporter.reports]).toEqual([['Update manifest: 2 mods unchanged, 1 updated, 0 refused; their packages do not hold 0 files and hold 0 files with other bytes.'], []]);
  });

  it('counts a mod whose submodule entry or ignore lines were written as updated, though its manifest was unchanged', async () => {
    updateManifest.mockResolvedValueOnce({
      notes: [], repositoryNotes: [], refused: [],
      landed: [{ mod: 'ModA', manifestWritten: false, repositoryWritten: true, notInPackage: [], otherBytes: [] }],
    });
    const { reporter, run } = await register();

    await run(UPDATE);

    expect(reporter.landings).toEqual(['Update manifest: 0 mods unchanged, 1 updated, 0 refused; their packages do not hold 0 files and hold 0 files with other bytes.']);
  });

  it.each([
    ['a package does not hold a file, naming each by mod', { landed: [{ mod: 'ModA', manifestWritten: true, repositoryWritten: false, notInPackage: ['a.nif', 'b/c.dds'], otherBytes: [] }] },
      'Update manifest: 0 mods unchanged, 1 updated, 0 refused; their packages do not hold 2 files and hold 0 files with other bytes.', 'ModA: a.nif\nModA: b/c.dds'],
    ['a package holds a file with other bytes, naming each by mod', { landed: [{ mod: 'ModA', manifestWritten: true, repositoryWritten: false, notInPackage: ['z.nif'], otherBytes: ['a.esp'] }] },
      'Update manifest: 0 mods unchanged, 1 updated, 0 refused; their packages do not hold 1 file and hold 1 file with other bytes.',
      'ModA: z.nif\nModA: a.esp (other bytes)'],
    ['a mod folder\'s listing skipped an entry, naming each', {
      notes: [{ mod: 'ModA', note: 'broken link "a.nif", skipped' }], repositoryNotes: ['source/Odd is not a source mod'], landed: [{ mod: 'ModA', manifestWritten: false, repositoryWritten: false, notInPackage: [], otherBytes: [] }],
    }, 'Update manifest: 1 mod unchanged, 0 updated, 0 refused; their packages do not hold 0 files and hold 0 files with other bytes.', 'ModA: broken link "a.nif", skipped\nsource/Odd is not a source mod'],
  ])('warns in that line when %s in the Output', async (_case, answer, message, detail) => {
    updateManifest.mockResolvedValueOnce({ notes: [], repositoryNotes: [], refused: [], ...answer });
    const { reporter, run, modA } = await register();

    await run(UPDATE, await modA());

    expect([reporter.landings, reporter.reports]).toEqual([[], [{ severity: 'warning', message, detail }]]);
  });

  it('errs in that line when a mod is refused, naming each refused mod with why, then each file its package does not hold', async () => {
    updateManifest.mockResolvedValueOnce({
      notes: [], repositoryNotes: [],
      landed: [{ mod: 'ModA', manifestWritten: false, repositoryWritten: false, notInPackage: ['a.nif'], otherBytes: [] }],
      refused: [{ item: 'ModB', reason: "was not updated: its folder does not exist." }],
    });
    const { reporter, run } = await register();

    await run(UPDATE);

    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Update manifest: 1 mod unchanged, 0 updated, 1 refused; their packages do not hold 1 file and hold 0 files with other bytes.',
      detail: `"ModB" (was not updated: its folder does not exist.)\nModA: a.nif`,
    }]);
  });

});

describe('Restore from manifest', () => {
  it('restores the selected mods under the Mods view\'s progress (instance-repository.md, Restore from manifest, story 2)', async () => {
    restoreFromManifest.mockImplementationOnce(() => { progressSteps.push('restore'); return Promise.resolve({ landed: [], refused: [] }); });
    const { run, modA, row } = await register();

    await run(RESTORE, await row('ModB'), [await modA(), await row('ModB')]);

    expect(sentMods(restoreFromManifest)).toEqual([['ModA', 'ModB']]);
    expect(progressSteps).toEqual(['progress opens on modbench.modList', 'restore', 'progress closes']);
  });

  it('restores the mods a selected separator holds, and not the separator, which has no manifest', async () => {
    const { run } = await register();

    await run(RESTORE, separatorCarrier('Weapons'), [separatorCarrier('Weapons')]);

    expect(sentMods(restoreFromManifest)).toEqual([['ModA']]);
  });

  it('restores every mod from the palette with no Mods selection', async () => {
    const { run } = await register();

    await run(RESTORE);

    expect([sentMods(restoreFromManifest), progressSteps[0]]).toEqual([[EVERY_MOD], 'progress opens on modbench.toolbox']);
  });

  it('restores nothing when no selected row is a mod or a separator, and names each', async () => {
    const { reporter, run, folderRow, view } = await register();
    view.selectRows([await folderRow()]);

    await run(RESTORE);

    expect(restoreFromManifest.mock.calls).toEqual([]);
    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not restore 1 of 1 mods.', detail: '"meshes" (it is not a mod or a separator)' }]);
  });

  it('says its phase on the Toolbox\'s message line while it runs, and gives the line back when it ends', async () => {
    restoreFromManifest.mockImplementationOnce((_mods, options) => {
      options?.onProgress?.({ phase: 'Restoring', mod: 'ModA', modsDone: 0, modsTotal: 2 });
      options?.onProgress?.({ phase: 'Downloading', file: 'ModB.7z' });
      return Promise.resolve({ landed: [], refused: [] });
    });
    const { said, run } = await register();

    await run(RESTORE);

    expect(said).toEqual([
      'Restore from manifest — "ModA", 0 of 2 mods done…',
      'Restore from manifest — downloading "ModB.7z" from Nexus…', undefined,
    ]);
  });

  it.each([
    [[restoredMod({ mod: 'ModA', written: ['a.nif'] }), restoredMod({ mod: 'ModB' })], ['Restored "ModA" from its manifest.']],
    [[restoredMod({ mod: 'ModA', written: ['a.nif'] }), restoredMod({ mod: 'ModB', written: ['b.nif'] })], ['Restored 2 mods from their manifests.']],
    [[restoredMod({ mod: 'ModA' }), restoredMod({ mod: 'ModB' })], []],
    [[restoredMod({ mod: 'ModA', namedByNoLine: ['mine.txt'] })], ['Restored "ModA" from its manifest.']],
  ])('says what it restored, and nothing when it changed nothing: %j', async (landed, landings) => {
    restoreFromManifest.mockResolvedValueOnce({ landed, refused: [] });
    const { reporter, run } = await register();

    await run(RESTORE);

    expect([reporter.landings, reporter.reports]).toEqual([landings, []]);
  });

  it.each([
    ['it could not record what a mod it restored takes from the game folder', { landed: [restoredMod({ mod: 'ModA', written: ['a.nif'], notes: ['the files it takes could not be recorded'] })] },
      'ModA: the files it takes could not be recorded'],
    ['the clone of a submodule was left detached at its pin', {
      landed: [restoredMod({ mod: 'ModA', written: ['a.esp'], leftDetached: "its branch 'main' is at abc, not at the pin, so it is left detached at the pin" })],
    }, "ModA: its branch 'main' is at abc, not at the pin, so it is left detached at the pin"],
    ['the push refusal could not be written', { pushRefusalNotWritten: '/i/.git/hooks/pre-push already exists' },
      "a push of a pin its source mod's remote lacks is not refused: /i/.git/hooks/pre-push already exists"],
    ['a path token stays in the working tree', { pathTokensNotWritten: 'ModOrganizer.ini still holds a path token' },
      "this machine's paths are not in place of every path token: ModOrganizer.ini still holds a path token"],
    ['a mod was built from a source holding changes no commit holds (source.md, Build, story 15)', { landed: [restoredMod({ mod: 'ModA', written: ['a.esp'], uncommitted: true })] },
      'ModA: its submodule holds changes no commit holds, so the commit the instance repository pins does not rebuild these bytes'],
  ])('warns in its one line when %s, naming why in the Output', async (_case, answer, detail) => {
    restoreFromManifest.mockResolvedValueOnce({ landed: [restoredMod({ mod: 'ModA', written: ['a.nif'] })], refused: [], ...answer });
    const { reporter, run, modA } = await register();

    await run(RESTORE, await modA());

    expect([reporter.landings, reporter.reports]).toEqual([[], [{ severity: 'warning', message: 'Restored "ModA" from its manifest.', detail }]]);
  });

  it('names each skipped mod with what it lacks, and does not call the mods that landed failed', async () => {
    restoreFromManifest.mockResolvedValueOnce({
      landed: [restoredMod({ mod: 'ModA', written: ['a.nif'] })], refused: [{ item: 'ModB', reason: "was skipped: its package does not hold 'b.nif'." }],
    });
    const { reporter, run, modA, row } = await register();

    await run(RESTORE, await modA(), [await modA(), await row('ModB')]);

    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not restore 1 of 2 mods.', detail: `"ModB" (was skipped: its package does not hold 'b.nif'.)`,
    }]);
    expect(reporter.landings).toEqual([]);
  });

  it('says no file differed, warning in its one line, when the only thing to say is what it could not record', async () => {
    restoreFromManifest.mockResolvedValueOnce({
      landed: [restoredMod({ mod: 'ModA', notes: ['not recorded'] })], refused: [],
    });
    const { reporter, run, modA } = await register();

    await run(RESTORE, await modA());

    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Restore from manifest: no file differed from its manifest.', detail: 'ModA: not recorded',
    }]);
  });

  it('names a skipped mod and what it could not record in its one line', async () => {
    restoreFromManifest.mockResolvedValueOnce({
      landed: [restoredMod({ mod: 'ModA', notes: ['not recorded'] })],
      refused: [{ item: 'ModB', reason: "was skipped: it has no manifest." }],
    });
    const { reporter, run, modA, row } = await register();

    await run(RESTORE, await modA(), [await modA(), await row('ModB')]);

    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not restore 1 of 2 mods.',
      detail: `"ModB" (was skipped: it has no manifest.)\nModA: not recorded`,
    }]);
  });

  it('gives the message line back when restore throws', async () => {
    restoreFromManifest.mockRejectedValueOnce(new Error('boom'));
    const { said, run } = await register();

    await expect(run(RESTORE)).rejects.toThrow('boom');

    expect(said).toEqual([undefined]);
  });
});

describe('An agent call', () => {
  const mod = (name: string) => ({ kind: 'mod' as const, name });
  const separator = (name: string) => ({ kind: 'separator' as const, name });

  it('update manifest acts on the mods it is given, a separator for the mods it holds alone, with no progress notification', async () => {
    const { run } = await register();

    await run(UPDATE, new AgentCall([mod('ModB'), separator('Weapons')], {}));

    expect(sentMods(updateManifest)).toEqual([['ModB', 'ModA']]);
    expect(seen.notifications.map(({ cancellable }) => cancellable)).toEqual([]);
  });

  it('update manifest records a source folder it is given by its path, and refuses one that is none beside it, by name', async () => {
    const { run } = await register({ sourceDirs: SOURCE_DIRS });

    const answer = await run(UPDATE, new AgentCall([{ kind: 'folder', path: '/instance/source/ModA' }, { kind: 'folder', path: '/elsewhere' }, { kind: 'folder', path: 'source/ModA' }], {}));

    expect(updateManifest.mock.calls.map(([mods, , everyMod, sourceMods]) => [mods, everyMod, sourceMods])).toEqual([[[], false, ['ModA']]]);
    const reason = 'it is not named by the absolute path of a source mod\'s source folder, the sourceFolder that list_mods gives';
    expect(answer).toMatchObject({ outcome: { refused: [{ item: '/elsewhere', reason }, { item: 'source/ModA', reason }] } });
  });

  it('update manifest answers what landed and what was refused, each file its package does not hold and each note as a part that failed, and reports nothing', async () => {
    updateManifest.mockResolvedValueOnce({
      notes: [{ mod: 'ModA', note: 'a game file was unreadable' }], repositoryNotes: ['source/Odd is not a source mod'],
      landed: [{ mod: 'ModA', manifestWritten: true, repositoryWritten: false, notInPackage: ['a.nif'], otherBytes: ['b.esp'] }],
      refused: [{ item: 'ModB', reason: "was not updated." }],
    });
    const { reporter, run } = await register();

    const answer = await run(UPDATE, new AgentCall([], {}));

    expect(answer).toEqual({
      applied: true,
      outcome: { landed: [{ mod: 'ModA', manifestWritten: true, repositoryWritten: false, notInPackage: ['a.nif'], otherBytes: ['b.esp'] }], refused: [{ item: 'ModB', reason: "was not updated." }] },
      partial: [
        { message: 'Update manifest:', detail: 'ModA: its package does not hold a.nif', severity: 'warning' },
        { message: 'Update manifest:', detail: 'ModA: its package holds b.esp with other bytes', severity: 'warning' },
        { message: 'Update manifest:', detail: 'ModA: a game file was unreadable', severity: 'warning' },
        { message: 'Update manifest:', detail: 'source/Odd is not a source mod', severity: 'warning' },
      ],
    });
    expect([reporter.reports, reporter.landings]).toEqual([[], []]);
  });

  describe('restore from manifest', () => {
    it('answers what it restored, the mods it would not restore refused with why, and what it could not record as a part that failed', async () => {
      const landed = restoredMod({ mod: 'ModA', notes: ['disk full'] });
      restoreFromManifest.mockResolvedValueOnce({ landed: [landed], refused: [{ item: 'ModB', reason: 'its name gives it no folder' }] });
      const { run } = await register();

      const answer = await run(RESTORE, new AgentCall([], {}));

      expect(sentMods(restoreFromManifest)).toEqual([EVERY_MOD]);
      expect(answer).toEqual({
        applied: true,
        outcome: { landed: [landed], refused: [{ item: 'ModB', reason: 'its name gives it no folder' }] },
        partial: [{ message: 'Restore from manifest:', detail: 'ModA: disk full', severity: 'warning' }],
      });
    });

  });
});
