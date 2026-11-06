import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entryRenameCommands } from '../renameEntry';
import type { InstanceReading, ModlistEntry } from '../../instanceAdapter/instanceAdapter';
import { heldTexts, type FileChanges } from '../../symbolNames/symbolNames';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { fakeInstanceAdapter, modFoldersIn, modFoldersOf, readingFixture, refusing, repositoriesOf, type AdapterCall, type InstanceAnswers } from '../../test/fakeInstanceAdapter';

const mod = (name: string, enabled = true): ModlistEntry => ({ kind: 'mod', name, enabled });
const separator = (name: string): ModlistEntry => ({ kind: 'separator', name, enabled: false });

const ORDER = [mod('SKK Fast Start'), separator('Core'), mod('Harder VATS', false), separator('Other'), mod('ENBoost')];
const INCLUDE = { name: 'Include', badge: 'IN', marksPaths: true };
const SOURCE_MOVES = [{ from: '/instance/source/Harder VATS', to: '/source/Harder VATS 2' }];

function over(answers: InstanceAnswers = {}, reading: Partial<InstanceReading> = {}) {
  const fake = fakeInstanceAdapter(readingFixture({ mods: ORDER, modFolders: modFoldersOf(...ORDER), ...reading }), answers);
  const client = new InMemoryMEditClient();
  client.setCommandResult('getSourceFolderMoveChanges', { moves: SOURCE_MOVES, deletions: [], documents: [] });
  client.setCommandResult('followSourceFolderMove', { followed: true });
  const applied: (readonly FileChanges[])[] = [];
  const editing = { held: heldTexts([]), apply: (changes: readonly FileChanges[]) => { applied.push(changes); return Promise.resolve(undefined); } };
  return { fake, client, applied, editing, commands: entryRenameCommands({ adapter: fake.adapter, client }) };
}

const verbs = (calls: readonly AdapterCall[]) => calls.map((call) => ('profile' in call ? `${call.verb} ${call.profile}` : call.verb));

describe('rename mod: the folder, its line in each profile, and each reference to it (mods.md, Rename mod)', () => {
  const rename = ({ commands, editing }: ReturnType<typeof over>, to = 'Harder VATS 2') => commands.renameMod(editing, 'Harder VATS', to);

  it('renames the folder, then the line in each profile, the active one first, then the folder in the instance repository and the publisher', async () => {
    const renamer = over({ publisherTags: [INCLUDE] }, { profiles: ['Secondary', 'Default'] });

    expect(await rename(renamer)).toEqual({ applied: true, cannotFollow: [], name: 'Harder VATS 2' });
    expect(verbs(renamer.fake.calls)).toEqual(['renameModFolder', 'changeModOrder Default', 'changeModOrder Secondary', 'followFoldersInRepository', 'followModFolders']);
    expect(renamer.fake.calls.filter(({ verb }) => verb === 'followModFolders')).toEqual([
      { verb: 'followModFolders', moves: [{ from: '/instance/mods/Harder VATS', to: '/instance/mods/Harder VATS 2' }] },
    ]);
  });

  it('lands with each profile whose line could not be renamed, the folder staying renamed', async () => {
    const renamer = over({ refusals: (call) => (call.verb === 'changeModOrder' && call.profile === 'Secondary' ? 'disk full' : undefined) }, { profiles: ['Default', 'Secondary'] });

    expect(await rename(renamer)).toMatchObject({ applied: true, cannotFollow: ['profile "Secondary"\'s modlist.txt: disk full'] });
  });

  it('lands with its publisher tags left behind when they cannot follow, as when the configuration cannot be read (ADR-0028)', async () => {
    const renamer = over({ publisherTags: [INCLUDE], refusals: refusing('followModFolders', 'compiler_settings.json is not JSON') });

    expect(await rename(renamer)).toMatchObject({ applied: true, cannotFollow: ['its publisher tags: compiler_settings.json is not JSON'] });
  });

  it('writes no line and follows nothing when the folder did not move', async () => {
    const renamer = over({ refusals: refusing('renameModFolder', 'The folder is in the way') });

    expect(await rename(renamer)).toEqual({ applied: false, failed: 'The folder is in the way', edited: false });
    expect(verbs(renamer.fake.calls)).toEqual(['renameModFolder']);
  });

  it('moves the source folder named for it through mEdit, and follows the move in the instance repository', async () => {
    const renamer = over({}, { sourceModFolders: repositoriesOf({ 'Harder VATS': '/instance/source/Harder VATS' }) });

    await rename(renamer);

    expect(renamer.applied.flat()).toContainEqual({ moves: SOURCE_MOVES, deletions: [], documents: [] });
    expect(renamer.client.calls.filter(({ method }) => method === 'followSourceFolderMove').map(({ args }) => args)).toEqual([['/instance/source/Harder VATS', '/source/Harder VATS 2']]);
    expect(renamer.fake.calls.find(({ verb }) => verb === 'followFoldersInRepository')).toMatchObject({ moves: [expect.anything(), { from: '/instance/source/Harder VATS', to: '/source/Harder VATS 2' }] });
  });

  it('leaves where it is a source folder that builds it and is named otherwise, as one renamed outside Modbench is', async () => {
    const mods = await mkdtemp(join(tmpdir(), 'renameEntry-'));
    try {
      await mkdir(join(mods, 'Harder VATS'));
      await writeFile(join(mods, 'Harder VATS', 'Harder VATS.manifest.json'), '{"version":1,"packages":[{"kind":"repository","name":"Other"}]}');
      const renamer = over({}, { modFolders: modFoldersIn(mods, ...ORDER), sourceModFolders: repositoriesOf({ Other: '/instance/source/Other' }) });

      await rename(renamer);

      expect(renamer.client.calls.filter(({ method }) => method === 'getSourceFolderMoveChanges')).toEqual([]);
    } finally {
      await rm(mods, { recursive: true, force: true });
    }
  });

  it('refuses the rename, writing nothing, when mEdit refuses the source folder\'s move', async () => {
    const renamer = over({}, { sourceModFolders: repositoriesOf({ 'Harder VATS': '/instance/source/Harder VATS' }) });
    renamer.client.setCommandResult('getSourceFolderMoveChanges', { refused: true, message: "'/source/Harder VATS 2' is taken." });

    expect(await rename(renamer)).toEqual({ applied: false, refusal: "'/source/Harder VATS 2' is taken." });
    expect([renamer.fake.calls, renamer.applied]).toEqual([[], []]);
  });

  it.each([
    ['a blank name', '  ', 'A mod name cannot be empty.'],
    ['a name another mod has', 'ENBoost', 'A mod with this name already exists'],
    ['a name with a path separator', 'a/b', 'A name cannot be . or .. or contain / or \\'],
  ])('refuses %s, writing nothing', async (_case, to, refusal) => {
    const renamer = over();

    expect(await rename(renamer, to)).toEqual({ applied: false, refusal });
    expect(renamer.fake.calls).toEqual([]);
  });

  it.each([['profiles'], ['modOrder']] as const)('refuses, renaming nothing, when %s cannot be read', async (read) => {
    const renamer = over({ unreadReads: { [read]: 'the read failed' } });

    expect(await rename(renamer)).toEqual({ applied: false, refusal: 'the read failed' });
    expect(renamer.fake.calls).toEqual([]);
  });

  it('takes its own name in another case, as no other mod has it', async () => {
    expect(await rename(over(), 'harder vats')).toMatchObject({ applied: true });
  });
});

describe('rename separator: its line in each profile, its folder, and each reference to it', () => {
  it('renames the line and the folder in the active profile, then the line in each other profile that lists it', async () => {
    const renamer = over({}, { profiles: ['Secondary', 'Default'] });

    expect(await renamer.commands.renameSeparator(renamer.editing, 'Core', 'Renamed')).toEqual({ applied: true, cannotFollow: [], name: 'Renamed' });
    expect(renamer.fake.calls.filter(({ verb }) => verb === 'changeModOrder')).toEqual([
      { verb: 'changeModOrder', profile: 'Default', changes: [{ kind: 'renameSeparator', from: 'Core', to: 'Renamed' }] },
      { verb: 'changeModOrder', profile: 'Secondary', changes: [] },
    ]);
  });

  it('refuses a name another separator has, writing nothing', async () => {
    const renamer = over();

    expect(await renamer.commands.renameSeparator(renamer.editing, 'Core', 'other')).toEqual({ applied: false, refusal: 'A separator with this name already exists' });
    expect(renamer.fake.calls).toEqual([]);
  });

  it('says its line was not renamed when the active profile\'s write failed', async () => {
    const renamer = over({ refusals: refusing('changeModOrder', 'ENOENT: no such file') });

    expect(await renamer.commands.renameSeparator(renamer.editing, 'Core', 'Renamed')).toEqual({ applied: false, failed: 'ENOENT: no such file', edited: false });
  });
});
