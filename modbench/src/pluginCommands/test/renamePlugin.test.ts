import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { pluginCommandsWith } from '../../test/pluginCommandsWith';
import { fakeInstanceAdapter, pluginFilesHeld, readingFixture } from '../../test/fakeInstanceAdapter';
import { heldTexts, type FileChanges } from '../../symbolNames/symbolNames';
import { BUILD_FILE } from '../../wire/sourceMod';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';

const PLUGIN = { name: 'Patch Mod.esp', origin: 'Patch Mod' };

const CHANGES = {
  treeName: 'Patch Mod.esp', moves: [{ from: '/m/plugin-source/Patch Mod.esp', to: '/m/plugin-source/Renamed Patch.esp' }], deletions: [], documents: [], leftBehind: [],
};

describe('renamePlugin — every box whose files name the plugin carries the rename (ADR-0028)', () => {
  let client: InMemoryMEditClient;
  let sourceFolder: string;
  let applied: (readonly FileChanges[])[];
  const apply = vi.fn((changes: readonly FileChanges[]) => {
    applied.push(changes);
    return Promise.resolve(undefined);
  });
  const rename = (newName: string, held: readonly string[] = [], winningModsHoldingACopy: readonly string[] = []) => {
    const fake = fakeInstanceAdapter(readingFixture({
      ...pluginFilesHeld(
        { origin: { kind: 'mod', name: PLUGIN.origin }, name: PLUGIN.name },
        ...held.map((name) => ({ origin: { kind: 'mod', name: PLUGIN.origin } as const, name })),
        ...winningModsHoldingACopy.map((mod) => ({ origin: { kind: 'mod', name: mod } as const, name: PLUGIN.name })),
      ),
      mods: [...winningModsHoldingACopy, PLUGIN.origin].map((name) => ({ kind: 'mod', name, enabled: true })),
      pluginOrder: [{ name: PLUGIN.name, enabled: true }],
      sourceModFolders: new Map([[PLUGIN.origin, sourceFolder]]),
    }));
    const result = pluginCommandsWith(fake.adapter, client).renamePlugin({ held: heldTexts([]), apply }, PLUGIN, newName);
    return { fake, result };
  };
  const lines = async (fake: ReturnType<typeof rename>['fake']) => (await fake.adapter.reading()).pluginOrder.map(({ name }) => name);

  beforeEach(async () => {
    sourceFolder = await mkdtemp(join(tmpdir(), 'renamePlugin-'));
    client = new InMemoryMEditClient();
    client.setCommandResult('getRenameSourceChanges', CHANGES);
    client.setCommandResult('moveLastWritten', { moved: true });
    client.setQueryAnswer('getCreatablePluginExtensions', ['.esm', '.esl', '.esp']);
    client.setQueryAnswer('getPluginNameReferences', []);
    applied = [];
    apply.mockClear();
  });
  afterEach(() => rm(sourceFolder, { recursive: true, force: true }));

  it('applies mEdit\'s changes and the build file\'s as one edit, moves what was last written, then renames the file and its lines', async () => {
    await writeFile(join(sourceFolder, BUILD_FILE), '{"version":1,"steps":[{"compile":["Patch Mod.esp"]}]}');

    const { fake, result } = rename('Renamed Patch.esp');

    expect(await result).toEqual({ applied: true, cannotFollow: [] });
    expect(applied).toEqual([[
      { moves: CHANGES.moves, deletions: [], documents: [] },
      { moves: [], deletions: [], documents: [{ path: join(sourceFolder, BUILD_FILE), text: '{"version":1,"steps":[{"compile":["Renamed Patch.esp"]}]}' }] },
      { moves: [], deletions: [], documents: [] },
    ]]);
    expect(fake.calls).toEqual([
      { verb: 'renamePlugin', origin: { kind: 'mod', name: 'Patch Mod' }, from: 'Patch Mod.esp', to: 'Renamed Patch.esp' },
    ]);
    expect(await lines(fake)).toEqual(['Renamed Patch.esp']);
  });

  it('carries no reference by its file name alone for a copy mod order resolves that name to another copy of, reading mod order through the Instance adapter', async () => {
    const { fake, result } = rename('Renamed Patch.esp', [], ['Winning Mod']);

    expect(await result).toEqual({ applied: true, cannotFollow: [] });
    expect(client.calls.find((call) => call.method === 'getRenameSourceChanges')?.args[2]).toEqual({ namedByFileName: false, sourceFiles: [] });
    expect(fake.calls).toEqual([{ verb: 'renamePlugin', origin: { kind: 'mod', name: 'Patch Mod' }, from: 'Patch Mod.esp', to: 'Renamed Patch.esp' }]);
    expect(await lines(fake)).toEqual(['Patch Mod.esp']);
  });

  it('refuses a name the origin already holds before any write', async () => {
    const { fake, result } = rename('Renamed Patch.esp', ['Renamed Patch.esp']);

    expect(await result).toEqual({ applied: false, refusal: '"Patch Mod" already holds "Renamed Patch.esp".' });
    expect(client.calls.map((call) => call.method)).toEqual(['getCreatablePluginExtensions']);
    expect(apply).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
  });

  it('refuses a name that is not a folder name before the source moves', async () => {
    const { fake, result } = rename('a/b.esp');

    expect(await result).toEqual({ applied: false, refusal: 'A name cannot be . or .. or contain / or \\' });
    expect(apply).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
  });

  it('refuses with the reason, writing nothing, when mEdit cannot say which extensions a plugin may take', async () => {
    client.setQueryFailure('getCreatablePluginExtensions', { failed: 'refused', refusal: 'mEdit is not ready.' });
    const { fake, result } = rename('Renamed Patch.esp');

    expect(await result).toEqual({
      applied: false, refusal: 'Could not check "Renamed Patch.esp" for "Patch Mod.esp" (Patch Mod).', detail: 'mEdit is not ready.',
    });
    expect(apply).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
  });
});

describe('renameRefusal — what the prompt is told before the rename is asked for', () => {
  const refusal = (newName: string, heldIn: string) => pluginCommandsWith(fakeInstanceAdapter(readingFixture(pluginFilesHeld(
    { origin: { kind: 'mod', name: heldIn }, name: 'Renamed Patch.esp' },
  ))).adapter).renameRefusal(PLUGIN, newName, ['.esm', '.esl', '.esp']);

  it.each<[string, string, string, string | undefined]>([
    ['refuses a name the plugin\'s origin holds', 'Renamed Patch.esp', 'Patch Mod', '"Patch Mod" already holds "Renamed Patch.esp".'],
    ['lets through a name only another origin holds', 'Renamed Patch.esp', 'OtherMod', undefined],
  ])('%s', async (_case, newName, heldIn, expected) => {
    expect(await refusal(newName, heldIn)).toBe(expected);
  });
});
