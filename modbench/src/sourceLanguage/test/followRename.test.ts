import { afterEach, describe, expect, it, vi } from 'vitest';
import { Uri } from '../../test/vscodeMock';

type RenameListener = (event: { files: { oldUri: { fsPath: string }; newUri: { fsPath: string } }[] }) => void;
const renameListeners = vi.hoisted(() => new Set<RenameListener>());
vi.mock('vscode', () => ({
  workspace: {
    textDocuments: [],
    onDidRenameFiles: (listener: RenameListener) => { renameListeners.add(listener); return { dispose: () => { renameListeners.delete(listener); } }; },
  },
}));

import { followRenames, landing, type FileRename } from '../followRename';
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
  const follow = followRenames({
    adapter: { renamedSymbol: (from, to) => (symbols instanceof Error ? Promise.reject(symbols) : Promise.resolve(symbols.get(`${from} > ${to}`))) },
    plugins: { renamePlugin },
    entries: { renameMod, renameSeparator },
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
  return { follow, events, reporter, renamePlugin, renameMod, renameSeparator };
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

  it('renames a mod as the entry its folder\'s new name holds', async () => {
    const { follow, renameMod } = follower(new Map([renaming(OTHER_RENAME, MOD_RENAMED)]));

    await follow([OTHER_RENAME], Promise.resolve(true)).done;

    expect(renameMod).toHaveBeenCalledWith(expect.anything(), 'Base', 'Renamed Base');
  });

  it('renames a separator as the entry its folder\'s new name holds', async () => {
    const symbol: RenamedSymbol = { kind: 'entry', entry: { kind: 'separator', name: 'Gear' }, to: { kind: 'separator', name: 'Armour' } };
    const { follow, renameSeparator } = follower(new Map([renaming(OTHER_RENAME, symbol)]));

    await follow([OTHER_RENAME], Promise.resolve(true)).done;

    expect(renameSeparator).toHaveBeenCalledWith(expect.anything(), 'Gear', 'Armour');
  });

  it('lands a name the rename gesture refuses, with a warning that says why, and no reference follows', async () => {
    const { follow, events, reporter } = follower(new Map([renaming(RENAME, PLUGIN_RENAMED)]), { 'Patch.esp': { refusal: 'Not a valid plugin file name: "Renamed.esp"' } });

    const following = follow([RENAME], new Promise<boolean>(() => undefined));
    await following.planned;
    await following.done;

    expect(events).toEqual(['plan Patch.esp as Renamed.esp']);
    expect(reporter.reports).toEqual([{
      severity: 'warning', message: '"Patch.esp" (Patch Mod) was renamed to "Renamed.esp", and no reference to it followed: Not a valid plugin file name: "Renamed.esp"', detail: undefined,
    }]);
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

  it('says why it could not tell what a rename renames, and holds the rename no longer', async () => {
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
  const heard = (...renames: FileRename[]) => {
    for (const listener of renameListeners) listener({ files: renames.map(({ from, to }) => ({ oldUri: Uri.file(from), newUri: Uri.file(to) })) });
  };

  it('answers that it did once VS Code says it renamed each, and stops listening', async () => {
    const landed = landing([RENAME, OTHER_RENAME], 1_000);

    heard(RENAME, OTHER_RENAME);

    expect(await landed).toBe(true);
    expect(renameListeners.size).toBe(0);
  });

  it('answers that it did not, past the time VS Code gives a rename, when VS Code said it renamed something else', async () => {
    vi.useFakeTimers();
    const landed = landing([RENAME], 1_000);

    heard(OTHER_RENAME);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await landed).toBe(false);
    expect(renameListeners.size).toBe(0);
  });
});
