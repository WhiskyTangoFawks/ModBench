import { afterEach, describe, expect, it, vi } from 'vitest';
import { Uri } from '../../test/vscodeMock';

type FilesRenamed = { files: { oldUri: { fsPath: string; scheme: string }; newUri: { fsPath: string } }[] };
type RenameListener = (event: FilesRenamed) => void;
type WillRenameListener = (event: FilesRenamed & { waitUntil(thenable: Promise<unknown>): void }) => void;
const renameListeners = vi.hoisted(() => new Set<RenameListener>());
const willRenameListeners = vi.hoisted(() => new Set<WillRenameListener>());
const PARTICIPANTS_TIMEOUT_MS = vi.hoisted(() => 1_000);
vi.mock('vscode', () => ({
  workspace: {
    textDocuments: [],
    onDidRenameFiles: (listener: RenameListener) => { renameListeners.add(listener); return { dispose: () => { renameListeners.delete(listener); } }; },
    onWillRenameFiles: (listener: WillRenameListener) => { willRenameListeners.add(listener); return { dispose: () => { willRenameListeners.delete(listener); } }; },
    getConfiguration: () => ({ get: () => PARTICIPANTS_TIMEOUT_MS }),
  },
  commands: { registerCommand: () => ({ dispose: () => undefined }) },
  Disposable: { from: (...disposables: { dispose(): void }[]) => ({ dispose: () => { for (const disposable of disposables) disposable.dispose(); } }) },
}));

import { followRenames, registerFollowRename, type FileRename } from '../followRename';
import type { RenamedSymbol } from '../../instanceAdapter/instanceAdapter';
import type { ChangeResult } from '../../ports/changeResult';
import type { RenameEditing } from '../../modCommands/renameEntry';
import type { FileChanges } from '../../symbolNames/symbolNames';
import { recordingReporter } from '../../test/surfacingDoubles';

const RENAME: FileRename = { from: '/mods/Patch Mod/Patch.esp', to: '/mods/Patch Mod/Renamed.esp' };
const OTHER_RENAME: FileRename = { from: '/mods/Base', to: '/mods/Renamed Base' };
const PLUGIN_RENAMED: RenamedSymbol = { kind: 'plugin', plugin: { name: 'Patch.esp', origin: 'Patch Mod' }, to: 'Renamed.esp' };
const MOD_RENAMED: RenamedSymbol = { kind: 'entry', entry: { kind: 'mod', name: 'Base' }, to: { kind: 'mod', name: 'Renamed Base' } };
const CHANGES: FileChanges = { moves: [], deletions: [], documents: [{ path: '/source/Patch Mod/build.yaml', text: 'renamed' }] };

type Answer = { refusal: string } | { cannotFollow: string[] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function follower(symbols: ReadonlyMap<string, RenamedSymbol> | Error, answers: Readonly<Record<string, Answer>> = {}) {
  const events: string[] = [];
  let quiet = 0;
  const reporter = recordingReporter();
  const rename = async ({ apply }: RenameEditing, from: string, to: string): Promise<ChangeResult> => {
    events.push(`plan ${from} as ${to}`);
    const answer = answers[from] ?? { cannotFollow: [] };
    if ('refusal' in answer) return { applied: false, refusal: answer.refusal };
    const unapplied = await apply([CHANGES]);
    if (unapplied !== undefined) return { applied: false, unapplied };
    events.push(`commit ${to}${quiet > 0 ? ', quiet' : ''}`);
    return { applied: true, cannotFollow: answer.cannotFollow };
  };
  const renamePlugin = vi.fn((editing: RenameEditing, { name }: { name: string }, to: string) => rename(editing, name, to));
  const renameMod = vi.fn(async (editing: RenameEditing, from: string, to: string) => {
    const result = await rename(editing, from, to);
    return result.applied ? { ...result, name: to } : result;
  });
  const renameSeparator = vi.fn(renameMod);
  const renameDownloadedFile = vi.fn(rename);
  const renameProfile = vi.fn(rename);
  const follow = followRenames({
    adapter: { renamedSymbol: (from, to) => (symbols instanceof Error ? Promise.reject(symbols) : Promise.resolve(symbols.get(`${from} > ${to}`))) },
    plugins: { renamePlugin },
    entries: { renameMod, renameSeparator },
    downloads: { renameDownloadedFile },
    profiles: { renameProfile },
    source: {
      applyWorkspaceChanges: (items) => { events.push(`apply ${String(items.length)}${quiet > 0 ? ', quiet' : ''}`); return Promise.resolve(); },
      oneAtATime: (job) => job(),
      refreshSourceControlFor: () => undefined,
    },
    instance: {
      quiet: async (work) => {
        quiet += 1;
        try { return await work(); } finally { quiet -= 1; }
      },
    },
    reporter,
  });
  return { follow, events, reporter, renamePlugin, renameMod, renameSeparator, renameDownloadedFile, renameProfile };
}

const renaming = (rename: FileRename, symbol: RenamedSymbol): [string, RenamedSymbol] => [`${rename.from} > ${rename.to}`, symbol];

describe('following a rename VS Code makes of a file or folder that is a symbol (symbols.md, The features, stories 6 and 9)', () => {
  it('plans against the old name before the rename lands, then applies the edit and commits, the instance quiet throughout', async () => {
    const landing = deferred<boolean>();
    const { follow, events, reporter } = follower(new Map([renaming(RENAME, PLUGIN_RENAMED)]));

    const following = follow([RENAME], landing.promise);
    await following.planned;
    expect(events).toEqual(['plan Patch.esp as Renamed.esp']);

    landing.resolve(true);
    await following.done;
    expect(events).toEqual(['plan Patch.esp as Renamed.esp', 'apply 1, quiet', 'commit Renamed.esp, quiet']);
    expect(reporter.reports).toEqual([]);
  });

  it.each([
    ['a mod', MOD_RENAMED, 'renameMod', ['Base', 'Renamed Base']],
    ['a separator', { kind: 'entry', entry: { kind: 'separator', name: 'Gear' }, to: { kind: 'separator', name: 'Armour' } }, 'renameSeparator', ['Gear', 'Armour']],
    ['a downloaded file', { kind: 'entry', entry: { kind: 'downloadedFile', name: 'Gear-1.7z' }, to: { kind: 'downloadedFile', name: 'Gear-2.7z' } }, 'renameDownloadedFile', ['Gear-1.7z', 'Gear-2.7z']],
    ['a profile', { kind: 'entry', entry: { kind: 'profile', name: 'Default' }, to: { kind: 'profile', name: 'Main' } }, 'renameProfile', ['Default', 'Main']],
  ] as const)('renames %s as the symbol its new name holds', async (_case, symbol, command, names) => {
    const renamer = follower(new Map([renaming(OTHER_RENAME, symbol)]));

    await renamer.follow([OTHER_RENAME], Promise.resolve(true)).done;

    expect(renamer[command].mock.calls.map(([, from, to]) => [from, to])).toEqual([names]);
  });

  const REFUSED = { 'Patch.esp': { refusal: 'Not a valid plugin file name: "Renamed.esp"' } };

  it('lands a name the rename gesture refuses, with a warning once VS Code has renamed it that says why, and no reference follows', async () => {
    const landing = deferred<boolean>();
    const { follow, events, reporter } = follower(new Map([renaming(RENAME, PLUGIN_RENAMED)]), REFUSED);

    const following = follow([RENAME], landing.promise);
    await following.planned;
    expect(reporter.reports).toEqual([]);

    landing.resolve(true);
    await following.done;
    expect(events).toEqual(['plan Patch.esp as Renamed.esp']);
    expect(reporter.reports).toEqual([{
      severity: 'warning', message: '"Patch.esp" (Patch Mod) was renamed to "Renamed.esp", and no reference to it followed: Not a valid plugin file name: "Renamed.esp"', detail: undefined,
    }]);
  });

  it.each([
    ['a name the rename gesture refuses', new Map([renaming(RENAME, PLUGIN_RENAMED)]), REFUSED, '"Patch.esp" (Patch Mod)'],
    ['a separator\'s folder given a mod\'s name', new Map([renaming(RENAME, { kind: 'entry', entry: { kind: 'separator', name: 'Gear' }, to: { kind: 'mod', name: 'Armour' } })]), {}, '"Gear"'],
  ])('says for %s that VS Code did not report the rename, when it never lands, and never that it was renamed', async (_case, symbols, answers, named) => {
    const { follow, reporter } = follower(symbols, answers);

    await follow([RENAME], Promise.resolve(false)).done;

    expect(reporter.reports.map(({ severity, message }) => ({ severity, message }))).toEqual([
      { severity: 'warning', message: `VS Code did not report renaming ${named}, so no reference to it followed.` },
    ]);
  });

  it('warns naming each reference that could not follow (story 7)', async () => {
    const { follow, reporter } = follower(new Map([renaming(RENAME, PLUGIN_RENAMED)]), { 'Patch.esp': { cannotFollow: ['LOOT\'s masterlist names Patch.esp'] } });

    await follow([RENAME], Promise.resolve(true)).done;

    expect(reporter.reports).toEqual([{
      severity: 'warning', message: 'Renamed "Patch.esp" (Patch Mod) to "Renamed.esp". 1 references to it could not follow.', detail: 'LOOT\'s masterlist names Patch.esp',
    }]);
  });

  it('applies and commits nothing when VS Code never says the rename landed, and says so', async () => {
    const { follow, events, reporter } = follower(new Map([renaming(RENAME, PLUGIN_RENAMED)]));

    await follow([RENAME], Promise.resolve(false)).done;

    expect(events).toEqual(['plan Patch.esp as Renamed.esp']);
    expect(reporter.reports.map(({ severity, message }) => ({ severity, message }))).toEqual([
      { severity: 'warning', message: 'VS Code did not report renaming "Patch.esp" (Patch Mod), so no reference to it followed.' },
    ]);
  });

  it('carries nothing for a separator\'s folder renamed to a mod\'s name, and says why', async () => {
    const symbol: RenamedSymbol = { kind: 'entry', entry: { kind: 'separator', name: 'Gear' }, to: { kind: 'mod', name: 'Armour' } };
    const { follow, reporter, renameSeparator, renameMod } = follower(new Map([renaming(OTHER_RENAME, symbol)]));

    await follow([OTHER_RENAME], Promise.resolve(true)).done;

    expect([...renameSeparator.mock.calls, ...renameMod.mock.calls]).toEqual([]);
    expect(reporter.reports.map(({ severity, message }) => ({ severity, message }))).toEqual([
      { severity: 'warning', message: '"Gear" was renamed to "Armour", which names a mod and not a separator, so no reference to it followed.' },
    ]);
  });

  it('leaves to VS Code a file that is no symbol, planning nothing and holding nothing', async () => {
    const { follow, events, reporter } = follower(new Map());

    const following = follow([RENAME], new Promise<boolean>(() => undefined));
    await following.planned;
    await following.done;

    expect({ events, reports: reporter.reports }).toEqual({ events: [], reports: [] });
  });

  it('says why it could not tell what a rename renames, and lets the rename go on', async () => {
    const { follow, reporter } = follower(new Error('mods/ cannot be listed'));

    const following = follow([RENAME], new Promise<boolean>(() => undefined));
    await following.planned;
    await following.done;

    expect(reporter.reports).toEqual([{ severity: 'error', message: 'Could not carry the references to what VS Code renamed.', detail: 'mods/ cannot be listed' }]);
  });

  it('has planned once every symbol it renames has planned, one refusing and one waiting on the rename', async () => {
    const landing = deferred<boolean>();
    const { follow, events } = follower(new Map([renaming(RENAME, PLUGIN_RENAMED), renaming(OTHER_RENAME, MOD_RENAMED)]), { 'Patch.esp': { refusal: 'refused' } });

    const following = follow([RENAME, OTHER_RENAME], landing.promise);
    await following.planned;

    expect(events).toEqual(['plan Patch.esp as Renamed.esp', 'plan Base as Renamed Base']);
    landing.resolve(true);
    await following.done;
  });
});

describe('whether VS Code renamed what a rename planned for', () => {
  afterEach(() => { vi.useRealTimers(); });
  const filesOf = (renames: FileRename[]) => renames.map(({ from, to }) => ({ oldUri: Uri.file(from), newUri: Uri.file(to) }));
  const landingOf = (...renames: FileRename[]): Promise<boolean> => {
    let landed!: Promise<boolean>;
    const registered = registerFollowRename((_renames, landing) => { landed = landing; return { planned: Promise.resolve(), done: Promise.resolve() }; });
    for (const listener of willRenameListeners) listener({ files: filesOf(renames), waitUntil: () => undefined });
    registered.dispose();
    return landed;
  };
  const heard = (...renames: FileRename[]) => {
    for (const listener of renameListeners) listener({ files: filesOf(renames) });
  };

  it('answers that it did once VS Code says it renamed each, and stops listening', async () => {
    const landed = landingOf(RENAME, OTHER_RENAME);

    heard(RENAME, OTHER_RENAME);

    expect(await landed).toBe(true);
    expect(renameListeners.size).toBe(0);
  });

  it('answers that it did not once VS Code\'s participant timeout and the rename after it have passed, when VS Code said it renamed something else', async () => {
    vi.useFakeTimers();
    let answer: boolean | undefined;
    const landed = landingOf(RENAME);
    void landed.then((did) => { answer = did; });

    heard(OTHER_RENAME);
    await vi.advanceTimersByTimeAsync(PARTICIPANTS_TIMEOUT_MS + 9_999);
    const before = answer;
    await vi.advanceTimersByTimeAsync(1);

    expect([before, answer, renameListeners.size]).toEqual([undefined, false, 0]);
  });
});
