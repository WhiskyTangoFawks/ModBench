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
import { progressSteps } from '../../test/recordedProgress';
import { registerModlistCommands } from '../modlistGestures';
import { recordingReporter, scriptedDialog, type ScriptedDialog } from '../../test/surfacingDoubles';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { present } from '../../ports/present';
import type { ModlistSourceCommands } from '../../sourceCommands/modlistSourceCommands';

const gitInit = vi.fn<ModlistSourceCommands['gitInit']>();
const updateManifest = vi.fn<ModlistSourceCommands['updateManifest']>();
const restoreFromManifest = vi.fn<ModlistSourceCommands['restoreFromManifest']>();

const UPDATE = 'modbench.mod.updateManifest';
const RESTORE = 'modbench.mod.restoreFromManifest';

const value = instanceValueFixture({
  mods: [
    { kind: 'mod', name: 'ModA', enabled: true },
    { kind: 'separator', name: 'Weapons', enabled: true },
    { kind: 'mod', name: 'ModB', enabled: false },
  ],
  modFolders: [
    { kind: 'mod', name: 'ModA', path: '/instance/mods/ModA' },
    { kind: 'separator', name: 'Weapons', path: '/instance/mods/Weapons_separator' },
    { kind: 'mod', name: 'ModB', path: '/instance/mods/ModB' },
    { kind: 'mod', name: 'InAnotherProfile', path: '/instance/mods/InAnotherProfile' },
  ],
});
const EVERY_MOD = ['ModA', 'ModB', 'InAnotherProfile'];

const modRow = (name: string) => ({ argument: { kind: 'mod', name }, name });
const separatorRow = (name: string) => ({ argument: { kind: 'separator', name }, name });
const folderRow = { argument: { kind: 'folder', path: '/instance/mods/ModA/meshes' }, name: 'meshes' };

function register(over: Partial<Parameters<typeof registerModlistCommands>[0]> = {}, ask: ScriptedDialog = scriptedDialog('Restore')) {
  const reporter = recordingReporter();
  const said: (string | undefined)[] = [];
  registerModlistCommands({
    commands: { gitInit, updateManifest, restoreFromManifest }, ask,
    instance: { value, refresh: () => { progressSteps.push('Instance loader: read every file again'); return Promise.resolve(undefined); } },
    reporter, say: (message) => { said.push(message); }, modsView: 'modbench.modList',
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
  gitInit.mockResolvedValue({ applied: true });
  updateManifest.mockResolvedValue({ applied: true, notes: [], landed: [], refused: [] });
  restoreFromManifest.mockResolvedValue({ applied: true, landed: [], refused: [] });
});

describe('Git init', () => {
  it('makes the repository under the Toolbox\'s progress, which closes once the Instance loader has read again, and says nothing', async () => {
    gitInit.mockImplementationOnce(() => { progressSteps.push('git init'); return Promise.resolve({ applied: true }); });
    const { reporter, run } = register();

    await run('modbench.modlist.gitInit');

    expect(progressSteps).toEqual(['progress opens on modbench.toolbox', 'git init', 'Instance loader: read every file again', 'progress closes']);
    expect([reporter.reports, reporter.landings]).toEqual([[], []]);
  });

  it('reports a refusal at error, naming why', async () => {
    gitInit.mockResolvedValueOnce({ applied: false, refusal: '/instance already holds a repository.' });
    const { reporter, run } = register();

    await run('modbench.modlist.gitInit');

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not git init.', detail: '/instance already holds a repository.' }]);
  });
});

describe('Every mod (update manifest and restore from manifest)', () => {
  it('acts on every mod folder, in every profile, enabled or not, and no separator, from the palette with no Mods selection', async () => {
    const { run } = register();

    await run(UPDATE);

    expect(sentMods(updateManifest)).toEqual([EVERY_MOD]);
  });

  it('acts on the Mods selection from the palette, under the Mods view\'s progress', async () => {
    const { run } = register({ focusedView: { id: () => 'modbench.modList', selection: () => [modRow('ModB')] } });

    await run(UPDATE);

    expect([sentMods(updateManifest), progressSteps[0]]).toEqual([[['ModB']], 'progress opens on modbench.modList']);
  });

  it('acts on every mod from the palette while another view has the focus', async () => {
    const { run } = register({ focusedView: { id: () => 'modbench.pluginListTree', selection: () => [modRow('ModB')] } });

    await run(UPDATE);

    expect(sentMods(updateManifest)).toEqual([EVERY_MOD]);
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

  it('takes a selected separator for the mods it holds, those before it in winning-first mod order, each mod once', async () => {
    const { run } = register();

    await run(UPDATE, separatorRow('Weapons'), [separatorRow('Weapons'), modRow('ModB'), modRow('ModA')]);

    expect(sentMods(updateManifest)).toEqual([['ModA', 'ModB']]);
  });

  it('refuses a selected row that is neither a mod nor a separator, naming it, and acts on the rest', async () => {
    const { reporter, run } = register();

    await run(UPDATE, modRow('ModA'), [modRow('ModA'), folderRow]);

    expect(sentMods(updateManifest)).toEqual([['ModA']]);
    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Update manifest: 0 mods unchanged, 0 updated, 1 refused; 0 files have no provider.',
      detail: '"meshes" (it is not a mod or a separator)',
    }]);
  });

  it('update manifest shows its progress by mod in a notification with Cancel', async () => {
    updateManifest.mockImplementationOnce((_mods, _instance, options) => {
      options?.onProgress?.({ phase: 'Updating', mod: 'ModA', modsDone: 0, modsTotal: 2 });
      return Promise.resolve({ applied: true, notes: [], landed: [], refused: [] });
    });
    const { run } = register();

    await run(UPDATE, modRow('ModA'));

    expect([notification.cancellable, notification.messages]).toEqual([[true], [expect.stringContaining('"ModA", 0 of 2 mods done') as unknown]]);
  });

  it('restore from manifest shows its progress by mod in a notification with Cancel', async () => {
    restoreFromManifest.mockImplementationOnce((_mods, _instance, options) => {
      options?.onProgress?.({ phase: 'Restoring', mod: 'ModA', modsDone: 0, modsTotal: 2 });
      return Promise.resolve({ applied: true, landed: [], refused: [] });
    });
    const { run } = register();

    await run(RESTORE, modRow('ModA'));

    expect([notification.cancellable, notification.messages]).toEqual([[true], [expect.stringContaining('"ModA", 0 of 2 mods done') as unknown]]);
  });

  it('update manifest, cancelled, aborts the signal it handed the command, and reports what mEdit answered', async () => {
    let signal: AbortSignal | undefined;
    updateManifest.mockImplementationOnce((_mods, _instance, options) => {
      notification.cancel();
      signal = options?.signal;
      return Promise.resolve({ applied: true, notes: [], landed: [{ mod: 'ModA', manifestWritten: true, noProvider: [] }], refused: [] });
    });
    const { reporter, run } = register();

    await run(UPDATE, modRow('ModA'), [modRow('ModA'), modRow('ModB')]);

    expect([signal?.aborted, reporter.landings]).toEqual([true, ['Update manifest: 0 mods unchanged, 1 updated, 0 refused; 0 files have no provider.']]);
  });

  it('restore from manifest, cancelled, aborts the signal it handed the command, and reports what mEdit answered', async () => {
    let signal: AbortSignal | undefined;
    restoreFromManifest.mockImplementationOnce((_mods, _instance, options) => {
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
    [UPDATE, () => updateManifest.mockResolvedValueOnce({ applied: true, notes: [], landed: [], refused: [], cancelRefusal: 'Could not cancel — not running.' })],
    [RESTORE, () => restoreFromManifest.mockResolvedValueOnce({ applied: true, landed: [], refused: [], cancelRefusal: 'Could not cancel — not running.' })],
  ])('%s reports a cancel mEdit refused', async (id, answersCancelRefused) => {
    answersCancelRefused();
    const { reporter, run } = register();

    await run(id, modRow('ModA'));

    expect(reporter.reports).toContainEqual({ severity: 'error', message: 'Could not cancel — not running.', detail: undefined });
  });
});

describe('Update manifest', () => {
  it('says its phase on the Toolbox\'s message line while it runs, and gives the line back when it ends', async () => {
    updateManifest.mockImplementationOnce((_mods, _instance, options) => {
      options?.onProgress?.({ phase: 'ReadingFiles', mod: 'ModA' });
      options?.onProgress?.({ phase: 'Updating', mod: 'ModA', modsDone: 0, modsTotal: 2 });
      return Promise.resolve({ applied: true, notes: [], landed: [], refused: [] });
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
    updateManifest.mockImplementationOnce(() => { progressSteps.push('update manifest'); return Promise.resolve({ applied: true, notes: [], landed: [], refused: [] }); });
    const { ask, run } = register();

    await run(UPDATE, modRow('ModA'));

    expect(progressSteps).toEqual(['progress opens on modbench.modList', 'update manifest', 'Instance loader: read every file again', 'progress closes']);
    expect(ask.asked).toEqual([]);
  });

  it('says in one line how many mods were unchanged, updated and refused, and that no file lacks a provider', async () => {
    updateManifest.mockResolvedValueOnce({
      applied: true, notes: [], refused: [],
      landed: [{ mod: 'ModA', manifestWritten: true, noProvider: [] }, { mod: 'ModB', manifestWritten: false, noProvider: [] }, { mod: 'C', manifestWritten: false, noProvider: [] }],
    });
    const { reporter, run } = register();

    await run(UPDATE);

    expect([reporter.landings, reporter.reports]).toEqual([['Update manifest: 2 mods unchanged, 1 updated, 0 refused; 0 files have no provider.'], []]);
  });

  it('warns in that line when a file has no provider, naming each by mod in the Output', async () => {
    updateManifest.mockResolvedValueOnce({ applied: true, notes: [], landed: [{ mod: 'ModA', manifestWritten: true, noProvider: ['a.nif', 'b/c.dds'] }], refused: [] });
    const { reporter, run } = register();

    await run(UPDATE, modRow('ModA'));

    expect([reporter.landings, reporter.reports]).toEqual([[], [{
      severity: 'warning', message: 'Update manifest: 0 mods unchanged, 1 updated, 0 refused; 2 files have no provider.', detail: 'ModA: a.nif\nModA: b/c.dds',
    }]]);
  });

  it('errs in that line when a mod is refused, naming each refused mod with why, then each file with no provider', async () => {
    updateManifest.mockResolvedValueOnce({
      applied: true, notes: [],
      landed: [{ mod: 'ModA', manifestWritten: false, noProvider: ['a.nif'] }],
      refused: [{ item: 'ModB', reason: "'ModB' was not updated: 'B.zip' not in the downloads folder." }],
    });
    const { reporter, run } = register();

    await run(UPDATE);

    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Update manifest: 1 mod unchanged, 0 updated, 1 refused; 1 file has no provider.',
      detail: `"ModB" ('ModB' was not updated: 'B.zip' not in the downloads folder.)\nModA: a.nif`,
    }]);
  });

  it('warns in that line when a mod folder\'s listing skipped an entry, naming each in the Output', async () => {
    updateManifest.mockResolvedValueOnce({ applied: true, notes: ['ModA: broken link "a.nif", skipped'], landed: [{ mod: 'ModA', manifestWritten: false, noProvider: [] }], refused: [] });
    const { reporter, run } = register();

    await run(UPDATE, modRow('ModA'));

    expect([reporter.landings, reporter.reports]).toEqual([[], [{
      severity: 'warning', message: 'Update manifest: 1 mod unchanged, 0 updated, 0 refused; 0 files have no provider.', detail: 'ModA: broken link "a.nif", skipped',
    }]]);
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

  it('restores nothing and says nothing when the question is cancelled', async () => {
    const { reporter, run } = register({}, scriptedDialog(undefined));

    await run(RESTORE, modRow('ModA'));

    expect([restoreFromManifest.mock.calls, progressSteps, reporter.reports, reporter.landings]).toEqual([[], [], [], []]);
  });

  it('asks nothing when no selected row is a mod or a separator, and names each', async () => {
    const { ask, reporter, run } = register({ focusedView: { id: () => 'modbench.modList', selection: () => [folderRow] } });

    await run(RESTORE);

    expect([ask.asked, restoreFromManifest.mock.calls]).toEqual([[], []]);
    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not restore 1 of 1 mods.', detail: '"meshes" (it is not a mod or a separator)' }]);
  });

  it('says its phase on the Toolbox\'s message line while it runs, and gives the line back when it ends', async () => {
    restoreFromManifest.mockImplementationOnce((_mods, _instance, options) => {
      options?.onProgress?.({ phase: 'ReadingFiles', mod: 'ModA' });
      options?.onProgress?.({ phase: 'Restoring', mod: 'ModA', modsDone: 0, modsTotal: 2 });
      options?.onProgress?.({ phase: 'ReadingDownloadedFile', file: 'Deltas.7z' });
      return Promise.resolve({ applied: true, landed: [], refused: [] });
    });
    const { said, run } = register();

    await run(RESTORE);

    expect(said).toEqual([
      'Restore from manifest — reading the files of "ModA"…', 'Restore from manifest — "ModA", 0 of 2 mods done…',
      'Restore from manifest — searching "Deltas.7z" for deltas…', undefined,
    ]);
  });

  it.each([
    [[{ mod: 'ModA', written: ['a.nif'] }, { mod: 'ModB', written: [] }], ['Restored "ModA" from its manifest.']],
    [[{ mod: 'ModA', written: ['a.nif'] }, { mod: 'ModB', written: ['b.nif'] }], ['Restored 2 mods from their manifests.']],
    [[{ mod: 'ModA', written: [] }, { mod: 'ModB', written: [] }], []],
  ])('says what it restored, and nothing when it wrote nothing: %j', async (landed, landings) => {
    restoreFromManifest.mockResolvedValueOnce({ applied: true, landed, refused: [] });
    const { reporter, run } = register();

    await run(RESTORE);

    expect([reporter.landings, reporter.reports]).toEqual([landings, []]);
  });

  it('names each skipped mod with what it lacks, and does not call the mods that landed failed', async () => {
    restoreFromManifest.mockResolvedValueOnce({
      applied: true, landed: [{ mod: 'ModA', written: ['a.nif'] }], refused: [{ item: 'ModB', reason: "'ModB' was skipped: 'b.nif' has no provider." }],
    });
    const { reporter, run } = register();

    await run(RESTORE, modRow('ModA'), [modRow('ModA'), modRow('ModB')]);

    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not restore 1 of 2 mods.', detail: `"ModB" ('ModB' was skipped: 'b.nif' has no provider.)`,
    }]);
    expect(reporter.landings).toEqual([]);
  });

  it('names the mods a restore interrupted part way did not finish', async () => {
    restoreFromManifest.mockResolvedValueOnce({ applied: false, refusal: 'Could not restore 2 mods — mEdit stopped.', unfinished: ['ModB'] });
    const { reporter, run } = register();

    await run(RESTORE);

    expect(reporter.reports).toEqual([{
      severity: 'error', message: 'Could not restore 2 mods — mEdit stopped.', detail: 'Not finished: "ModB". Restoring again finishes them.',
    }]);
  });

  it('gives the message line back when restore throws', async () => {
    restoreFromManifest.mockRejectedValueOnce(new Error('boom'));
    const { said, run } = register();

    await expect(run(RESTORE)).rejects.toThrow('boom');

    expect(said).toEqual([undefined]);
  });
});
