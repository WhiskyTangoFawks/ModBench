import { describe, it, expect } from 'vitest';
import { unreadStatus } from '../../test/unreadStatus';
import { modSyncOver, modCommands, type ModCommands } from '../modCommands';
import { fileInFolder } from '../../instanceAdapter/instanceAdapter';
import type {
  EntryRef, InstanceAdapter, InstanceReading, ModlistEntry, ModOrderChange, MovePlace, OriginFileMark, SeparatorsPlace,
} from '../../instanceAdapter/instanceAdapter';
import { fakeInstanceAdapter, fileIn, sourceModsOf, modFoldersOf, refusing, readingFixture, type AdapterCall, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';

const mod = (name: string, enabled = true): ModlistEntry => ({ kind: 'mod', name, enabled });
const separator = (name: string, enabled = false): ModlistEntry => ({ kind: 'separator', name, enabled });

const UNASSIGNED = 'Unassigned (Modlist Development)';
const RADFALL = 'Radfall - All-In-One Survival Overhaul';
const FIXTURE_ORDER = [
  mod('SKK Fast Start'), separator(UNASSIGNED), mod('[NODELETE] Radfall'), mod('Unofficial Patch'),
  separator(RADFALL), mod('ENBoost'), mod('Harder VATS', false), mod('Cracked Screen'),
];
const sourceMods = (folders: ReadonlyMap<string, string>): Pick<InstanceReading, 'sourceMods'> =>
  ({ sourceMods: sourceModsOf(Object.fromEntries(folders)) });
const NO_TRASH = () => Promise.resolve();

function over(
  order: readonly ModlistEntry[] = FIXTURE_ORDER, answers: InstanceAnswers = {}, mEdit = new InMemoryMEditClient(), reading: Partial<InstanceReading> = {},
) {
  const fake = fakeInstanceAdapter(readingFixture({ mods: order, modFolders: modFoldersOf(...order), ...reading }), answers);
  return { fake, mEdit, commands: modCommands(fake.adapter, mEdit, unreadStatus) };
}

const orderWrite = (changes: readonly ModOrderChange[], profile = 'Default'): AdapterCall => ({ verb: 'changeModOrder', profile, changes });
const verbs = (calls: readonly AdapterCall[]) => calls.map((call) => call.verb);

describe('the mod commands refuse the whole selection once when the adapter refuses the write', () => {
  const place: MovePlace = { kind: 'ungrouped' };
  const separatorsPlace: SeparatorsPlace = { kind: 'modOrder' };

  it.each([
    ['setModsEnabled', (c: ReturnType<typeof over>['commands']) => c.setModsEnabled(['Harder VATS', 'ENBoost'], true)],
    ['moveMods', (c: ReturnType<typeof over>['commands']) => c.moveMods(['Harder VATS', 'ENBoost'], place, 'losing')],
    ['moveSeparators', (c: ReturnType<typeof over>['commands']) => c.moveSeparators([UNASSIGNED, RADFALL], separatorsPlace, 'losing')],
    ['insertSeparator', (c: ReturnType<typeof over>['commands']) => c.insertSeparator('New Section', { kind: 'mod', name: 'ENBoost' })],
    ['renameSeparator', (c: ReturnType<typeof over>['commands']) => c.renameSeparator(UNASSIGNED, 'Renamed')],
  ])('%s', async (_, run) => {
    const { fake, commands } = over(FIXTURE_ORDER, { refusals: refusing('changeModOrder', 'ENOENT: no such file') });

    expect(await run(commands)).toEqual({ applied: false, refusal: 'ENOENT: no such file' });
    expect(verbs(fake.calls)).toEqual(['changeModOrder']);
  });
});

describe('setModsEnabled', () => {
  it.each([true, false])('hands one change to set each mod enabled=%s, in one write', async (enabled) => {
    const { fake, commands } = over();

    const outcome = await commands.setModsEnabled(['Harder VATS', 'ENBoost'], enabled);

    expect(outcome).toEqual({ applied: true, outcome: { landed: ['Harder VATS', 'ENBoost'], refused: [] } });
    expect(fake.calls).toEqual([orderWrite([
      { kind: 'enable', mod: 'Harder VATS', enabled }, { kind: 'enable', mod: 'ENBoost', enabled },
    ])]);
  });

  it('refuses a gone mod by name while the rest land, in one write', async () => {
    const { fake, commands } = over();

    const outcome = await commands.setModsEnabled(['Harder VATS', 'No Such Mod'], true);

    expect(outcome).toEqual({
      applied: true,
      outcome: { landed: ['Harder VATS'], refused: [{ item: 'No Such Mod', reason: 'Mod not found in modlist: No Such Mod' }] },
    });
    expect(fake.calls).toEqual([orderWrite([{ kind: 'enable', mod: 'Harder VATS', enabled: true }])]);
  });

  it('lands a mod named as the mod manager matches names, whatever the case', async () => {
    const { fake, commands } = over();

    const outcome = await commands.setModsEnabled(['harder vats'], true);

    expect(outcome).toEqual({ applied: true, outcome: { landed: ['harder vats'], refused: [] } });
    expect(fake.calls).toEqual([orderWrite([{ kind: 'enable', mod: 'harder vats', enabled: true }])]);
  });

  it('names an entry of the kind it is handed, when a separator shares the name of a mod', async () => {
    const { fake, commands } = over([separator('Gear'), mod('Armor')]);

    const outcome = await commands.setModsEnabled(['Gear'], true);

    expect(outcome).toEqual({
      applied: true, outcome: { landed: [], refused: [{ item: 'Gear', reason: 'Mod not found in modlist: Gear' }] },
    });
    expect(fake.calls).toEqual([orderWrite([])]);
  });
});

describe('moveMods and moveSeparators', () => {
  it('a mod move hands the selection that is listed, with the place and end chosen, refusing a gone mod by name, in one write', async () => {
    const { fake, commands } = over();
    const place: MovePlace = { kind: 'separator', name: UNASSIGNED };

    const outcome = await commands.moveMods(['No Such Mod', 'Harder VATS'], place, 'losing');

    expect(outcome).toEqual({
      applied: true,
      outcome: { landed: ['Harder VATS'], refused: [{ item: 'No Such Mod', reason: 'Mod not found in modlist: No Such Mod' }] },
    });
    expect(fake.calls).toEqual([orderWrite([{ kind: 'moveMods', mods: ['Harder VATS'], place, end: 'losing' }])]);
  });

  it('a separator move hands the selection that is listed, with the place and end chosen, refusing a gone separator by name', async () => {
    const { fake, commands } = over();
    const place: SeparatorsPlace = { kind: 'separator', name: RADFALL };

    const outcome = await commands.moveSeparators(['Gone Separator', UNASSIGNED], place, 'winning');

    expect(outcome).toEqual({
      applied: true,
      outcome: { landed: [UNASSIGNED], refused: [{ item: 'Gone Separator', reason: 'Separator not found in modlist: Gone Separator' }] },
    });
    expect(fake.calls).toEqual([orderWrite([{ kind: 'moveSeparators', separators: [UNASSIGNED], place, end: 'winning' }])]);
  });

  it.each(['ENBoost', 'enboost'])('refuses once a mod move whose target %s is one of the moving mods, and writes nothing', async (target) => {
    const { fake, commands } = over();

    const outcome = await commands.moveMods(['ENBoost', 'Harder VATS'], { kind: 'mod', name: target }, 'losing');

    expect(outcome).toEqual({ applied: false, refusal: `The target is "${target}", which is moving.` });
    expect(fake.calls).toEqual([]);
  });

  it.each([RADFALL, RADFALL.toLowerCase()])('refuses once a separator move whose target %s is one of the moving separators, and writes nothing', async (target) => {
    const { fake, commands } = over();

    const outcome = await commands.moveSeparators([UNASSIGNED, RADFALL], { kind: 'separator', name: target }, 'losing');

    expect(outcome).toEqual({ applied: false, refusal: `The target is "${target}", which is moving.` });
    expect(fake.calls).toEqual([]);
  });

  it.each<MovePlace>([{ kind: 'mod', name: 'ENBoost' }, { kind: 'ungrouped' }])(
    'refuses once a separator move to the place %j, which no separator can take, and writes nothing', async (place) => {
      const { fake, commands } = over();

      const outcome = await commands.moveSeparators([UNASSIGNED], place, 'winning');

      expect(outcome).toEqual({
        applied: false,
        refusal: 'A separator lands beside another separator or at an end of mod order, never beside a mod or among the ungrouped mods.',
      });
      expect(fake.calls).toEqual([]);
    });
});

describe('insertSeparator', () => {
  it('hands the adapter one change, beside the anchor it was given', async () => {
    const { fake, commands } = over();
    const anchor = { kind: 'separator', name: RADFALL } as const;

    const outcome = await commands.insertSeparator('New Section', anchor);

    expect(outcome).toEqual({ applied: true, wrote: true, name: 'New Section' });
    expect(fake.calls).toEqual([orderWrite([{ kind: 'addSeparator', separator: 'New Section', anchor }])]);
  });
});

describe('renameSeparator', () => {
  it('hands the adapter one change, which renames the line and its folder', async () => {
    const { fake, commands } = over();

    const outcome = await commands.renameSeparator(UNASSIGNED, 'Renamed');

    expect(outcome).toEqual({ applied: true, wrote: true, name: 'Renamed' });
    expect(fake.calls).toEqual([orderWrite([{ kind: 'renameSeparator', from: UNASSIGNED, to: 'Renamed' }])]);
  });
});

describe('deleteSeparators', () => {
  it('trashes each folder before its line, and writes every selected line in one write', async () => {
    const { fake, commands } = over();

    const outcome = await commands.deleteSeparators([UNASSIGNED, RADFALL], NO_TRASH);

    expect(outcome).toEqual({ applied: true, outcome: { landed: [{ name: UNASSIGNED }, { name: RADFALL }], refused: [] } });
    expect(fake.calls).toEqual([
      { verb: 'trashEntryFolder', entry: { kind: 'separator', name: UNASSIGNED } },
      { verb: 'trashEntryFolder', entry: { kind: 'separator', name: RADFALL } },
      orderWrite([{ kind: 'dropSeparator', separator: UNASSIGNED }, { kind: 'dropSeparator', separator: RADFALL }]),
    ]);
  });

  it('refuses a gone separator by name while the others land, trashing nothing for it', async () => {
    const { fake, commands } = over();

    const outcome = await commands.deleteSeparators(['No Such Separator', UNASSIGNED], NO_TRASH);

    expect(outcome).toEqual({
      applied: true,
      outcome: {
        landed: [{ name: UNASSIGNED }],
        refused: [{ item: { name: 'No Such Separator' }, reason: 'Separator not found in modlist: No Such Separator' }],
      },
    });
    expect(fake.calls).toEqual([
      { verb: 'trashEntryFolder', entry: { kind: 'separator', name: UNASSIGNED } },
      orderWrite([{ kind: 'dropSeparator', separator: UNASSIGNED }]),
    ]);
  });

  it('writes no line for a separator whose folder the trash refuses, refusing it with the reason, while the others land', async () => {
    const { fake, commands } = over(FIXTURE_ORDER, {
      refusals: (call) => (call.verb === 'trashEntryFolder' && call.entry.name === UNASSIGNED ? 'trash unavailable' : undefined),
    });

    const outcome = await commands.deleteSeparators([UNASSIGNED, RADFALL], NO_TRASH);

    expect(outcome).toEqual({
      applied: true,
      outcome: { landed: [{ name: RADFALL }], refused: [{ item: { name: UNASSIGNED }, reason: 'trash unavailable' }] },
    });
    expect(fake.calls.at(-1)).toEqual(orderWrite([{ kind: 'dropSeparator', separator: RADFALL }]));
  });

  it('a separator whose line cannot go after its folder was trashed still lands, carrying the part that failed, and one with no folder to trash is refused with the write\'s reason', async () => {
    const { commands } = over(FIXTURE_ORDER, { refusals: refusing('changeModOrder', 'disk full') }, undefined, { modFolders: modFoldersOf(...FIXTURE_ORDER.filter((entry) => entry.name !== RADFALL)) });

    const outcome = await commands.deleteSeparators([UNASSIGNED, RADFALL], NO_TRASH);

    expect(outcome).toEqual({
      applied: true,
      outcome: {
        landed: [{ name: UNASSIGNED, lineRefusal: 'disk full' }],
        refused: [{ item: { name: RADFALL }, reason: 'disk full' }],
      },
    });
  });
});

describe('uninstallMods', () => {
  const INSTALLATION_FILE = 'Unofficial Patch-4598-2-1-5.7z';
  const installedFrom = (...pairs: readonly (readonly [string, string])[]): InstanceAnswers =>
    ({ metadata: new Map(pairs.map(([mod, name]) => [mod, { installationFile: { name } }])) });

  it('trashes the folder, then the source folder, then removes the line, then marks the downloaded file uninstalled, in that order', async () => {
    const { fake, commands } = over(FIXTURE_ORDER, installedFrom(['Unofficial Patch', INSTALLATION_FILE]));

    const outcome = await commands.uninstallMods(['Unofficial Patch'], NO_TRASH);

    expect(outcome).toEqual({ applied: true, outcome: { landed: [{ name: 'Unofficial Patch' }], refused: [] } });
    expect(fake.calls).toEqual([
      { verb: 'trashEntryFolder', entry: { kind: 'mod', name: 'Unofficial Patch' } },
      { verb: 'trashSourceFolder', mod: 'Unofficial Patch' },
      orderWrite([{ kind: 'dropMod', mod: 'Unofficial Patch' }]),
      { verb: 'markDownloadedFile', name: INSTALLATION_FILE, mark: 'Uninstalled' },
    ]);
  });

  it('removes every selected mod\'s line in one write, and marks no downloaded file for a mod whose meta names none', async () => {
    const { fake, commands } = over();

    const outcome = await commands.uninstallMods(['Harder VATS', 'ENBoost'], NO_TRASH);

    expect(outcome).toEqual({ applied: true, outcome: { landed: [{ name: 'Harder VATS' }, { name: 'ENBoost' }], refused: [] } });
    expect(fake.calls.filter((call) => call.verb === 'changeModOrder')).toEqual([
      orderWrite([{ kind: 'dropMod', mod: 'Harder VATS' }, { kind: 'dropMod', mod: 'ENBoost' }]),
    ]);
    expect(verbs(fake.calls)).not.toContain('markDownloadedFile');
  });

  it('lands the mod carrying the source\'s failure when the source folder cannot be trashed', async () => {
    const { fake, commands } = over(FIXTURE_ORDER, { refusals: refusing('trashSourceFolder', 'the trash refused it') });

    const outcome = await commands.uninstallMods(['Harder VATS'], NO_TRASH);

    expect(outcome).toEqual({
      applied: true, outcome: { landed: [{ name: 'Harder VATS', sourceRefusal: 'the trash refused it' }], refused: [] },
    });
    expect(verbs(fake.calls)).toContain('changeModOrder');
  });

  it('refuses an unknown mod by name, trashing and marking nothing for it, while the rest land', async () => {
    const { fake, commands } = over(FIXTURE_ORDER, installedFrom(['No Such Mod', 'Gone-1.7z']));

    const outcome = await commands.uninstallMods(['No Such Mod', 'Harder VATS'], NO_TRASH);

    expect(outcome).toEqual({
      applied: true,
      outcome: { landed: [{ name: 'Harder VATS' }], refused: [{ item: { name: 'No Such Mod' }, reason: 'Mod not found in modlist: No Such Mod' }] },
    });
    expect(fake.calls.filter((call) => call.verb === 'trashEntryFolder')).toEqual([
      { verb: 'trashEntryFolder', entry: { kind: 'mod', name: 'Harder VATS' } },
    ]);
    expect(verbs(fake.calls)).not.toContain('markDownloadedFile');
  });

  it('writes nothing for a mod whose folder the trash refuses, refusing it with the reason, while the others land and mark, leaving the refused mod\'s downloaded file unmarked', async () => {
    const { fake, commands } = over(FIXTURE_ORDER, {
      ...installedFrom(['Harder VATS', 'Harder VATS-1-0.7z'], ['Unofficial Patch', INSTALLATION_FILE]),
      refusals: (call) => (call.verb === 'trashEntryFolder' && call.entry.name === 'Harder VATS' ? 'trash unavailable' : undefined),
    });

    const outcome = await commands.uninstallMods(['Harder VATS', 'Unofficial Patch'], NO_TRASH);

    expect(outcome).toEqual({
      applied: true,
      outcome: {
        landed: [{ name: 'Unofficial Patch' }],
        refused: [{ item: { name: 'Harder VATS' }, reason: 'trash unavailable' }],
      },
    });
    expect(fake.calls.filter((call) => call.verb === 'changeModOrder')).toEqual([orderWrite([{ kind: 'dropMod', mod: 'Unofficial Patch' }])]);
    expect(fake.calls.filter((call) => call.verb === 'markDownloadedFile')).toEqual([
      { verb: 'markDownloadedFile', name: INSTALLATION_FILE, mark: 'Uninstalled' },
    ]);
  });

  it('a mod whose line cannot go after its folder was trashed still lands, carrying the part that failed, and marks nothing for it', async () => {
    const { fake, commands } = over(FIXTURE_ORDER, { ...installedFrom(['Unofficial Patch', INSTALLATION_FILE]), refusals: refusing('changeModOrder', 'disk full') });

    const outcome = await commands.uninstallMods(['Unofficial Patch'], NO_TRASH);

    expect(outcome).toEqual({
      applied: true, outcome: { landed: [{ name: 'Unofficial Patch', lineRefusal: 'disk full' }], refused: [] },
    });
    expect(verbs(fake.calls)).not.toContain('markDownloadedFile');
  });

  it('carries the mark\'s refusal beside the landed mod, rather than leaving the downloaded file claiming a mod that is gone', async () => {
    const { commands } = over(FIXTURE_ORDER, { ...installedFrom(['Unofficial Patch', INSTALLATION_FILE]), refusals: refusing('markDownloadedFile', 'download_directory could not be resolved') });

    const outcome = await commands.uninstallMods(['Unofficial Patch'], NO_TRASH);

    expect(outcome).toEqual({
      applied: true,
      outcome: { landed: [{ name: 'Unofficial Patch', markRefusal: 'download_directory could not be resolved' }], refused: [] },
    });
  });

  it('lands the mod whose downloaded file is gone from disk, with no refusal', async () => {
    const { commands } = over(FIXTURE_ORDER, installedFrom(['Harder VATS', 'Long Gone-1-0.7z']));

    const outcome = await commands.uninstallMods(['Harder VATS'], NO_TRASH);

    expect(outcome).toEqual({ applied: true, outcome: { landed: [{ name: 'Harder VATS' }], refused: [] } });
  });

  it('reads the installation file before the folder that records it goes', async () => {
    const { fake, commands } = over(FIXTURE_ORDER, installedFrom(['Unofficial Patch', INSTALLATION_FILE]));
    const writesBeforeRead: number[] = [];
    const read = fake.adapter.modMetadata.bind(fake.adapter);
    fake.adapter.modMetadata = (mod) => { writesBeforeRead.push(fake.calls.length); return read(mod); };

    await commands.uninstallMods(['Unofficial Patch'], NO_TRASH);

    expect(writesBeforeRead).toEqual([0]);
    expect(verbs(fake.calls)[0]).toBe('trashEntryFolder');
  });

  it('lands the mod carrying why its installation file could not be read, marking no downloaded file', async () => {
    const { fake, commands } = over(FIXTURE_ORDER, { unreadableMetadata: new Map([['Unofficial Patch', 'meta.ini is locked']]) });

    const outcome = await commands.uninstallMods(['Unofficial Patch'], NO_TRASH);

    expect(outcome).toEqual({ applied: true, outcome: { landed: [{ name: 'Unofficial Patch', markRefusal: 'meta.ini is locked' }], refused: [] } });
    expect(verbs(fake.calls)).not.toContain('markDownloadedFile');
  });

  it('refuses the selection, trashing nothing, when mod order cannot be read', async () => {
    const { fake, commands } = over(FIXTURE_ORDER, { unreadReads: { modOrder: 'modlist.txt is locked' } });

    expect(await commands.uninstallMods(['Harder VATS'], NO_TRASH)).toEqual({ applied: false, refusal: 'modlist.txt is locked' });
    expect(fake.calls).toEqual([]);
  });
});

describe('renameMod', () => {
  const rename = (commands: ReturnType<typeof over>['commands']) => commands.renameMod('Harder VATS', 'Harder VATS 2');
  const profiles = { profiles: ['Secondary', 'Default'] };
  const SOURCE = '/instance/source/Harder VATS';
  const sourced = { ...profiles, ...sourceMods(new Map([['Harder VATS', SOURCE]])) };
  const line = { kind: 'renameMod', from: 'Harder VATS', to: 'Harder VATS 2' } as const;

  it('renames the folder, then the line in each profile, the active one first', async () => {
    const { fake, commands } = over(FIXTURE_ORDER, {}, undefined, profiles);

    const outcome = await rename(commands);

    expect(outcome).toEqual({ applied: true, lineRefusals: [] });
    expect(fake.calls).toEqual([
      { verb: 'renameModFolder', from: 'Harder VATS', to: 'Harder VATS 2' },
      { verb: 'keepOutOfPublisher' },
      orderWrite([line], 'Default'),
      orderWrite([line], 'Secondary'),
    ]);
  });

  it('names each profile whose line could not be written, the folder staying renamed', async () => {
    const { fake, commands } = over(FIXTURE_ORDER, {
      refusals: (call) => (call.verb === 'changeModOrder' && call.profile === 'Secondary' ? 'disk full' : undefined),
    }, undefined, profiles);

    const outcome = await rename(commands);

    expect(outcome).toEqual({ applied: true, lineRefusals: [{ profile: 'Secondary', refusal: 'disk full' }] });
    expect(verbs(fake.calls)).toEqual(['renameModFolder', 'keepOutOfPublisher', 'changeModOrder', 'changeModOrder']);
  });

  it('writes nothing for the name it already has, saying nothing changed', async () => {
    const { fake, commands } = over();

    const outcome = await commands.renameMod('Harder VATS', 'Harder VATS');

    expect(outcome).toEqual({ applied: true, lineRefusals: [], unchanged: true });
    expect(fake.calls).toEqual([]);
  });

  it('refuses a blank name, writing nothing', async () => {
    const { fake, commands } = over();

    const outcome = await commands.renameMod('Harder VATS', '  ');

    expect(outcome).toEqual({ applied: false, refusal: 'A mod name cannot be empty.' });
    expect(fake.calls).toEqual([]);
  });

  it.each([['profiles'], ['sourceMods'], ['modOrder']] as const)('refuses, renaming nothing, when %s cannot be read', async (read) => {
    const { fake, commands } = over(FIXTURE_ORDER, { unreadReads: { [read]: 'the read failed' } });

    expect(await rename(commands)).toEqual({ applied: false, refusal: 'the read failed' });
    expect(fake.calls).toEqual([]);
  });

  it('writes no line when the folder did not move', async () => {
    const { fake, commands } = over(FIXTURE_ORDER, { refusals: refusing('renameModFolder', 'The folder is in the way') });

    const outcome = await rename(commands);

    expect(outcome).toEqual({ applied: false, refusal: 'The folder is in the way' });
    expect(verbs(fake.calls)).toEqual(['renameModFolder']);
  });

  describe('a source mod: the manifest written with the folder', () => {
    it('renames the folder and the output its manifest names, then the lines', async () => {
      const { fake, mEdit, commands } = over(FIXTURE_ORDER, {}, undefined, sourced);
      mEdit.setCommandResult('changeSourceManifest', { changed: true });

      const outcome = await rename(commands);

      expect(outcome).toEqual({ applied: true, lineRefusals: [] });
      expect(configuredBy(mEdit)).toEqual([[SOURCE, { output: 'Harder VATS 2' }]]);
      expect(verbs(fake.calls)).toEqual(['renameModFolder', 'keepOutOfPublisher', 'changeModOrder', 'changeModOrder']);
    });

    it('puts the folder back and writes no line when mEdit refuses the manifest', async () => {
      const { fake, mEdit, commands } = over(FIXTURE_ORDER, {}, undefined, sourced);
      mEdit.setCommandResult('changeSourceManifest', { refused: true, message: 'it holds no manifest' });

      const outcome = await rename(commands);

      expect(outcome).toEqual({ applied: false, refusal: 'it holds no manifest' });
      expect(fake.calls).toEqual([
        { verb: 'renameModFolder', from: 'Harder VATS', to: 'Harder VATS 2' },
        { verb: 'renameModFolder', from: 'Harder VATS 2', to: 'Harder VATS' },
      ]);
    });

    it('names both failures when the folder cannot be put back after mEdit refuses the manifest', async () => {
      const mEdit = new InMemoryMEditClient();
      mEdit.setCommandResult('changeSourceManifest', { refused: true, message: 'it holds no manifest' });
      const { commands } = over(FIXTURE_ORDER, {
        refusals: (call) => (call.verb === 'renameModFolder' && call.from === 'Harder VATS 2' ? 'the folder is in use' : undefined),
      }, mEdit, sourced);

      const outcome = await rename(commands);

      expect(outcome).toEqual({
        applied: false,
        refusal: 'it holds no manifest The folder could not be renamed back to "Harder VATS": the folder is in use',
      });
    });
  });
});

const configuredBy = (mEdit: InMemoryMEditClient) =>
  mEdit.calls.filter((call) => call.method === 'changeSourceManifest').map((call) => call.args);

describe('markFiles', () => {
  const MARK = fakeInstanceAdapter().adapter.exclusionMark;
  const SOURCE = '/instance/source/Harder VATS';
  const OTHER = '/instance/source/ENBoost';
  const MOD_FILES = new Map(['Harder VATS', 'ENBoost'].map((name) => [name, {
    origin: name, folder: `/mods/${name}`, folders: [], notes: [],
    files: ['a.dds', 'b.dds', 'c.dds', 'bad.dds', 'Textures/a.dds', `Textures/b.dds${MARK}`].map((path) => fileIn(`/mods/${name}`, path)),
  }]));
  const SOURCES = { ...sourceMods(new Map([['Harder VATS', SOURCE]])), modFiles: MOD_FILES };
  const TWO_SOURCES = { ...sourceMods(new Map([['Harder VATS', SOURCE], ['ENBoost', OTHER]])), modFiles: MOD_FILES };
  const fileOf = (name: string, relativePath: string) => ({ origin: { kind: 'mod', name }, relativePath }) as const;
  const markOf = (file: ReturnType<typeof fileOf>, mark: OriginFileMark): AdapterCall =>
    ({ verb: 'markOriginFile', origin: file.origin, relativePath: file.relativePath, mark });
  const UNREACHABLE = { refused: true, message: 'Could not change the manifest — mEdit could not be reached.', unreachable: true } as const;

  it.each([
    ['Excluded', 'Textures/a.dds', { exclude: ['Textures/a.dds'] }],
    ['Included', `Textures/b.dds${MARK}`, { include: ['Textures/b.dds'] }],
  ] as const)('marks a file %s, and the manifest\'s exclusion with it', async (mark, relativePath, change) => {
    const { fake, mEdit, commands } = over(FIXTURE_ORDER, {}, undefined, SOURCES);
    mEdit.setCommandResult('changeSourceManifest', { changed: true });
    const file = fileOf('Harder VATS', relativePath);

    const outcome = await commands.markFiles([file], mark);

    expect(outcome).toEqual({ applied: true, outcome: { landed: [file], refused: [] } });
    expect(configuredBy(mEdit)).toEqual([[SOURCE, change]]);
    expect(fake.calls).toEqual([markOf(file, mark)]);
  });

  it('asks mEdit once for every file of a source mod, before any file is marked, and marks none when it refuses', async () => {
    const { fake, mEdit, commands } = over(FIXTURE_ORDER, {}, undefined, SOURCES);
    let markedWhenAsked = -1;
    mEdit.setCommandHandler('changeSourceManifest', () => {
      markedWhenAsked = fake.calls.length;
      return Promise.resolve({ refused: true, message: 'it holds no manifest' });
    });
    const files = [fileOf('Harder VATS', 'a.dds'), fileOf('Harder VATS', 'b.dds')];

    const outcome = await commands.markFiles(files, 'Excluded');

    expect(configuredBy(mEdit)).toEqual([[SOURCE, { exclude: ['a.dds', 'b.dds'] }]]);
    expect(markedWhenAsked).toBe(0);
    expect(outcome).toEqual({ applied: true, outcome: { landed: [], refused: files.map((item) => ({ item, reason: 'it holds no manifest' })) } });
    expect(fake.calls).toEqual([]);
  });

  it('marks the file of a mod with no source though mEdit refuses a source mod\'s', async () => {
    const { fake, mEdit, commands } = over(FIXTURE_ORDER, {}, undefined, SOURCES);
    mEdit.setCommandResult('changeSourceManifest', { refused: true, message: 'it holds no manifest' });
    const inSource = fileOf('Harder VATS', 'a.dds');
    const inNoSource = fileOf('ENBoost', 'b.dds');

    const outcome = await commands.markFiles([inSource, inNoSource], 'Excluded');

    expect(outcome).toEqual({ applied: true, outcome: { landed: [inNoSource], refused: [{ item: inSource, reason: 'it holds no manifest' }] } });
    expect(fake.calls).toEqual([markOf(inNoSource, 'Excluded')]);
  });

  it('refuses the whole selection, configuring and marking nothing, when the source mods cannot be read', async () => {
    const { fake, mEdit, commands } = over(FIXTURE_ORDER, { unreadReads: { sourceMods: 'Harder VATS.manifest.json is locked' } }, undefined, SOURCES);

    expect(await commands.markFiles([fileOf('Harder VATS', 'a.dds')], 'Excluded')).toEqual({ applied: false, refusal: 'Harder VATS.manifest.json is locked' });
    expect(configuredBy(mEdit)).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it('refuses the whole selection once, marking no file, when mEdit cannot be reached', async () => {
    const { fake, mEdit, commands } = over(FIXTURE_ORDER, {}, undefined, SOURCES);
    mEdit.setCommandResult('changeSourceManifest', UNREACHABLE);
    const files = [fileOf('Harder VATS', 'a.dds'), fileOf('Harder VATS', 'b.dds'), fileOf('ENBoost', 'c.dds')];

    const outcome = await commands.markFiles(files, 'Excluded');

    expect(outcome).toEqual({ applied: false, refusal: UNREACHABLE.message });
    expect(fake.calls).toEqual([]);
  });

  it('puts back a source mod\'s configuration already changed when mEdit cannot be reached for the next, naming what could not be put back', async () => {
    const { fake, mEdit, commands } = over(FIXTURE_ORDER, {}, undefined, TWO_SOURCES);
    mEdit.setCommandHandler('changeSourceManifest', () => Promise.resolve(configuredBy(mEdit).length === 1 ? { changed: true } : UNREACHABLE));
    const files = [fileOf('Harder VATS', 'a.dds'), fileOf('ENBoost', 'c.dds')];

    const outcome = await commands.markFiles(files, 'Excluded');

    expect(configuredBy(mEdit)).toEqual([[SOURCE, { exclude: ['a.dds'] }], [OTHER, { exclude: ['c.dds'] }], [SOURCE, { include: ['a.dds'] }]]);
    expect(outcome).toEqual({
      applied: false,
      refusal: `${UNREACHABLE.message} The manifest in "${SOURCE}" could not be put back: ${UNREACHABLE.message}`,
    });
    expect(fake.calls).toEqual([]);
  });

  it('names why a configuration already changed could not be put back', async () => {
    const { mEdit, commands } = over(FIXTURE_ORDER, {}, undefined, TWO_SOURCES);
    mEdit.setCommandHandler('changeSourceManifest', (folder, change) => Promise.resolve(
      change.include !== undefined ? { refused: true, message: 'the disk refused the write' } : folder === SOURCE ? { changed: true } : UNREACHABLE));
    const files = [fileOf('Harder VATS', 'a.dds'), fileOf('ENBoost', 'c.dds')];

    const outcome = await commands.markFiles(files, 'Excluded');

    expect(outcome).toEqual({
      applied: false,
      refusal: `${UNREACHABLE.message} The manifest in "${SOURCE}" could not be put back: the disk refused the write`,
    });
  });

  it('leaves a file gone from disk out of the configuration, and lands the rest', async () => {
    const { mEdit, commands } = over(FIXTURE_ORDER, {}, undefined, SOURCES);
    mEdit.setCommandResult('changeSourceManifest', { changed: true });
    const marked = fileOf('Harder VATS', 'a.dds');
    const gone = fileOf('Harder VATS', 'gone.dds');

    const outcome = await commands.markFiles([marked, gone], 'Excluded');

    expect(outcome).toEqual({ applied: true, outcome: { landed: [marked], refused: [{ item: gone, reason: '"gone.dds" is gone from disk.' }] } });
    expect(configuredBy(mEdit)).toEqual([[SOURCE, { exclude: ['a.dds'] }]]);
  });

  it('takes back the exclusion of a file the adapter refuses, with the adapter\'s reason', async () => {
    const { mEdit, commands } = over(FIXTURE_ORDER, { refusals: refusing('markOriginFile', 'permission denied') }, undefined, SOURCES);
    mEdit.setCommandResult('changeSourceManifest', { changed: true });
    const file = fileOf('Harder VATS', 'a.dds');

    const outcome = await commands.markFiles([file], 'Excluded');

    expect(outcome).toEqual({ applied: true, outcome: { landed: [], refused: [{ item: file, reason: 'permission denied' }] } });
    expect(configuredBy(mEdit)).toEqual([[SOURCE, { exclude: ['a.dds'] }], [SOURCE, { include: ['a.dds'] }]]);
  });

  it('refuses a file the adapter cannot read, leaving it out of the configuration, and lands the rest', async () => {
    const { mEdit, commands } = over(FIXTURE_ORDER, { unreadOriginFile: (file) => (file.relativePath === 'bad.dds' ? 'permission denied' : undefined) }, undefined, SOURCES);
    mEdit.setCommandResult('changeSourceManifest', { changed: true });
    const unread = fileOf('Harder VATS', 'bad.dds');
    const marked = fileOf('Harder VATS', 'a.dds');

    const outcome = await commands.markFiles([unread, marked], 'Excluded');

    expect(outcome).toEqual({ applied: true, outcome: { landed: [marked], refused: [{ item: unread, reason: 'permission denied' }] } });
    expect(configuredBy(mEdit)).toEqual([[SOURCE, { exclude: ['a.dds'] }]]);
  });

  it('names both failures when the exclusion of a file that could not be marked cannot be taken back', async () => {
    const { mEdit, commands } = over(FIXTURE_ORDER, { refusals: refusing('markOriginFile', 'permission denied') }, undefined, SOURCES);
    mEdit.setCommandHandler('changeSourceManifest', (_, change) =>
      Promise.resolve(change.exclude === undefined ? { refused: true, message: 'the disk refused the write' } : { changed: true }));
    const refusedFile = fileOf('Harder VATS', 'a.dds');

    const outcome = await commands.markFiles([refusedFile], 'Excluded');

    expect(outcome).toEqual({ applied: true, outcome: { landed: [], refused: [
      { item: refusedFile, reason: 'permission denied Its change to the manifest could not be taken back: the disk refused the write' },
    ] } });
  });
});

describe('changePublisherTag (publishing.md, Publisher tags, story 2)', () => {
  const INCLUDE = { name: 'Include', badge: 'IN', marksPaths: true };
  const ALWAYS_ENABLED = { name: 'Always Enabled', badge: 'AE', marksPaths: false };
  const publisherOver = (answers: InstanceAnswers = {}) => over(FIXTURE_ORDER, { publisherTags: [INCLUDE, ALWAYS_ENABLED], ...answers });
  const modRow = (name: string) => ({ origin: { kind: 'mod', name } }) as const;
  const pathRow = (name: string, relativePath: string) => ({ origin: { kind: 'mod', name }, relativePath }) as const;
  const changeCall = (change: 'add' | 'remove', tag: string, paths: string[]): AdapterCall => ({ verb: 'changePublisherTag', change, tag, paths });

  it('changes the tag on the folder of each mod and the path of each file or folder in one, in one call', async () => {
    const { fake, commands } = publisherOver();
    const rows = [modRow('ENBoost'), pathRow('Harder VATS', 'Textures/a.dds')];

    const result = await commands.changePublisherTag('add', 'Include', rows);

    expect(result).toEqual({ applied: true, outcome: { landed: rows, refused: [] } });
    expect(fake.calls).toEqual([changeCall('add', 'Include', ['/mods/ENBoost', fileInFolder('/mods/Harder VATS', 'Textures/a.dds')])]);
  });

  it('refuses a row the publisher refuses, by its row, and lands the rest', async () => {
    const { commands } = publisherOver({ outsideInstance: new Set(['/mods/ENBoost']) });
    const refusedRow = modRow('ENBoost');
    const landedRow = modRow('Harder VATS');

    const result = await commands.changePublisherTag('remove', 'Include', [refusedRow, landedRow]);

    expect(result).toEqual({ applied: true, outcome: { landed: [landedRow], refused: [{ item: refusedRow, reason: 'It is outside the instance.' }] } });
  });

  it('refuses a file or folder for a tag that marks only mods, and an Overwrite row, calling for the rest', async () => {
    const { fake, commands } = publisherOver();
    const file = pathRow('ENBoost', 'a.dds');
    const overwritten = { origin: { kind: 'runtimeOutput' }, relativePath: 'o.log' } as const;

    const result = await commands.changePublisherTag('add', 'Always Enabled', [file, modRow('ENBoost')]);
    const inOverwrite = await commands.changePublisherTag('add', 'Include', [overwritten]);

    expect(result).toEqual({ applied: true, outcome: { landed: [modRow('ENBoost')], refused: [{ item: file, reason: 'Always Enabled marks mods only.' }] } });
    expect(inOverwrite).toEqual({ applied: true, outcome: { landed: [], refused: [{ item: overwritten, reason: 'Overwrite is not a mod.' }] } });
    expect(fake.calls).toEqual([changeCall('add', 'Always Enabled', ['/mods/ENBoost'])]);
  });

  it('refuses the whole selection, naming it, for a tag the publisher does not declare, and when the publisher rejects', async () => {
    const { fake, commands } = publisherOver({ refusals: refusing('changePublisherTag', 'compiler_settings.json is not JSON') });

    expect(await commands.changePublisherTag('add', 'Nope', [modRow('ENBoost')])).toEqual({ applied: false, refusal: 'The publisher declares no publisher tag "Nope". It declares Include, Always Enabled.' });
    expect(await commands.changePublisherTag('add', 'Include', [modRow('ENBoost')])).toEqual({ applied: false, refusal: 'compiler_settings.json is not JSON' });
    expect(verbs(fake.calls)).toEqual(['changePublisherTag']);
  });
});

describe('createEmptyMod', () => {
  it('makes the folder, then adds a line at the winning end', async () => {
    const { fake, commands } = over();

    const outcome = await commands.createEmptyMod('My New Mod');

    expect(outcome).toEqual({ applied: true, wrote: true });
    expect(fake.calls).toEqual([
      { verb: 'createModFolder', mod: 'My New Mod' },
      orderWrite([{ kind: 'addAtWinningEnd', entry: { kind: 'mod', name: 'My New Mod' } }]),
    ]);
  });

  it('refuses a blank name, writing nothing', async () => {
    const { fake, commands } = over();

    const outcome = await commands.createEmptyMod('  ');

    expect(outcome).toEqual({ applied: false, refusal: 'A mod name cannot be empty.' });
    expect(fake.calls).toEqual([]);
  });

  it('writes no line when the folder cannot be made, refusing with why', async () => {
    const { fake, commands } = over(FIXTURE_ORDER, { refusals: refusing('createModFolder', 'The folder is in the way') });

    const outcome = await commands.createEmptyMod('Harder VATS');

    expect(outcome).toEqual({ applied: false, refusal: 'The folder is in the way' });
    expect(verbs(fake.calls)).toEqual(['createModFolder']);
  });

  it('a failed line write answers a partial, not a refusal, since the folder is on disk either way', async () => {
    const { commands } = over(FIXTURE_ORDER, { refusals: refusing('changeModOrder', 'disk full') });

    const outcome = await commands.createEmptyMod('Line Write Fails');

    expect(outcome).toEqual({ applied: true, wrote: false, lineRefusal: 'disk full' });
  });
});

describe('syncMods', () => {
  const syncing = (order: readonly ModlistEntry[], onDisk: readonly EntryRef[], answers: InstanceAnswers = {}, profile = 'Default') =>
    ({ fake: fakeInstanceAdapter(readingFixture({ profile, mods: order, modFolders: modFoldersOf(...onDisk) }), answers) });
  const sync = ({ fake }: ReturnType<typeof syncing>) => modSyncOver(fake.adapter)();
  const folder = (name: string): EntryRef => ({ kind: 'mod', name });
  const sepFolder = (name: string): EntryRef => ({ kind: 'separator', name });

  it('adds a line for a folder with none and drops each line whose folder is gone, in one write', async () => {
    const run = syncing([mod('Kept'), mod('Gone Mod'), separator('Gone Sep')], [folder('Kept'), folder('Hand Extracted Mod')]);

    const outcome = await sync(run);

    expect(outcome).toEqual({ applied: true, added: ['Hand Extracted Mod'], dropped: ['Gone Mod', 'Gone Sep (separator)'] });
    expect(run.fake.calls).toEqual([orderWrite([
      { kind: 'dropMod', mod: 'Gone Mod' }, { kind: 'dropSeparator', separator: 'Gone Sep' },
      { kind: 'addAtWinningEnd', entry: { kind: 'mod', name: 'Hand Extracted Mod' } },
    ])]);
  });

  it('keeps the line of a gone folder that a manifest builds, as the mod manager matches names', async () => {
    const fake = fakeInstanceAdapter(readingFixture({
      mods: [mod('Unbuilt'), mod('Cloned Source'), mod('Gone Mod')], modFolders: modFoldersOf(),
      sourceMods: sourceModsOf({ 'Cloned Source': '/instance/source/Cloned Source' }, [], ['UNBUILT']),
    }));
    const run = { fake };

    const outcome = await sync(run);

    expect(outcome).toEqual({ applied: true, added: [], dropped: ['Gone Mod'] });
    expect(run.fake.calls).toEqual([orderWrite([{ kind: 'dropMod', mod: 'Gone Mod' }])]);
  });

  it('writes the profile the mod manager selects', async () => {
    const run = syncing([mod('Gone Mod')], [], {}, 'Other');

    await sync(run);

    expect(run.fake.calls).toEqual([orderWrite([{ kind: 'dropMod', mod: 'Gone Mod' }], 'Other')]);
  });

  it('hands no change when every folder has a line and every mod line has a folder', async () => {
    const run = syncing([mod('A'), separator('B')], [folder('A'), sepFolder('B')]);

    expect(await sync(run)).toEqual({ applied: true, added: [], dropped: [] });
    expect(run.fake.calls).toEqual([orderWrite([])]);
  });

  it('adds a batch ascending by name, each at the winning end, so the batch reads in order from the winning end, a separator folder as a separator', async () => {
    const run = syncing([], [folder('Zeta Mod'), folder('Alpha Mod'), sepFolder('Orphan')]);

    const outcome = await sync(run);

    expect(outcome).toEqual({ applied: true, added: ['Alpha Mod', 'Orphan (separator)', 'Zeta Mod'], dropped: [] });
    expect(run.fake.calls).toEqual([orderWrite([
      { kind: 'addAtWinningEnd', entry: { kind: 'mod', name: 'Zeta Mod' } },
      { kind: 'addAtWinningEnd', entry: { kind: 'separator', name: 'Orphan' } },
      { kind: 'addAtWinningEnd', entry: { kind: 'mod', name: 'Alpha Mod' } },
    ])]);
  });

  it('refuses, writing nothing, when there is no folder for mods at all, rather than dropping every line', async () => {
    const fake = fakeInstanceAdapter(readingFixture({ mods: [mod('A')], modFolders: undefined }));

    const outcome = await modSyncOver(fake.adapter)();

    expect(outcome).toEqual({ applied: false, refusal: 'there is no folder for mods' });
    expect(fake.calls).toEqual([]);
  });

  it('refuses with the adapter\'s reason when the write is refused', async () => {
    const run = syncing([mod('Gone Mod')], [], { refusals: refusing('changeModOrder', 'ENOENT: no such file') });

    expect(await sync(run)).toEqual({ applied: false, refusal: 'ENOENT: no such file' });
  });
});

describe('the names a separator or mod may take', () => {
  it('keys a name as the adapter keys it', async () => {
    const { commands } = over([separator('Unassigned (Modlist Development)')]);

    expect(await commands.separatorNameRefusal('UNASSIGNED (modlist development)', 'Group B')).toBe('A separator with this name already exists');
  });

  it('rejects with why mod order cannot be read, rather than calling the name free', async () => {
    const { commands } = over([], { unreadReads: { modOrder: 'modlist.txt is locked' } });

    await expect(commands.newModNameRefusal('Anything')).rejects.toThrow('modlist.txt is locked');
    await expect(commands.separatorNameRefusal('Anything')).rejects.toThrow('modlist.txt is locked');
  });

  it('refuses a name a mod folder holds, listed or not', async () => {
    const { commands } = over([], {}, undefined, { modFolders: modFoldersOf('Unlisted Mod') });

    expect(await commands.newModNameRefusal('unlisted mod'))
      .toBe('A mod named "unlisted mod" already exists. Install its next release from Downloads, or uninstall it to install anew.');
    expect(await commands.renameModNameRefusal('UNLISTED MOD', 'Mod B')).toBe('A mod with this name already exists');
  });

  it('refuses a mod name that holds a path separator', async () => {
    const { commands } = over([]);

    expect(await commands.renameModNameRefusal('a/b', 'Mod B')).toBe('A mod name cannot contain / or \\');
    expect(await commands.renameModNameRefusal('a\\b', 'Mod B')).toBe('A mod name cannot contain / or \\');
  });
});

describe('a name the mod order already holds', () => {
  it.each<[string, (c: ModCommands) => Promise<unknown>, string]>([
    ['add separator, writing nothing', (c) => c.insertSeparator(RADFALL, { kind: 'mod', name: 'ENBoost' }), 'A separator with this name already exists'],
    ['rename separator, writing nothing', (c) => c.renameSeparator(UNASSIGNED, RADFALL), 'A separator with this name already exists'],
    ['rename mod, renaming no folder', (c) => c.renameMod('Harder VATS', 'ENBoost'), 'A mod with this name already exists'],
  ])('is refused by %s', async (_case, run, refusal) => {
    const { fake, commands } = over();

    expect(await run(commands)).toEqual({ applied: false, refusal });
    expect(verbs(fake.calls)).toEqual([]);
  });

  it('is no clash for the entry being renamed, in another case', async () => {
    const { commands } = over();

    expect(await commands.renameSeparator(UNASSIGNED, UNASSIGNED.toUpperCase())).toMatchObject({ applied: true });
    expect(await commands.renameMod('Harder VATS', 'harder vats')).toMatchObject({ applied: true });
  });
});

describe('publisher tags follow a mod (publishing.md, Publisher tags, story 3)', () => {
  const INCLUDE = { name: 'Include', badge: 'IN', marksPaths: true };
  const publisherOver = (answers: InstanceAnswers = {}, mEdit = new InMemoryMEditClient(), reading: Partial<InstanceReading> = {}) =>
    over(FIXTURE_ORDER, { publisherTags: [INCLUDE], ...answers }, mEdit, reading);
  const follow = (...moves: Parameters<InstanceAdapter['followModFolders']>[0]): AdapterCall => ({ verb: 'followModFolders', moves });
  const unreadable = { unreadablePublisher: 'compiler_settings.json is not JSON' };

  it('rename moves them to the new folder once the folder has moved', async () => {
    const { fake, commands } = publisherOver();

    await commands.renameMod('Harder VATS', 'Harder VATS 2');

    expect(fake.calls).toEqual([
      { verb: 'renameModFolder', from: 'Harder VATS', to: 'Harder VATS 2' },
      follow({ from: '/mods/Harder VATS', to: '/mods/Harder VATS 2' }),
      { verb: 'keepOutOfPublisher' },
      expect.objectContaining({ verb: 'changeModOrder' }),
    ]);
  });

  it('rename moves none when the folder does not move', async () => {
    const { fake, commands } = publisherOver({ refusals: refusing('renameModFolder', 'The folder is in the way') });

    await commands.renameMod('Harder VATS', 'Harder VATS 2');

    expect(verbs(fake.calls)).toEqual(['renameModFolder']);
  });

  it('rename moves none when mEdit refuses the manifest', async () => {
    const mEdit = new InMemoryMEditClient();
    mEdit.setCommandResult('changeSourceManifest', { refused: true, message: 'it holds no manifest' });
    const { fake, commands } = publisherOver({}, mEdit, sourceMods(new Map([['Harder VATS', '/instance/source/Harder VATS']])));

    await commands.renameMod('Harder VATS', 'Harder VATS 2');

    expect(verbs(fake.calls)).toEqual(['renameModFolder', 'renameModFolder']);
  });

  it('rename refuses, writing nothing, when the configuration cannot be read', async () => {
    const { fake, commands } = publisherOver(unreadable);

    const outcome = await commands.renameMod('Harder VATS', 'Harder VATS 2');

    expect(outcome).toEqual({ applied: false, refusal: 'compiler_settings.json is not JSON' });
    expect(fake.calls).toEqual([]);
  });

  it('rename lands with the failure when the tags cannot follow after the folder moved', async () => {
    const { commands } = publisherOver({ refusals: refusing('followModFolders', 'compiler_settings.json is not JSON') });

    const outcome = await commands.renameMod('Harder VATS', 'Harder VATS 2');

    expect(outcome).toEqual({ applied: true, lineRefusals: [], tagRefusal: 'compiler_settings.json is not JSON' });
  });

  it('rename lands with its own failure when the tags followed and Modbench\'s files could not be kept out', async () => {
    const { commands } = publisherOver({ refusals: refusing('keepOutOfPublisher', 'compiler_settings.json is not JSON') });

    const outcome = await commands.renameMod('Harder VATS', 'Harder VATS 2');

    expect(outcome).toEqual({ applied: true, lineRefusals: [], keepOutRefusal: 'compiler_settings.json is not JSON' });
  });

  it('uninstall removes them for every mod it trashed, in one write after the trash', async () => {
    const { fake, commands } = publisherOver();

    await commands.uninstallMods(['Harder VATS', 'ENBoost', 'No Such Mod'], NO_TRASH);

    expect(fake.calls.filter((call) => call.verb === 'followModFolders')).toEqual([follow({ from: '/mods/Harder VATS' }, { from: '/mods/ENBoost' })]);
    expect(verbs(fake.calls).indexOf('followModFolders')).toBeGreaterThan(verbs(fake.calls).lastIndexOf('trashEntryFolder'));
  });

  it('uninstall refuses the whole selection, trashing and unlisting nothing, when the configuration cannot be read', async () => {
    const { fake, commands } = publisherOver(unreadable);

    const outcome = await commands.uninstallMods(['Harder VATS', 'ENBoost'], NO_TRASH);

    expect(outcome).toEqual({ applied: false, refusal: 'compiler_settings.json is not JSON' });
    expect(fake.calls).toEqual([]);
  });

  it('uninstall lands the mod carrying the failure when the write fails after the trash', async () => {
    const { commands } = publisherOver({ refusals: refusing('followModFolders', 'compiler_settings.json is not JSON') });

    const outcome = await commands.uninstallMods(['Harder VATS'], NO_TRASH);

    expect(outcome).toEqual({ applied: true, outcome: { landed: [{ name: 'Harder VATS', tagRefusal: 'compiler_settings.json is not JSON' }], refused: [] } });
  });

  it('uninstall removes none for a mod whose folder the trash refuses', async () => {
    const { fake, commands } = publisherOver({ refusals: refusing('trashEntryFolder', 'trash unavailable') });

    await commands.uninstallMods(['Harder VATS'], NO_TRASH);

    expect(verbs(fake.calls)).not.toContain('followModFolders');
  });
});
