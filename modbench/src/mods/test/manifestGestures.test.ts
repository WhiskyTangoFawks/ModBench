import { describe, it, expect, vi, beforeEach } from 'vitest';

const { handlers, registerCommand, notification } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void> | void>();
  return {
    handlers,
    registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => Promise<void> | void) => {
      handlers.set(command, handler);
      return { dispose: vi.fn() };
    }),
    notification: { cancellable: [] as boolean[], messages: [] as string[], cancel: (): void => {} },
  };
});

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  const NOTIFICATION = 15;
  return {
    commands: { registerCommand },
    ProgressLocation: { Notification: NOTIFICATION },
    window: {
      withProgress: (
        options: { location: { viewId: string } | number; cancellable?: boolean },
        task: (progress: { report: (value: { message?: string }) => void }, token: unknown) => Promise<unknown>,
      ) => {
        const { location } = options;
        if (typeof location !== 'number') return recordedWithProgress({ location }, () => task({ report: () => {} }, undefined));
        notification.cancellable.push(options.cancellable === true);
        const listeners: (() => void)[] = [];
        const token = { isCancellationRequested: false, onCancellationRequested: (listener: () => void) => { listeners.push(listener); return { dispose: () => {} }; } };
        notification.cancel = () => { token.isCancellationRequested = true; for (const listener of listeners) listener(); };
        return task({ report: ({ message }) => { if (message !== undefined) notification.messages.push(message); } }, token);
      },
    },
    TreeItem: class { constructor(readonly label: string) {} },
  };
});

import { TreeItem } from 'vscode';
import { instanceThatReads, progressSteps } from '../../test/recordedProgress';
import { restoredMod } from '../../test/restoredMod';
import { registerManifestGestures } from '../manifestGestures';
import { recordingReporter, scriptedDialog, type ScriptedDialog } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';
import { AgentCall } from '../../drivingLib/agentGesture';
import type { ModlistRepositoryCommands } from '../../sourceCommands/modlistRepositoryCommands';

const updateManifest = vi.fn<ModlistRepositoryCommands['updateManifest']>();
const restoreFromManifest = vi.fn<ModlistRepositoryCommands['restoreFromManifest']>();
const whatRestoreDestroys = vi.fn<ModlistRepositoryCommands['whatRestoreDestroys']>();
const otherManifests = vi.fn<ModlistRepositoryCommands['otherManifests']>();

const UPDATE = 'modbench.mod.updateManifest';
const RESTORE = 'modbench.mod.restoreFromManifest';

const value = instanceValueFixture({
  mods: [
    { kind: 'mod', name: 'ModA', enabled: true },
    { kind: 'separator', name: 'Weapons', enabled: true },
    { kind: 'mod', name: 'ModB', enabled: false },
  ],
  modFolders: [
    { kind: 'mod', name: 'ModA', path: '/instance/mods/ModA', modName: 'ModA' },
    { kind: 'separator', name: 'Weapons', path: '/instance/mods/Weapons_separator', modName: 'Weapons_separator' },
    { kind: 'mod', name: 'ModB', path: '/instance/mods/ModB', modName: 'ModB' },
    { kind: 'mod', name: 'InAnotherProfile', path: '/instance/mods/InAnotherProfile', modName: 'InAnotherProfile' },
  ],
});
const EVERY_MOD = ['ModA', 'Weapons_separator', 'ModB', 'InAnotherProfile'];

const modRow = (name: string) => ({ argument: { kind: 'mod', name }, name });
const separatorRow = (name: string) => ({ argument: { kind: 'separator', name }, name });
const folderRow = { argument: { kind: 'folder', path: '/instance/mods/ModA/meshes' }, name: 'meshes' };

function register(over: Partial<Parameters<typeof registerManifestGestures>[0]> = {}, ask: ScriptedDialog = scriptedDialog('Restore')) {
  const reporter = recordingReporter();
  const said: (string | undefined)[] = [];
  registerManifestGestures({
    toolboxView: 'modbench.toolbox', commands: { updateManifest, restoreFromManifest, whatRestoreDestroys, otherManifests }, ask,
    instance: { value, ...instanceThatReads },
    reporter, say: (message) => { said.push(message); },
    focusedView: { id: () => undefined, selection: () => [] }, ...over,
  });
  return { reporter, said, ask, run: (id: string, ...args: unknown[]) => present(handlers.get(id), `the handler for "${id}"`)(...args) };
}

const sentMods = (mock: typeof updateManifest | typeof restoreFromManifest): unknown[] => mock.mock.calls.map(([mods]) => mods);

beforeEach(() => {
  handlers.clear();
  progressSteps.length = 0;
  notification.cancellable.length = 0;
  notification.messages.length = 0;
  vi.clearAllMocks();
  updateManifest.mockResolvedValue({ applied: true, notes: [], repositoryNotes: [], landed: [], refused: [] });
  restoreFromManifest.mockResolvedValue({ applied: true, landed: [], refused: [] });
  whatRestoreDestroys.mockResolvedValue({ destroys: [{ mod: 'ModA', differing: ['a.nif'], namedByNoLine: [], metadataDiffers: false }], refused: [] });
  otherManifests.mockResolvedValue({ others: [], refused: [] });
});

describe('Every mod (update manifest and restore from manifest)', () => {
  it('acts on every mod from the palette with no Mods selection, under the Toolbox\'s progress', async () => {
    const { run } = register();

    await run(UPDATE);

    expect([sentMods(updateManifest), progressSteps[0]]).toEqual([[EVERY_MOD], 'progress opens on modbench.toolbox']);
  });

  it.each([
    ['the Source Control title bar, which passes its source control', { rootUri: undefined }],
    ['the Toolbox\'s Modlist menu', new TreeItem('Modlist')],
  ])('acts on every mod from %s, under the Toolbox\'s progress, whatever the Mods view has selected', async (_where, clicked) => {
    const { run } = register({ focusedView: { id: () => 'modbench.modList', selection: () => [modRow('ModB')] } });

    await run(UPDATE, clicked);

    expect([sentMods(updateManifest), progressSteps[0]]).toEqual([[EVERY_MOD], 'progress opens on modbench.toolbox']);
  });

  it.each([
    ['modbench.modList.updateManifestHere', updateManifest],
    ['modbench.modList.restoreFromManifestHere', restoreFromManifest],
  ])('acts on every mod from the Mods title bar\'s %s, under the Mods view\'s progress, whatever the view has selected', async (entryPoint, command) => {
    const { run } = register({ focusedView: { id: () => 'modbench.modList', selection: () => [modRow('ModB')] } });

    await run(entryPoint);

    expect([sentMods(command), progressSteps[0]]).toEqual([[EVERY_MOD], 'progress opens on modbench.modList']);
  });

  it('acts on the selected mods from the Mod menu', async () => {
    const { run } = register();

    await run(UPDATE, modRow('ModB'), [modRow('ModA'), modRow('ModB')]);

    expect(sentMods(updateManifest)).toEqual([['ModA', 'ModB']]);
  });

  it('refuses a selected row that is neither a mod nor a separator, naming it, and acts on the rest', async () => {
    const { reporter, run } = register();

    await run(UPDATE, modRow('ModA'), [modRow('ModA'), folderRow]);

    expect(sentMods(updateManifest)).toEqual([['ModA']]);
    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Update manifest: 0 mods unchanged, 0 updated, 1 refused; their packages do not hold 0 files and hold 0 files with other bytes.',
      detail: '"meshes" (it is not a mod or a separator)',
    }]);
  });

  it.each([
    [UPDATE, () => updateManifest.mockImplementationOnce((_mods, options) => {
      options?.onProgress?.({ phase: 'Updating', mod: 'ModA', modsDone: 0, modsTotal: 2 });
      return Promise.resolve({ applied: true, notes: [], repositoryNotes: [], landed: [], refused: [] });
    })],
    [RESTORE, () => restoreFromManifest.mockImplementationOnce((_mods, options) => {
      options?.onProgress?.({ phase: 'Restoring', mod: 'ModA', modsDone: 0, modsTotal: 2 });
      return Promise.resolve({ applied: true, landed: [], refused: [] });
    })],
  ])('%s shows its progress by mod in a notification with Cancel', async (id, reportsProgress) => {
    reportsProgress();
    const { run } = register();

    await run(id, modRow('ModA'));

    expect([notification.cancellable, notification.messages]).toEqual([[true], [expect.stringContaining('"ModA", 0 of 2 mods done') as unknown]]);
  });

  it('update manifest, cancelled, aborts the signal it handed the command, and reports what mEdit answered', async () => {
    let signal: AbortSignal | undefined;
    updateManifest.mockImplementationOnce((_mods, options) => {
      notification.cancel();
      signal = options?.signal;
      return Promise.resolve({ applied: true, notes: [], repositoryNotes: [], landed: [{ mod: 'ModA', manifestWritten: true, notInPackage: [], otherBytes: [] }], refused: [] });
    });
    const { reporter, run } = register();

    await run(UPDATE, modRow('ModA'), [modRow('ModA'), modRow('ModB')]);

    expect([signal?.aborted, reporter.landings]).toEqual([true, ['Update manifest: 0 mods unchanged, 1 updated, 0 refused; their packages do not hold 0 files and hold 0 files with other bytes.']]);
  });

  it('restore from manifest, cancelled, aborts the signal it handed the command, and reports what mEdit answered', async () => {
    let signal: AbortSignal | undefined;
    restoreFromManifest.mockImplementationOnce((_mods, options) => {
      notification.cancel();
      signal = options?.signal;
      return Promise.resolve({ applied: false, refusal: 'Could not restore 2 mods — mEdit stopped.', unfinished: ['ModB'] });
    });
    const { reporter, run } = register();

    await run(RESTORE, modRow('ModA'), [modRow('ModA'), modRow('ModB')]);

    expect([signal?.aborted, reporter.reports]).toEqual([true, [{
      severity: 'error', message: 'Could not restore 2 mods — mEdit stopped.', detail: 'Not finished: "ModB". Restoring again finishes them.',
    }]]);
  });

  it.each([
    [UPDATE, () => updateManifest.mockResolvedValueOnce({ applied: true, notes: [], repositoryNotes: [], landed: [], refused: [], cancelRefusal: 'Could not cancel — not running.' })],
    [RESTORE, () => restoreFromManifest.mockResolvedValueOnce({ applied: true, landed: [], refused: [], cancelRefusal: 'Could not cancel — not running.' })],
  ])('%s reports a cancel mEdit refused', async (id, answersCancelRefused) => {
    answersCancelRefused();
    const { reporter, run } = register();

    await run(id, modRow('ModA'));

    expect(reporter.reports).toContainEqual({ severity: 'error', message: 'Could not cancel — not running.', detail: undefined });
  });
});

describe('Every other manifest', () => {
  const STOCK_GAME = { name: 'Stock Game/', folder: '/instance/Stock Game' };
  const othersHanded = (): unknown[] => [
    ...updateManifest.mock.calls.map(([, , others]) => others), ...whatRestoreDestroys.mock.calls.map(([, others]) => others),
    ...restoreFromManifest.mock.calls.map(([, , , others]) => others),
  ];

  it.each([
    ['update manifest from the palette', UPDATE, [], 1],
    ['restore from manifest from the palette', RESTORE, [], 2],
    ['update manifest from the Mods view\'s title bar', 'modbench.modList.updateManifestHere', [], 1],
    ['an agent\'s update manifest that names no mod', UPDATE, [new AgentCall([], {})], 1],
    ['an agent\'s restore from manifest that names no mod', RESTORE, [new AgentCall([], { force: true })], 2],
  ])('joins every mod in %s', async (_case, command, args, calls) => {
    otherManifests.mockResolvedValueOnce({ others: [STOCK_GAME], refused: [] });
    const { run } = register();

    await run(command, ...args);

    expect(othersHanded()).toEqual(Array.from({ length: calls }, () => [STOCK_GAME]));
  });

  it('is not searched for when a Mods selection names the mods', async () => {
    const { run } = register();

    await run(UPDATE, modRow('ModA'));

    expect([otherManifests.mock.calls, othersHanded()]).toEqual([[], [[]]]);
  });

  it('is not restored when what restore destroys skipped it', async () => {
    otherManifests.mockResolvedValueOnce({ others: [STOCK_GAME], refused: [] });
    whatRestoreDestroys.mockResolvedValueOnce({ destroys: [], refused: [{ item: 'Stock Game/', reason: 'was skipped: a file could not be read' }] });
    const { run } = register();

    await run(RESTORE);

    expect(restoreFromManifest.mock.calls.map(([, , , others]) => others)).toEqual([[]]);
  });

  it.each([
    ['update manifest', UPDATE, 'Update manifest: 0 mods unchanged, 0 updated, 1 refused; their packages do not hold 0 files and hold 0 files with other bytes.'],
    ['restore from manifest', RESTORE, 'Could not restore 1 of 5 mods.'],
  ])('%s names a folder the search could not read beside what it did, and still acts on every mod', async (_case, command, message) => {
    otherManifests.mockResolvedValueOnce({ others: [], refused: [{ item: 'logs/', reason: 'was not searched for a manifest: EACCES' }] });
    const { reporter, run } = register();

    await run(command);

    expect([[...updateManifest.mock.calls, ...restoreFromManifest.mock.calls].map(([mods]) => mods), reporter.reports]).toEqual([
      [EVERY_MOD], [{ severity: 'error', message, detail: '"logs/" (was not searched for a manifest: EACCES)' }],
    ]);
  });

  it('an agent\'s call names a folder the search could not read among what it refused', async () => {
    otherManifests.mockResolvedValueOnce({ others: [], refused: [{ item: 'logs/', reason: 'was not searched for a manifest: EACCES' }] });
    const { run } = register();

    const answer = await run(UPDATE, new AgentCall([], {}));

    expect(answer).toMatchObject({ applied: true, outcome: { refused: [{ item: 'logs/', reason: 'was not searched for a manifest: EACCES' }] } });
  });
});

describe('Update manifest', () => {
  it('says its phase on the Toolbox\'s message line while it runs, and gives the line back when it ends', async () => {
    updateManifest.mockImplementationOnce((_mods, options) => {
      options?.onProgress?.({ phase: 'ReadingFiles', mod: 'ModA' });
      options?.onProgress?.({ phase: 'Updating', mod: 'ModA', modsDone: 0, modsTotal: 2 });
      return Promise.resolve({ applied: true, notes: [], repositoryNotes: [], landed: [], refused: [] });
    });
    const { said, run } = register();

    await run(UPDATE);

    expect(said).toEqual(['Update manifest — reading the files of "ModA"…', 'Update manifest — "ModA", 0 of 2 mods done…', undefined]);
  });

  it('gives the message line back when update manifest throws', async () => {
    updateManifest.mockRejectedValueOnce(new Error('boom'));
    const { said, run } = register();

    await expect(run(UPDATE)).rejects.toThrow('boom');

    expect(said).toEqual([undefined]);
  });

  it('runs under the Mods view\'s progress when a Mods row asked, and asks nothing', async () => {
    updateManifest.mockImplementationOnce(() => { progressSteps.push('update manifest'); return Promise.resolve({ applied: true, notes: [], repositoryNotes: [], landed: [], refused: [] }); });
    const { ask, run } = register();

    await run(UPDATE, modRow('ModA'));

    expect(progressSteps).toEqual(['progress opens on modbench.modList', 'update manifest', 'Instance loader: read every file again', 'progress closes']);
    expect(ask.asked).toEqual([]);
  });

  it('says in one line how many mods were unchanged, updated and refused, and that no file is outside its package', async () => {
    updateManifest.mockResolvedValueOnce({
      applied: true, notes: [], repositoryNotes: [], refused: [],
      landed: [{ mod: 'ModA', manifestWritten: true, notInPackage: [], otherBytes: [] }, { mod: 'ModB', manifestWritten: false, notInPackage: [], otherBytes: [] }, { mod: 'C', manifestWritten: false, notInPackage: [], otherBytes: [] }],
    });
    const { reporter, run } = register();

    await run(UPDATE);

    expect([reporter.landings, reporter.reports]).toEqual([['Update manifest: 2 mods unchanged, 1 updated, 0 refused; their packages do not hold 0 files and hold 0 files with other bytes.'], []]);
  });

  it.each([
    ['a package does not hold a file, naming each by mod', { landed: [{ mod: 'ModA', manifestWritten: true, notInPackage: ['a.nif', 'b/c.dds'], otherBytes: [] }] },
      'Update manifest: 0 mods unchanged, 1 updated, 0 refused; their packages do not hold 2 files and hold 0 files with other bytes.', 'ModA: a.nif\nModA: b/c.dds'],
    ['a package holds a file with other bytes, naming each by mod', { landed: [{ mod: 'ModA', manifestWritten: true, notInPackage: ['z.nif'], otherBytes: ['a.esp'] }] },
      'Update manifest: 0 mods unchanged, 1 updated, 0 refused; their packages do not hold 1 file and hold 1 file with other bytes.',
      'ModA: z.nif\nModA: a.esp (other bytes)'],
    ['a mod folder\'s listing skipped an entry, naming each', {
      notes: [{ mod: 'ModA', note: 'broken link "a.nif", skipped' }], repositoryNotes: ['source/Odd is not a source mod'], landed: [{ mod: 'ModA', manifestWritten: false, notInPackage: [], otherBytes: [] }],
    }, 'Update manifest: 1 mod unchanged, 0 updated, 0 refused; their packages do not hold 0 files and hold 0 files with other bytes.', 'ModA: broken link "a.nif", skipped\nsource/Odd is not a source mod'],
    ['the stat cache could not be written for a mod, naming why', {
      landed: [{ mod: 'ModA', manifestWritten: true, notInPackage: [], otherBytes: [], statCacheNotWritten: '/i/stat-cache is read-only' }],
    }, 'Update manifest: 0 mods unchanged, 1 updated, 0 refused; their packages do not hold 0 files and hold 0 files with other bytes.', 'ModA: the stat cache could not be written: /i/stat-cache is read-only'],
  ])('warns in that line when %s in the Output', async (_case, answer, message, detail) => {
    updateManifest.mockResolvedValueOnce({ applied: true, notes: [], repositoryNotes: [], refused: [], ...answer });
    const { reporter, run } = register();

    await run(UPDATE, modRow('ModA'));

    expect([reporter.landings, reporter.reports]).toEqual([[], [{ severity: 'warning', message, detail }]]);
  });

  it('errs in that line when a mod is refused, naming each refused mod with why, then each file its package does not hold', async () => {
    updateManifest.mockResolvedValueOnce({
      applied: true, notes: [], repositoryNotes: [],
      landed: [{ mod: 'ModA', manifestWritten: false, notInPackage: ['a.nif'], otherBytes: [] }],
      refused: [{ item: 'ModB', reason: "was not updated: 'B.zip' not in the downloads folder." }],
    });
    const { reporter, run } = register();

    await run(UPDATE);

    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Update manifest: 1 mod unchanged, 0 updated, 1 refused; their packages do not hold 1 file and hold 0 files with other bytes.',
      detail: `"ModB" (was not updated: 'B.zip' not in the downloads folder.)\nModA: a.nif`,
    }]);
  });

  it('reports a gesture mEdit refused whole', async () => {
    updateManifest.mockResolvedValueOnce({ applied: false, refusal: 'Could not update the manifest of 2 mods — mEdit is not running.' });
    const { reporter, run } = register();

    await run(UPDATE);

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not update the manifest of 2 mods — mEdit is not running.', detail: undefined }]);
  });
});

describe('Restore from manifest', () => {
  const asked = (ask: ScriptedDialog) => ask.asked.map(({ message, detail, buttons }) => ({ message, detail, buttons }));

  it('asks once, naming the selected mods and that a change no manifest holds is lost, then restores them under the Mods view\'s progress', async () => {
    restoreFromManifest.mockImplementationOnce(() => { progressSteps.push('restore'); return Promise.resolve({ applied: true, landed: [], refused: [] }); });
    const { ask, run } = register();

    await run(RESTORE, modRow('ModB'), [modRow('ModA'), modRow('ModB')]);

    expect(asked(ask)).toEqual([{
      message: 'Are you sure you want to restore "ModA", "ModB" from their manifests?', detail: 'A change no manifest holds is lost.', buttons: ['Restore'],
    }]);
    expect(sentMods(restoreFromManifest)).toEqual([['ModA', 'ModB']]);
    expect(progressSteps).toEqual(['progress opens on modbench.modList', 'restore', 'Instance loader: read every file again', 'progress closes']);
  });

  it('asks about every mod, and restores every mod, from the palette with no Mods selection', async () => {
    const { ask, run } = register();

    await run(RESTORE);

    expect(ask.asked.map(({ message }) => message)).toEqual(['Are you sure you want to restore every mod from its manifest?']);
    expect([sentMods(restoreFromManifest), progressSteps[0]]).toEqual([[EVERY_MOD], 'progress opens on modbench.toolbox']);
  });

  it('asks nothing when restore destroys nothing, as after a fresh clone, and restores', async () => {
    whatRestoreDestroys.mockResolvedValueOnce({ destroys: [], refused: [] });
    const { ask, run } = register();

    await run(RESTORE, modRow('ModA'));

    expect([ask.asked, sentMods(restoreFromManifest)]).toEqual([[], [['ModA']]]);
  });

  it('asks when only the metadata would lose a version or a source its manifest replaces', async () => {
    whatRestoreDestroys.mockResolvedValueOnce({ destroys: [{ mod: 'ModA', differing: [], namedByNoLine: [], metadataDiffers: true }], refused: [] });
    const { ask, run } = register();

    await run(RESTORE, modRow('ModA'));

    expect(ask.asked.map(({ message }) => message)).toEqual(['Are you sure you want to restore "ModA" from its manifest?']);
  });

  it('asks about the mods it was handed, never whatever else the instance holds', async () => {
    const { run } = register();

    await run(RESTORE, modRow('ModB'), [modRow('ModA'), modRow('ModB')]);

    expect(whatRestoreDestroys.mock.calls).toEqual([[['ModA', 'ModB'], []]]);
  });

  it('restores only the mods it could ask about, naming each it skipped in its one line', async () => {
    const skipped = "was skipped: a file could not be read: denied";
    whatRestoreDestroys.mockResolvedValueOnce({ destroys: [], refused: [{ item: 'ModB', reason: skipped }] });
    restoreFromManifest.mockResolvedValueOnce({ applied: true, landed: [restoredMod({ mod: 'ModA', written: ['a.nif'] })], refused: [] });
    const { reporter, run } = register();

    await run(RESTORE, modRow('ModA'), [modRow('ModA'), modRow('ModB')]);

    expect(sentMods(restoreFromManifest)).toEqual([['ModA']]);
    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not restore 1 of 2 mods.', detail: `"ModB" (${skipped})` }]);
  });

  it('restores nothing, and says why, when mEdit cannot say what restore destroys', async () => {
    whatRestoreDestroys.mockResolvedValueOnce({ refusal: 'Could not ask what restore from manifest destroys: mEdit could not be reached.' });
    const { ask, reporter, run } = register();

    await run(RESTORE, modRow('ModA'));

    expect([ask.asked, restoreFromManifest.mock.calls, reporter.reports]).toEqual([[], [], [{
      severity: 'error', message: 'Could not ask what restore from manifest destroys: mEdit could not be reached.', detail: undefined,
    }]]);
  });

  it('restores nothing and says nothing when the question is cancelled', async () => {
    const { reporter, run } = register({}, scriptedDialog(undefined));

    await run(RESTORE, modRow('ModA'));

    expect([restoreFromManifest.mock.calls, progressSteps, reporter.reports, reporter.landings]).toEqual([[], [], [], []]);
  });

  it('asks nothing when no selected row is a mod or a separator, and names each', async () => {
    const { ask, reporter, run } = register({ focusedView: { id: () => 'modbench.modList', selection: () => [folderRow] } });

    await run(RESTORE);

    expect([ask.asked, restoreFromManifest.mock.calls, whatRestoreDestroys.mock.calls]).toEqual([[], [], []]);
    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not restore 1 of 1 mods.', detail: '"meshes" (it is not a mod or a separator)' }]);
  });

  it('says its phase on the Toolbox\'s message line while it runs, and gives the line back when it ends', async () => {
    restoreFromManifest.mockImplementationOnce((_mods, options) => {
      options?.onProgress?.({ phase: 'ReadingFiles', mod: 'ModA' });
      options?.onProgress?.({ phase: 'Restoring', mod: 'ModA', modsDone: 0, modsTotal: 2 });
      options?.onProgress?.({ phase: 'Downloading', file: 'ModB.7z' });
      return Promise.resolve({ applied: true, landed: [], refused: [] });
    });
    const { said, run } = register();

    await run(RESTORE);

    expect(said).toEqual([
      'Restore from manifest — reading what it would destroy…', undefined,
      'Restore from manifest — reading the files of "ModA"…', 'Restore from manifest — "ModA", 0 of 2 mods done…',
      'Restore from manifest — downloading "ModB.7z" from Nexus…', undefined,
    ]);
  });

  it.each([
    [[restoredMod({ mod: 'ModA', written: ['a.nif'] }), restoredMod({ mod: 'ModB' })], ['Restored "ModA" from its manifest.']],
    [[restoredMod({ mod: 'ModA', written: ['a.nif'] }), restoredMod({ mod: 'ModB', written: ['b.nif'] })], ['Restored 2 mods from their manifests.']],
    [[restoredMod({ mod: 'ModA' }), restoredMod({ mod: 'ModB' })], []],
    [[restoredMod({ mod: 'ModA', namedByNoLine: ['mine.txt'] })], ['Restored "ModA" from its manifest.']],
  ])('says what it restored, and nothing when it changed nothing: %j', async (landed, landings) => {
    restoreFromManifest.mockResolvedValueOnce({ applied: true, landed, refused: [] });
    const { reporter, run } = register();

    await run(RESTORE);

    expect([reporter.landings, reporter.reports]).toEqual([landings, []]);
  });

  it.each([
    ['the stat cache could not be written for a mod it restored', { landed: [restoredMod({ mod: 'ModA', written: ['a.nif'], statCacheNotWritten: '/i/stat-cache is read-only' })] },
      'ModA: the stat cache could not be written: /i/stat-cache is read-only'],
    ['the clone of a submodule was left detached at its pin', {
      landed: [restoredMod({ mod: 'ModA', written: ['a.esp'], leftDetached: "its branch 'main' is at abc, not at the pin, so it is left detached at the pin" })],
    }, "ModA: its branch 'main' is at abc, not at the pin, so it is left detached at the pin"],
    ['the push refusal could not be written', { pushRefusalNotWritten: '/i/.git/hooks/pre-push already exists' },
      "a push of a pin its source mod's remote lacks is not refused: /i/.git/hooks/pre-push already exists"],
    ['a path token stays in the working tree', { pathTokensNotWritten: 'ModOrganizer.ini still holds a path token' },
      "this machine's paths are not in place of every path token: ModOrganizer.ini still holds a path token"],
    ['a mod was built from a source holding changes no commit holds', { landed: [restoredMod({ mod: 'ModA', written: ['a.esp'], uncommitted: true })] },
      'ModA: its submodule holds changes no commit holds, so the commit the instance repository pins does not rebuild these bytes'],
  ])('warns in its one line when %s, naming why in the Output', async (_case, answer, detail) => {
    restoreFromManifest.mockResolvedValueOnce({ applied: true, landed: [restoredMod({ mod: 'ModA', written: ['a.nif'] })], refused: [], ...answer });
    const { reporter, run } = register();

    await run(RESTORE, modRow('ModA'));

    expect([reporter.landings, reporter.reports]).toEqual([[], [{ severity: 'warning', message: 'Restored "ModA" from its manifest.', detail }]]);
  });

  it('names each skipped mod with what it lacks, and does not call the mods that landed failed', async () => {
    restoreFromManifest.mockResolvedValueOnce({
      applied: true, landed: [restoredMod({ mod: 'ModA', written: ['a.nif'] })], refused: [{ item: 'ModB', reason: "was skipped: its package does not hold 'b.nif'." }],
    });
    const { reporter, run } = register();

    await run(RESTORE, modRow('ModA'), [modRow('ModA'), modRow('ModB')]);

    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not restore 1 of 2 mods.', detail: `"ModB" (was skipped: its package does not hold 'b.nif'.)`,
    }]);
    expect(reporter.landings).toEqual([]);
  });

  it('says no file differed, warning in its one line, when the only thing to say is a stat cache it could not write', async () => {
    restoreFromManifest.mockResolvedValueOnce({
      applied: true, landed: [restoredMod({ mod: 'ModA', statCacheNotWritten: 'read-only' })], refused: [],
    });
    const { reporter, run } = register();

    await run(RESTORE, modRow('ModA'));

    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Restore from manifest: no file differed from its manifest.', detail: 'ModA: the stat cache could not be written: read-only',
    }]);
  });

  it('names a skipped mod and a stat cache it could not write in its one line', async () => {
    restoreFromManifest.mockResolvedValueOnce({
      applied: true, landed: [restoredMod({ mod: 'ModA', statCacheNotWritten: 'read-only' })],
      refused: [{ item: 'ModB', reason: "was skipped: it has no manifest." }],
    });
    const { reporter, run } = register();

    await run(RESTORE, modRow('ModA'), [modRow('ModA'), modRow('ModB')]);

    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not restore 1 of 2 mods.',
      detail: `"ModB" (was skipped: it has no manifest.)\nModA: the stat cache could not be written: read-only`,
    }]);
  });

  it.each([
    ['asking what it would destroy', () => whatRestoreDestroys.mockRejectedValueOnce(new Error('boom')), [undefined]],
    ['restore', () => restoreFromManifest.mockRejectedValueOnce(new Error('boom')), [undefined, undefined]],
  ])('gives the message line back when %s throws', async (_phase, throws, givenBack) => {
    throws();
    const { said, run } = register();

    await expect(run(RESTORE)).rejects.toThrow('boom');

    expect(said).toEqual(['Restore from manifest — reading what it would destroy…', ...givenBack]);
  });
});

describe('A separator in a report or an outcome', () => {
  const separator = { kind: 'separator' as const, name: 'Weapons' };
  const WIRE = 'Weapons_separator';
  const NAMED = 'separator Weapons';

  it('update manifest keeps it apart from a mod of the same name', async () => {
    updateManifest.mockResolvedValueOnce({
      applied: true, notes: [], repositoryNotes: [],
      landed: [{ mod: 'Weapons', manifestWritten: true, notInPackage: ['b.nif'], otherBytes: [] }, { mod: WIRE, manifestWritten: true, notInPackage: ['a.nif'], otherBytes: [] }],
      refused: [{ item: WIRE, reason: 'was not updated: its folder does not exist.' }, { item: 'Weapons', reason: 'was not updated: its folder does not exist.' }],
    });
    const sharing = instanceValueFixture({
      modFolders: [...(value.modFolders ?? []), { kind: 'mod', name: 'Weapons', path: '/instance/mods/Weapons', modName: 'Weapons' }],
    });
    const { reporter, run } = register({ instance: { value: sharing, refresh: () => Promise.resolve(undefined) } });

    await run(UPDATE);

    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Update manifest: 0 mods unchanged, 2 updated, 2 refused; their packages do not hold 2 files and hold 0 files with other bytes.',
      detail: `"${NAMED}" (was not updated: its folder does not exist.)\n"Weapons" (was not updated: its folder does not exist.)\nWeapons: b.nif\n${NAMED}: a.nif`,
    }]);
  });

  it('restore from manifest names it as a separator in its progress and its report', async () => {
    restoreFromManifest.mockImplementationOnce((_mods, options) => {
      options?.onProgress?.({ phase: 'Restoring', mod: WIRE, modsDone: 0, modsTotal: 1 });
      return Promise.resolve({ applied: true, landed: [], refused: [{ item: WIRE, reason: 'was skipped: it has no manifest.' }] });
    });
    const { reporter, said, run } = register();

    await run(RESTORE, separatorRow('Weapons'));

    expect(said).toContain(`Restore from manifest — "${NAMED}", 0 of 1 mods done…`);
    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not restore 1 of 2 mods.', detail: `"${NAMED}" (was skipped: it has no manifest.)` }]);
  });

  it('restore from manifest names it as a separator among the mods not finished', async () => {
    restoreFromManifest.mockResolvedValueOnce({ applied: false, refusal: 'Could not restore 1 mod — mEdit stopped.', unfinished: [WIRE] });
    const { reporter, run } = register();

    await run(RESTORE, separatorRow('Weapons'));

    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not restore 1 mod — mEdit stopped.', detail: `Not finished: "${NAMED}". Restoring again finishes them.`,
    }]);
  });

  it('an agent reads it as a separator in what landed and what was refused', async () => {
    updateManifest.mockResolvedValueOnce({
      applied: true, notes: [], repositoryNotes: [], landed: [{ mod: WIRE, manifestWritten: true, notInPackage: ['a.nif'], otherBytes: [] }],
      refused: [{ item: 'ModB', reason: 'was not updated.' }],
    });
    const { run } = register();

    const answer = await run(UPDATE, new AgentCall([separator], {}));

    expect(answer).toEqual({
      applied: true,
      outcome: { landed: [{ mod: NAMED, manifestWritten: true, notInPackage: ['a.nif'], otherBytes: [] }], refused: [{ item: 'ModB', reason: 'was not updated.' }] },
      partial: [{ message: 'Update manifest:', detail: `${NAMED}: its package does not hold a.nif`, severity: 'warning' }],
    });
  });

  it('an agent reads it as a separator in a restore it refused', async () => {
    whatRestoreDestroys.mockResolvedValueOnce({ destroys: [], refused: [{ item: WIRE, reason: 'was skipped: it has no manifest.' }] });
    const { run } = register();

    const answer = await run(RESTORE, new AgentCall([separator], {}));

    expect(answer).toEqual({ applied: true, outcome: { landed: [], refused: [{ item: NAMED, reason: 'was skipped: it has no manifest.' }] }, partial: [] });
  });
});

describe('An agent call', () => {
  const mod = (name: string) => ({ kind: 'mod' as const, name });
  const separator = (name: string) => ({ kind: 'separator' as const, name });

  it('update manifest acts on the mods it is given, a separator for itself and the mods it holds, with no progress notification', async () => {
    const { run } = register();

    await run(UPDATE, new AgentCall([mod('ModB'), separator('Weapons')], {}));

    expect(sentMods(updateManifest)).toEqual([['ModB', 'Weapons_separator', 'ModA']]);
    expect(notification.cancellable).toEqual([]);
  });

  it('update manifest answers what landed and what was refused, each file its package does not hold and each note as a part that failed, and reports nothing', async () => {
    updateManifest.mockResolvedValueOnce({
      applied: true, notes: [{ mod: 'ModA', note: 'a game file was unreadable' }], repositoryNotes: ['source/Odd is not a source mod'],
      landed: [{ mod: 'ModA', manifestWritten: true, notInPackage: ['a.nif'], otherBytes: ['b.esp'] }],
      refused: [{ item: 'ModB', reason: "was not updated." }],
    });
    const { reporter, run } = register();

    const answer = await run(UPDATE, new AgentCall([], {}));

    expect(answer).toEqual({
      applied: true,
      outcome: { landed: [{ mod: 'ModA', manifestWritten: true, notInPackage: ['a.nif'], otherBytes: ['b.esp'] }], refused: [{ item: 'ModB', reason: "was not updated." }] },
      partial: [
        { message: 'Update manifest:', detail: 'ModA: its package does not hold a.nif', severity: 'warning' },
        { message: 'Update manifest:', detail: 'ModA: its package holds b.esp with other bytes', severity: 'warning' },
        { message: 'Update manifest:', detail: 'ModA: a game file was unreadable', severity: 'warning' },
        { message: 'Update manifest:', detail: 'source/Odd is not a source mod', severity: 'warning' },
      ],
    });
    expect([reporter.reports, reporter.landings]).toEqual([[], []]);
  });

  it('update manifest answers a refusal of the whole as a refusal', async () => {
    updateManifest.mockResolvedValueOnce({ applied: false, refusal: 'Could not update manifests: the game folder was not found.' });
    const { run } = register();

    expect(await run(UPDATE, new AgentCall([], {}))).toEqual({ applied: false, refusal: 'Could not update manifests: the game folder was not found.' });
  });

  describe('restore from manifest', () => {
    const differs = { mod: 'ModA', differing: ['a.nif', 'b.nif'], namedByNoLine: ['stray.txt'], metadataDiffers: false };

    const METADATA_REFUSAL = "it would overwrite the version or installation files its metadata names with its manifest's. Request it again with force to overwrite them.";
    const BOTH_REFUSAL = "it would overwrite files whose bytes differ from its manifest: a.nif, b.nif and the version or installation files its metadata names with its manifest's. Request it again with force to overwrite them.";
    const BYTES_REFUSAL = 'it would overwrite files whose bytes differ from its manifest: a.nif, b.nif. Request it again with force to overwrite them.';
    const onlyMetadata = { mod: 'ModA', differing: [], namedByNoLine: [], metadataDiffers: true };

    it.each<[string, (typeof differs)[], string[], boolean, string[][], { item: string; reason: string }[]]>([
      ['restores a mod whose only loss is files no line names, which the trash keeps', [{ mod: 'ModA', differing: [], namedByNoLine: ['stray.txt'], metadataDiffers: false }],
        ['ModA'], false, [['ModA']], []],
      ['refuses a mod whose only loss is metadata, naming force, since no history or trash keeps it', [onlyMetadata], ['ModA'], false, [], [{ item: 'ModA', reason: METADATA_REFUSAL }]],
      ['lists the files and the metadata together when a mod would lose both', [{ ...differs, metadataDiffers: true }], ['ModA'], false, [], [{ item: 'ModA', reason: BOTH_REFUSAL }]],
      ['restores a mod whose only loss is metadata when forced', [onlyMetadata], ['ModA'], true, [['ModA']], []],
      ['refuses a mod that would overwrite files whose bytes differ, listing them and naming force, and restores the rest', [differs], ['ModA', 'ModB'], false,
        [['ModB']], [{ item: 'ModA', reason: BYTES_REFUSAL }]],
      ['restores a mod that differs when forced', [differs], ['ModA'], true, [['ModA']], []],
    ])('%s, asking and reporting nothing', async (_case, destroys, mods, force, sent, refused) => {
      whatRestoreDestroys.mockResolvedValueOnce({ destroys, refused: [] });
      const { ask, reporter, run } = register();

      const answer = await run(RESTORE, new AgentCall(mods.map(mod), { force }));

      expect([sentMods(restoreFromManifest), ask.asked, reporter.reports]).toEqual([sent, [], []]);
      expect(answer).toMatchObject({ applied: true, outcome: { refused } });
    });

    it('writes nothing when every mod is refused', async () => {
      whatRestoreDestroys.mockResolvedValueOnce({ destroys: [differs], refused: [] });
      const { run } = register();

      const answer = await run(RESTORE, new AgentCall([mod('ModA')], {}));

      expect([sentMods(restoreFromManifest), progressSteps]).toEqual([[], []]);
      expect(answer).toMatchObject({ applied: true, outcome: { landed: [], refused: [{ item: 'ModA' }] } });
    });

    it('answers what it restored, the mods mEdit would not restore refused with why, and a stat cache it could not write as a part that failed', async () => {
      whatRestoreDestroys.mockResolvedValueOnce({ destroys: [], refused: [{ item: 'ModB', reason: 'its name gives it no folder' }] });
      const landed = restoredMod({ mod: 'ModA', statCacheNotWritten: 'disk full' });
      restoreFromManifest.mockResolvedValueOnce({ applied: true, landed: [landed], refused: [] });
      const { run } = register();

      const answer = await run(RESTORE, new AgentCall([], {}));

      expect(sentMods(restoreFromManifest)).toEqual([['ModA', 'Weapons_separator', 'InAnotherProfile']]);
      expect(answer).toEqual({
        applied: true,
        outcome: { landed: [landed], refused: [{ item: 'ModB', reason: 'its name gives it no folder' }] },
        partial: [{ message: 'Restore from manifest:', detail: 'ModA: the stat cache could not be written: disk full', severity: 'warning' }],
      });
    });

    it('answers a restore that stopped as a refusal naming the mods not finished', async () => {
      whatRestoreDestroys.mockResolvedValueOnce({ destroys: [], refused: [] });
      restoreFromManifest.mockResolvedValueOnce({ applied: false, refusal: 'Could not restore 1 mod: mEdit stopped.', unfinished: ['ModA'] });
      const { run } = register();

      expect(await run(RESTORE, new AgentCall([mod('ModA')], {})))
        .toEqual({ applied: false, refusal: 'Could not restore 1 mod: mEdit stopped.', detail: 'Not finished: "ModA". Restoring again finishes them.' });
    });

    it('answers a refusal when mEdit could not say what the restore destroys', async () => {
      whatRestoreDestroys.mockResolvedValueOnce({ refusal: 'Could not ask what restore from manifest destroys: mEdit gave no answer.' });
      const { run } = register();

      expect(await run(RESTORE, new AgentCall([mod('ModA')], {})))
        .toEqual({ applied: false, refusal: 'Could not ask what restore from manifest destroys: mEdit gave no answer.' });
      expect(sentMods(restoreFromManifest)).toEqual([]);
    });
  });
});
