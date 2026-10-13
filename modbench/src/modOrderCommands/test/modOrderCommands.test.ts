import { describe, it, expect } from 'vitest';
import { modSyncOver, modlistCommands } from '../modOrderCommands';
import type {
  EntryRef, ModlistEntry, ModOrderChange, MovePlace, OriginFileMark, SeparatorsPlace,
} from '../../instanceAdapter/instanceAdapter';
import { fakeInstanceAdapter, modFoldersOf, refusing, readingFixture, type AdapterCall, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';

const mod = (name: string, enabled = true): ModlistEntry => ({ kind: 'mod', name, enabled });
const separator = (name: string, enabled = false): ModlistEntry => ({ kind: 'separator', name, enabled });

const UNASSIGNED = 'Unassigned (Modlist Development)';
const RADFALL = 'Radfall - All-In-One Survival Overhaul';
const FIXTURE_ORDER = [
  mod('SKK Fast Start'), separator(UNASSIGNED), mod('[NODELETE] Radfall'), mod('Unofficial Patch'),
  separator(RADFALL), mod('ENBoost'), mod('Harder VATS', false), mod('Cracked Screen'),
];
const NO_TRASH = () => Promise.resolve();

function over(order: readonly ModlistEntry[] = FIXTURE_ORDER, answers: InstanceAnswers = {}, mEdit = new InMemoryMEditClient()) {
  const fake = fakeInstanceAdapter(readingFixture({ mods: order }), answers);
  return { fake, mEdit, commands: modlistCommands(fake.adapter, mEdit) };
}

const orderWrite = (changes: readonly ModOrderChange[], profile = 'Default'): AdapterCall => ({ verb: 'changeModOrder', profile, changes });
const verbs = (calls: readonly AdapterCall[]) => calls.map((call) => call.verb);

describe('the modlist commands refuse the whole selection once when the adapter refuses the write', () => {
  const place: MovePlace = { kind: 'ungrouped' };
  const separatorsPlace: SeparatorsPlace = { kind: 'modOrder' };

  it.each([
    ['setModsEnabled', (c: ReturnType<typeof over>['commands']) => c.setModsEnabled('Default', ['Harder VATS', 'ENBoost'], true)],
    ['moveMods', (c: ReturnType<typeof over>['commands']) => c.moveMods('Default', ['Harder VATS', 'ENBoost'], place, 'losing')],
    ['moveSeparators', (c: ReturnType<typeof over>['commands']) => c.moveSeparators('Default', [UNASSIGNED, RADFALL], separatorsPlace, 'losing')],
    ['insertSeparator', (c: ReturnType<typeof over>['commands']) => c.insertSeparator('Default', 'New Section', { kind: 'mod', name: 'ENBoost' })],
    ['renameSeparator', (c: ReturnType<typeof over>['commands']) => c.renameSeparator('Default', UNASSIGNED, 'Renamed')],
  ])('%s', async (_, run) => {
    const { fake, commands } = over(FIXTURE_ORDER, { refusals: refusing('changeModOrder', 'ENOENT: no such file') });

    expect(await run(commands)).toEqual({ applied: false, refusal: 'ENOENT: no such file' });
    expect(verbs(fake.calls)).toEqual(['changeModOrder']);
  });
});

describe('setModsEnabled', () => {
  it.each([true, false])('hands one change to set each mod enabled=%s, in one write', async (enabled) => {
    const { fake, commands } = over();

    const outcome = await commands.setModsEnabled('Default', ['Harder VATS', 'ENBoost'], enabled);

    expect(outcome).toEqual({ applied: true, outcome: { landed: ['Harder VATS', 'ENBoost'], refused: [] } });
    expect(fake.calls).toEqual([orderWrite([
      { kind: 'enable', mod: 'Harder VATS', enabled }, { kind: 'enable', mod: 'ENBoost', enabled },
    ])]);
  });

  it('refuses a gone mod by name while the rest land, in one write', async () => {
    const { fake, commands } = over();

    const outcome = await commands.setModsEnabled('Default', ['Harder VATS', 'No Such Mod'], true);

    expect(outcome).toEqual({
      applied: true,
      outcome: { landed: ['Harder VATS'], refused: [{ item: 'No Such Mod', reason: 'Mod not found in modlist: No Such Mod' }] },
    });
    expect(fake.calls).toEqual([orderWrite([{ kind: 'enable', mod: 'Harder VATS', enabled: true }])]);
  });

  it('names an entry of the kind it is handed, when a separator shares the name of a mod', async () => {
    const { fake, commands } = over([separator('Gear'), mod('Armor')]);

    const outcome = await commands.setModsEnabled('Default', ['Gear'], true);

    expect(outcome).toEqual({
      applied: true, outcome: { landed: [], refused: [{ item: 'Gear', reason: 'Mod not found in modlist: Gear' }] },
    });
    expect(fake.calls).toEqual([orderWrite([])]);
  });
});

describe('moveMods and moveSeparators', () => {
  it('moveMods hands the selection that is listed, with the place and end chosen, refusing a gone mod by name, in one write', async () => {
    const { fake, commands } = over();
    const place: MovePlace = { kind: 'separator', name: UNASSIGNED };

    const outcome = await commands.moveMods('Default', ['No Such Mod', 'Harder VATS'], place, 'losing');

    expect(outcome).toEqual({
      applied: true,
      outcome: { landed: ['Harder VATS'], refused: [{ item: 'No Such Mod', reason: 'Mod not found in modlist: No Such Mod' }] },
    });
    expect(fake.calls).toEqual([orderWrite([{ kind: 'moveMods', mods: ['Harder VATS'], place, end: 'losing' }])]);
  });

  it('moveSeparators hands the selection that is listed, with the place and end chosen, refusing a gone separator by name', async () => {
    const { fake, commands } = over();
    const place: SeparatorsPlace = { kind: 'separator', name: RADFALL };

    const outcome = await commands.moveSeparators('Default', ['Gone Separator', UNASSIGNED], place, 'winning');

    expect(outcome).toEqual({
      applied: true,
      outcome: { landed: [UNASSIGNED], refused: [{ item: 'Gone Separator', reason: 'Separator not found in modlist: Gone Separator' }] },
    });
    expect(fake.calls).toEqual([orderWrite([{ kind: 'moveSeparators', separators: [UNASSIGNED], place, end: 'winning' }])]);
  });
});

describe('insertSeparator', () => {
  it.each([
    ['a mod inside a separator: directly after the mod', { kind: 'mod', name: '[NODELETE] Radfall' }, 2],
    ['an ungrouped mod: directly after the mod', { kind: 'mod', name: 'Harder VATS' }, 6],
    ['a separator: before the winning-most mod of its own group, taking none', { kind: 'separator', name: RADFALL }, 1],
    ['the winning-most separator: before every mod', { kind: 'separator', name: UNASSIGNED }, -1],
  ] as const)('anchored on %s', async (_, anchor, afterIndex) => {
    const { fake, commands } = over();

    const outcome = await commands.insertSeparator('Default', 'New Section', anchor);

    expect(outcome).toEqual({ applied: true, wrote: true });
    expect(fake.calls).toEqual([orderWrite([{ kind: 'addSeparator', separator: 'New Section', afterIndex }])]);
  });

  it('anchored on a separator with no mods of its own, adds an equally empty one before it', async () => {
    const { fake, commands } = over([separator('FirstGroup'), separator('SecondGroup'), mod('SKK Fast Start')]);

    await commands.insertSeparator('Default', 'New Section', { kind: 'separator', name: 'SecondGroup' });

    expect(fake.calls).toEqual([orderWrite([{ kind: 'addSeparator', separator: 'New Section', afterIndex: 0 }])]);
  });

  it('anchors on the entry of the kind it is handed, when a mod and a separator share its name', async () => {
    const { fake, commands } = over([mod('Armor'), separator('Gear'), mod('Gear')]);

    await commands.insertSeparator('Default', 'New Section', { kind: 'mod', name: 'Gear' });

    expect(fake.calls).toEqual([orderWrite([{ kind: 'addSeparator', separator: 'New Section', afterIndex: 2 }])]);
  });

  it('refuses when the anchor entry is absent, writing nothing', async () => {
    const { fake, commands } = over();

    const outcome = await commands.insertSeparator('Default', 'New Section', { kind: 'mod', name: 'No Such Entry' });

    expect(outcome).toEqual({ applied: false, refusal: 'Entry not found in modlist: No Such Entry' });
    expect(fake.calls).toEqual([]);
  });
});

describe('renameSeparator', () => {
  it('hands the adapter one change, which renames the line and its folder', async () => {
    const { fake, commands } = over();

    const outcome = await commands.renameSeparator('Default', UNASSIGNED, 'Renamed');

    expect(outcome).toEqual({ applied: true, wrote: true });
    expect(fake.calls).toEqual([orderWrite([{ kind: 'renameSeparator', from: UNASSIGNED, to: 'Renamed' }])]);
  });
});

describe('deleteSeparators', () => {
  it('trashes each folder before its line, and writes every selected line in one write', async () => {
    const { fake, commands } = over();

    const outcome = await commands.deleteSeparators('Default', FIXTURE_ORDER, [UNASSIGNED, RADFALL], NO_TRASH);

    expect(outcome).toEqual({ applied: true, outcome: { landed: [{ name: UNASSIGNED }, { name: RADFALL }], refused: [] } });
    expect(fake.calls).toEqual([
      { verb: 'trashEntryFolder', entry: { kind: 'separator', name: UNASSIGNED } },
      { verb: 'trashEntryFolder', entry: { kind: 'separator', name: RADFALL } },
      orderWrite([{ kind: 'dropSeparator', separator: UNASSIGNED }, { kind: 'dropSeparator', separator: RADFALL }]),
    ]);
  });

  it('refuses a gone separator by name while the others land, trashing nothing for it', async () => {
    const { fake, commands } = over();

    const outcome = await commands.deleteSeparators('Default', FIXTURE_ORDER, ['No Such Separator', UNASSIGNED], NO_TRASH);

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

    const outcome = await commands.deleteSeparators('Default', FIXTURE_ORDER, [UNASSIGNED, RADFALL], NO_TRASH);

    expect(outcome).toEqual({
      applied: true,
      outcome: { landed: [{ name: RADFALL }], refused: [{ item: { name: UNASSIGNED }, reason: 'trash unavailable' }] },
    });
    expect(fake.calls.at(-1)).toEqual(orderWrite([{ kind: 'dropSeparator', separator: RADFALL }]));
  });

  it('a separator whose line cannot go after its folder was trashed still lands, carrying the part that failed, and one with no folder to trash is refused with the write\'s reason', async () => {
    const { commands } = over(FIXTURE_ORDER, { refusals: refusing('changeModOrder', 'disk full'), foldersAbsent: new Set([RADFALL]) });

    const outcome = await commands.deleteSeparators('Default', FIXTURE_ORDER, [UNASSIGNED, RADFALL], NO_TRASH);

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
  const ARCHIVE = 'Unofficial Patch-4598-2-1-5.7z';

  it('trashes the folder, then the source folder, then removes the line, then marks the download uninstalled, in that order', async () => {
    const { fake, commands } = over();

    const outcome = await commands.uninstallMods('Default', FIXTURE_ORDER, [{ name: 'Unofficial Patch', archiveFilename: ARCHIVE }], NO_TRASH);

    expect(outcome).toEqual({ applied: true, outcome: { landed: [{ name: 'Unofficial Patch' }], refused: [] } });
    expect(fake.calls).toEqual([
      { verb: 'trashEntryFolder', entry: { kind: 'mod', name: 'Unofficial Patch' } },
      { verb: 'trashSourceFolder', mod: 'Unofficial Patch' },
      orderWrite([{ kind: 'dropMod', mod: 'Unofficial Patch' }]),
      { verb: 'markDownloadedFile', name: ARCHIVE, mark: 'Uninstalled' },
    ]);
  });

  it('removes every selected mod\'s line in one write, and marks no download for a mod handed none', async () => {
    const { fake, commands } = over();

    const outcome = await commands.uninstallMods('Default', FIXTURE_ORDER, [{ name: 'Harder VATS' }, { name: 'ENBoost' }], NO_TRASH);

    expect(outcome).toEqual({ applied: true, outcome: { landed: [{ name: 'Harder VATS' }, { name: 'ENBoost' }], refused: [] } });
    expect(fake.calls.filter((call) => call.verb === 'changeModOrder')).toEqual([
      orderWrite([{ kind: 'dropMod', mod: 'Harder VATS' }, { kind: 'dropMod', mod: 'ENBoost' }]),
    ]);
    expect(verbs(fake.calls)).not.toContain('markDownloadedFile');
  });

  it('lands the mod carrying the source\'s failure when the source folder cannot be trashed', async () => {
    const { fake, commands } = over(FIXTURE_ORDER, { refusals: refusing('trashSourceFolder', 'the trash refused it') });

    const outcome = await commands.uninstallMods('Default', FIXTURE_ORDER, [{ name: 'Harder VATS' }], NO_TRASH);

    expect(outcome).toEqual({
      applied: true, outcome: { landed: [{ name: 'Harder VATS', sourceRefusal: 'the trash refused it' }], refused: [] },
    });
    expect(verbs(fake.calls)).toContain('changeModOrder');
  });

  it('refuses an unknown mod by name, trashing and marking nothing for it, while the rest land', async () => {
    const { fake, commands } = over();

    const outcome = await commands.uninstallMods('Default', FIXTURE_ORDER, [{ name: 'No Such Mod', archiveFilename: 'Gone-1.7z' }, { name: 'Harder VATS' }], NO_TRASH);

    expect(outcome).toEqual({
      applied: true,
      outcome: { landed: [{ name: 'Harder VATS' }], refused: [{ item: { name: 'No Such Mod' }, reason: 'Mod not found in modlist: No Such Mod' }] },
    });
    expect(fake.calls.filter((call) => call.verb === 'trashEntryFolder')).toEqual([
      { verb: 'trashEntryFolder', entry: { kind: 'mod', name: 'Harder VATS' } },
    ]);
    expect(verbs(fake.calls)).not.toContain('markDownloadedFile');
  });

  it('writes nothing for a mod whose folder the trash refuses, refusing it with the reason, while the others land and mark, leaving the refused mod\'s download unmarked', async () => {
    const { fake, commands } = over(FIXTURE_ORDER, {
      refusals: (call) => (call.verb === 'trashEntryFolder' && call.entry.name === 'Harder VATS' ? 'trash unavailable' : undefined),
    });

    const outcome = await commands.uninstallMods('Default', FIXTURE_ORDER,
      [{ name: 'Harder VATS', archiveFilename: 'Harder VATS-1-0.7z' }, { name: 'Unofficial Patch', archiveFilename: ARCHIVE }], NO_TRASH);

    expect(outcome).toEqual({
      applied: true,
      outcome: {
        landed: [{ name: 'Unofficial Patch' }],
        refused: [{ item: { name: 'Harder VATS' }, reason: 'trash unavailable' }],
      },
    });
    expect(fake.calls.filter((call) => call.verb === 'changeModOrder')).toEqual([orderWrite([{ kind: 'dropMod', mod: 'Unofficial Patch' }])]);
    expect(fake.calls.filter((call) => call.verb === 'markDownloadedFile')).toEqual([
      { verb: 'markDownloadedFile', name: ARCHIVE, mark: 'Uninstalled' },
    ]);
  });

  it('a mod whose line cannot go after its folder was trashed still lands, carrying the part that failed, and marks nothing for it', async () => {
    const { fake, commands } = over(FIXTURE_ORDER, { refusals: refusing('changeModOrder', 'disk full') });

    const outcome = await commands.uninstallMods('Default', FIXTURE_ORDER, [{ name: 'Unofficial Patch', archiveFilename: ARCHIVE }], NO_TRASH);

    expect(outcome).toEqual({
      applied: true, outcome: { landed: [{ name: 'Unofficial Patch', lineRefusal: 'disk full' }], refused: [] },
    });
    expect(verbs(fake.calls)).not.toContain('markDownloadedFile');
  });

  it('carries the mark\'s refusal beside the landed mod, rather than leaving the download claiming a mod that is gone', async () => {
    const { commands } = over(FIXTURE_ORDER, { refusals: refusing('markDownloadedFile', 'download_directory could not be resolved') });

    const outcome = await commands.uninstallMods('Default', FIXTURE_ORDER, [{ name: 'Unofficial Patch', archiveFilename: ARCHIVE }], NO_TRASH);

    expect(outcome).toEqual({
      applied: true,
      outcome: { landed: [{ name: 'Unofficial Patch', markRefusal: 'download_directory could not be resolved' }], refused: [] },
    });
  });

  it('lands the mod whose download is gone from disk, with no refusal', async () => {
    const { commands } = over(FIXTURE_ORDER, { goneDownloads: new Set(['Long Gone-1-0.7z']) });

    const outcome = await commands.uninstallMods('Default', FIXTURE_ORDER, [{ name: 'Harder VATS', archiveFilename: 'Long Gone-1-0.7z' }], NO_TRASH);

    expect(outcome).toEqual({ applied: true, outcome: { landed: [{ name: 'Harder VATS' }], refused: [] } });
  });
});

describe('renameMod', () => {
  const rename = (commands: ReturnType<typeof over>['commands'], sourceFolder?: string) =>
    commands.renameMod('Default', ['Secondary', 'Default'], 'Harder VATS', 'Harder VATS 2', sourceFolder);
  const line = { kind: 'renameMod', from: 'Harder VATS', to: 'Harder VATS 2' } as const;

  it('renames the folder, then the line in each profile, the active one first', async () => {
    const { fake, commands } = over();

    const outcome = await rename(commands);

    expect(outcome).toEqual({ applied: true, lineRefusals: [] });
    expect(fake.calls).toEqual([
      { verb: 'renameModFolder', from: 'Harder VATS', to: 'Harder VATS 2' },
      orderWrite([line], 'Default'),
      orderWrite([line], 'Secondary'),
    ]);
  });

  it('names each profile whose line could not be written, the folder staying renamed', async () => {
    const { fake, commands } = over(FIXTURE_ORDER, {
      refusals: (call) => (call.verb === 'changeModOrder' && call.profile === 'Secondary' ? 'disk full' : undefined),
    });

    const outcome = await rename(commands);

    expect(outcome).toEqual({ applied: true, lineRefusals: [{ profile: 'Secondary', refusal: 'disk full' }] });
    expect(verbs(fake.calls)).toEqual(['renameModFolder', 'changeModOrder', 'changeModOrder']);
  });

  it('writes no line when the folder did not move', async () => {
    const { fake, commands } = over(FIXTURE_ORDER, { refusals: refusing('renameModFolder', 'The folder is in the way') });

    const outcome = await rename(commands);

    expect(outcome).toEqual({ applied: false, refusal: 'The folder is in the way' });
    expect(verbs(fake.calls)).toEqual(['renameModFolder']);
  });

  describe('a source mod: the build configuration written with the folder', () => {
    const SOURCE = '/instance/source/Harder VATS';

    it('renames the folder and the output its build configuration names, then the lines', async () => {
      const { fake, mEdit, commands } = over();
      mEdit.setCommandResult('changeBuildConfiguration', { changed: true });

      const outcome = await rename(commands, SOURCE);

      expect(outcome).toEqual({ applied: true, lineRefusals: [] });
      expect(configuredBy(mEdit)).toEqual([[SOURCE, { output: 'Harder VATS 2' }]]);
      expect(verbs(fake.calls)).toEqual(['renameModFolder', 'changeModOrder', 'changeModOrder']);
    });

    it('puts the folder back and writes no line when mEdit refuses the build configuration', async () => {
      const { fake, mEdit, commands } = over();
      mEdit.setCommandResult('changeBuildConfiguration', { refused: true, message: 'it holds no build configuration' });

      const outcome = await rename(commands, SOURCE);

      expect(outcome).toEqual({ applied: false, refusal: 'it holds no build configuration' });
      expect(fake.calls).toEqual([
        { verb: 'renameModFolder', from: 'Harder VATS', to: 'Harder VATS 2' },
        { verb: 'renameModFolder', from: 'Harder VATS 2', to: 'Harder VATS' },
      ]);
    });

    it('names both failures when the folder cannot be put back after mEdit refuses the build configuration', async () => {
      const mEdit = new InMemoryMEditClient();
      mEdit.setCommandResult('changeBuildConfiguration', { refused: true, message: 'it holds no build configuration' });
      const { commands } = over(FIXTURE_ORDER, {
        refusals: (call) => (call.verb === 'renameModFolder' && call.from === 'Harder VATS 2' ? 'the folder is in use' : undefined),
      }, mEdit);

      const outcome = await rename(commands, SOURCE);

      expect(outcome).toEqual({
        applied: false,
        refusal: 'it holds no build configuration The folder could not be renamed back to "Harder VATS": the folder is in use',
      });
    });
  });
});

const configuredBy = (mEdit: InMemoryMEditClient) =>
  mEdit.calls.filter((call) => call.method === 'changeBuildConfiguration').map((call) => call.args);

describe('markFiles', () => {
  const SOURCE = '/instance/source/Harder VATS';
  const SOURCES = new Map([['Harder VATS', SOURCE]]);
  const fileOf = (name: string, relativePath: string) => ({ origin: { kind: 'mod', name }, relativePath }) as const;
  const markOf = (file: ReturnType<typeof fileOf>, mark: OriginFileMark): AdapterCall =>
    ({ verb: 'markOriginFile', origin: file.origin, relativePath: file.relativePath, mark });
  const UNREACHABLE = { refused: true, message: 'Could not change the build configuration — mEdit could not be reached.', unreachable: true } as const;

  it.each([
    ['Excluded', 'Textures/a.dds', { exclude: ['Textures/a.dds'] }],
    ['Included', 'Textures/a.dds.excluded', { include: ['Textures/a.dds'] }],
  ] as const)('marks a file %s, and the build configuration\'s exclusion with it', async (mark, relativePath, change) => {
    const { fake, mEdit, commands } = over();
    mEdit.setCommandResult('changeBuildConfiguration', { changed: true });
    const file = fileOf('Harder VATS', relativePath);

    const outcome = await commands.markFiles([file], mark, SOURCES);

    expect(outcome).toEqual({ applied: true, outcome: { landed: [file], refused: [] } });
    expect(configuredBy(mEdit)).toEqual([[SOURCE, change]]);
    expect(fake.calls).toEqual([markOf(file, mark)]);
  });

  it('asks mEdit once for every file of a source mod, before any file is marked, and marks none when it refuses', async () => {
    const { fake, mEdit, commands } = over();
    let markedWhenAsked = -1;
    mEdit.setCommandHandler('changeBuildConfiguration', () => {
      markedWhenAsked = fake.calls.length;
      return Promise.resolve({ refused: true, message: 'it holds no build configuration' });
    });
    const files = [fileOf('Harder VATS', 'a.dds'), fileOf('Harder VATS', 'b.dds')];

    const outcome = await commands.markFiles(files, 'Excluded', SOURCES);

    expect(configuredBy(mEdit)).toEqual([[SOURCE, { exclude: ['a.dds', 'b.dds'] }]]);
    expect(markedWhenAsked).toBe(0);
    expect(outcome).toEqual({ applied: true, outcome: { landed: [], refused: files.map((item) => ({ item, reason: 'it holds no build configuration' })) } });
    expect(fake.calls).toEqual([]);
  });

  it('marks the file of a mod with no source though mEdit refuses a source mod\'s', async () => {
    const { fake, mEdit, commands } = over();
    mEdit.setCommandResult('changeBuildConfiguration', { refused: true, message: 'it holds no build configuration' });
    const inSource = fileOf('Harder VATS', 'a.dds');
    const inNoSource = fileOf('ENBoost', 'b.dds');

    const outcome = await commands.markFiles([inSource, inNoSource], 'Excluded', SOURCES);

    expect(outcome).toEqual({ applied: true, outcome: { landed: [inNoSource], refused: [{ item: inSource, reason: 'it holds no build configuration' }] } });
    expect(fake.calls).toEqual([markOf(inNoSource, 'Excluded')]);
  });

  it('refuses the whole selection once, marking no file, when mEdit cannot be reached', async () => {
    const { fake, mEdit, commands } = over();
    mEdit.setCommandResult('changeBuildConfiguration', UNREACHABLE);
    const files = [fileOf('Harder VATS', 'a.dds'), fileOf('Harder VATS', 'b.dds'), fileOf('ENBoost', 'c.dds')];

    const outcome = await commands.markFiles(files, 'Excluded', SOURCES);

    expect(outcome).toEqual({ applied: false, refusal: UNREACHABLE.message });
    expect(fake.calls).toEqual([]);
  });

  it('puts back a source mod\'s configuration already changed when mEdit cannot be reached for the next, naming what could not be put back', async () => {
    const OTHER = '/instance/source/ENBoost';
    const { fake, mEdit, commands } = over();
    mEdit.setCommandHandler('changeBuildConfiguration', () => Promise.resolve(configuredBy(mEdit).length === 1 ? { changed: true } : UNREACHABLE));
    const files = [fileOf('Harder VATS', 'a.dds'), fileOf('ENBoost', 'c.dds')];

    const outcome = await commands.markFiles(files, 'Excluded', new Map([['Harder VATS', SOURCE], ['ENBoost', OTHER]]));

    expect(configuredBy(mEdit)).toEqual([[SOURCE, { exclude: ['a.dds'] }], [OTHER, { exclude: ['c.dds'] }], [SOURCE, { include: ['a.dds'] }]]);
    expect(outcome).toEqual({
      applied: false,
      refusal: `${UNREACHABLE.message} The build configuration in "${SOURCE}" could not be put back: ${UNREACHABLE.message}`,
    });
    expect(fake.calls).toEqual([]);
  });

  it('names why a configuration already changed could not be put back', async () => {
    const OTHER = '/instance/source/ENBoost';
    const { mEdit, commands } = over();
    mEdit.setCommandHandler('changeBuildConfiguration', (folder, change) => Promise.resolve(
      change.include !== undefined ? { refused: true, message: 'the disk refused the write' } : folder === SOURCE ? { changed: true } : UNREACHABLE));
    const files = [fileOf('Harder VATS', 'a.dds'), fileOf('ENBoost', 'c.dds')];

    const outcome = await commands.markFiles(files, 'Excluded', new Map([['Harder VATS', SOURCE], ['ENBoost', OTHER]]));

    expect(outcome).toEqual({
      applied: false,
      refusal: `${UNREACHABLE.message} The build configuration in "${SOURCE}" could not be put back: the disk refused the write`,
    });
  });

  it('takes back the exclusion of a file gone from disk, and lands the rest', async () => {
    const { mEdit, commands } = over(FIXTURE_ORDER, { goneOriginFiles: [fileOf('Harder VATS', 'gone.dds')] });
    mEdit.setCommandResult('changeBuildConfiguration', { changed: true });
    const marked = fileOf('Harder VATS', 'a.dds');
    const gone = fileOf('Harder VATS', 'gone.dds');

    const outcome = await commands.markFiles([marked, gone], 'Excluded', SOURCES);

    expect(outcome).toEqual({ applied: true, outcome: { landed: [marked], refused: [{ item: gone, reason: '"gone.dds" is gone from disk.' }] } });
    expect(configuredBy(mEdit)).toEqual([[SOURCE, { exclude: ['a.dds', 'gone.dds'] }], [SOURCE, { include: ['gone.dds'] }]]);
  });

  it('takes back the exclusion of a file the adapter refuses, with the adapter\'s reason', async () => {
    const { mEdit, commands } = over(FIXTURE_ORDER, { refusals: refusing('markOriginFile', 'permission denied') });
    mEdit.setCommandResult('changeBuildConfiguration', { changed: true });
    const file = fileOf('Harder VATS', 'a.dds');

    const outcome = await commands.markFiles([file], 'Excluded', SOURCES);

    expect(outcome).toEqual({ applied: true, outcome: { landed: [], refused: [{ item: file, reason: 'permission denied' }] } });
    expect(configuredBy(mEdit)).toEqual([[SOURCE, { exclude: ['a.dds'] }], [SOURCE, { include: ['a.dds'] }]]);
  });

  it('names both failures when the exclusion of a file that could not be marked cannot be taken back', async () => {
    const { mEdit, commands } = over(FIXTURE_ORDER, { goneOriginFiles: [fileOf('Harder VATS', 'gone.dds')] });
    mEdit.setCommandHandler('changeBuildConfiguration', (_, change) =>
      Promise.resolve(change.exclude === undefined ? { refused: true, message: 'the disk refused the write' } : { changed: true }));
    const gone = fileOf('Harder VATS', 'gone.dds');

    const outcome = await commands.markFiles([gone], 'Excluded', SOURCES);

    expect(outcome).toEqual({ applied: true, outcome: { landed: [], refused: [
      { item: gone, reason: '"gone.dds" is gone from disk. Its change to the build configuration could not be taken back: the disk refused the write' },
    ] } });
  });
});

describe('createEmptyMod', () => {
  it('makes the folder, then adds a line at the winning end', async () => {
    const { fake, commands } = over();

    const outcome = await commands.createEmptyMod('Default', 'My New Mod');

    expect(outcome).toEqual({ applied: true, wrote: true });
    expect(fake.calls).toEqual([
      { verb: 'createModFolder', mod: 'My New Mod' },
      orderWrite([{ kind: 'addAtWinningEnd', entry: { kind: 'mod', name: 'My New Mod' } }]),
    ]);
  });

  it('writes no line when the folder cannot be made, refusing with why', async () => {
    const { fake, commands } = over(FIXTURE_ORDER, { refusals: refusing('createModFolder', 'The folder is in the way') });

    const outcome = await commands.createEmptyMod('Default', 'Harder VATS');

    expect(outcome).toEqual({ applied: false, refusal: 'The folder is in the way' });
    expect(verbs(fake.calls)).toEqual(['createModFolder']);
  });

  it('a failed line write answers a partial, not a refusal, since the folder is on disk either way', async () => {
    const { commands } = over(FIXTURE_ORDER, { refusals: refusing('changeModOrder', 'disk full') });

    const outcome = await commands.createEmptyMod('Default', 'Line Write Fails');

    expect(outcome).toEqual({ applied: true, wrote: false, lineRefusal: 'disk full' });
  });
});

describe('syncMods', () => {
  const syncing = (order: readonly ModlistEntry[], onDisk: readonly EntryRef[], answers: InstanceAnswers = {}) =>
    ({ fake: fakeInstanceAdapter(readingFixture({ mods: order, modFolders: modFoldersOf(...onDisk) }), answers) });
  const sync = ({ fake }: ReturnType<typeof syncing>, handed: readonly EntryRef[], profile = 'Default') =>
    modSyncOver(fake.adapter)({ profile, modFolders: modFoldersOf(...handed).all });
  const folder = (name: string): EntryRef => ({ kind: 'mod', name });
  const sepFolder = (name: string): EntryRef => ({ kind: 'separator', name });

  it('adds a line for a folder with none and drops each line whose folder is gone, in one write', async () => {
    const run = syncing([mod('Kept'), mod('Gone Mod'), separator('Gone Sep')], [folder('Kept'), folder('Hand Extracted Mod')]);

    const outcome = await sync(run, [folder('Kept'), folder('Hand Extracted Mod')]);

    expect(outcome).toEqual({ applied: true, added: ['Hand Extracted Mod'], dropped: ['Gone Mod', 'Gone Sep (separator)'] });
    expect(run.fake.calls).toEqual([orderWrite([
      { kind: 'dropMod', mod: 'Gone Mod' }, { kind: 'dropSeparator', separator: 'Gone Sep' },
      { kind: 'addAtWinningEnd', entry: { kind: 'mod', name: 'Hand Extracted Mod' } },
    ])]);
  });

  it('writes the profile it is handed', async () => {
    const run = syncing([mod('Gone Mod')], []);

    await sync(run, [], 'Other');

    expect(run.fake.calls).toEqual([orderWrite([{ kind: 'dropMod', mod: 'Gone Mod' }], 'Other')]);
  });

  it('hands no change when every folder has a line and every mod line has a folder', async () => {
    const run = syncing([mod('A'), separator('B')], [folder('A'), sepFolder('B')]);

    expect(await sync(run, [folder('A'), sepFolder('B')])).toEqual({ applied: true, added: [], dropped: [] });
    expect(run.fake.calls).toEqual([orderWrite([])]);
  });

  it('keeps a line whose folder the handed list misses but that is on disk at write time, and adds no line for a folder it does not hand', async () => {
    const run = syncing([mod('Lagging')], [folder('Lagging'), folder('Landed Since')]);

    const outcome = await sync(run, []);

    expect(outcome).toEqual({ applied: true, added: [], dropped: [] });
    expect(run.fake.calls).toEqual([orderWrite([])]);
  });

  it('adds no line for a folder it is handed that is gone from disk at write time', async () => {
    const run = syncing([], []);

    const outcome = await sync(run, [folder('Ghost Mod')]);

    expect(outcome).toEqual({ applied: true, added: [], dropped: [] });
  });

  it('adds a batch ascending by name, each at the winning end, so the batch reads in order from the winning end, a separator folder as a separator', async () => {
    const run = syncing([], [folder('Zeta Mod'), folder('Alpha Mod'), sepFolder('Orphan')]);

    const outcome = await sync(run, [folder('Zeta Mod'), folder('Alpha Mod'), sepFolder('Orphan')]);

    expect(outcome).toEqual({ applied: true, added: ['Alpha Mod', 'Orphan (separator)', 'Zeta Mod'], dropped: [] });
    expect(run.fake.calls).toEqual([orderWrite([
      { kind: 'addAtWinningEnd', entry: { kind: 'mod', name: 'Zeta Mod' } },
      { kind: 'addAtWinningEnd', entry: { kind: 'separator', name: 'Orphan' } },
      { kind: 'addAtWinningEnd', entry: { kind: 'mod', name: 'Alpha Mod' } },
    ])]);
  });

  it('refuses, writing nothing, when there is no folder for mods at all, rather than dropping every line', async () => {
    const fake = fakeInstanceAdapter(readingFixture({ mods: [mod('A')], modFolders: undefined }));

    const outcome = await modSyncOver(fake.adapter)({ profile: 'Default', modFolders: undefined });

    expect(outcome).toEqual({ applied: false, refusal: 'there is no folder for mods' });
    expect(fake.calls).toEqual([]);
  });

  it('refuses with the adapter\'s reason when the write is refused', async () => {
    const run = syncing([mod('Gone Mod')], [], { refusals: refusing('changeModOrder', 'ENOENT: no such file') });

    expect(await sync(run, [])).toEqual({ applied: false, refusal: 'ENOENT: no such file' });
  });
});

describe('the names a separator or mod may take', () => {
  const { commands } = over();

  it('keys a name as the adapter keys it', () => {
    const taken = { mods: [separator('Unassigned (Modlist Development)')], modFolders: [] };

    expect(commands.separatorNameRefusal(taken, 'UNASSIGNED (modlist development)', 'Group B')).toBe('A separator with this name already exists');
  });

  it('refuses a mod name that holds a path separator', () => {
    const taken = { mods: [], modFolders: [] };

    expect(commands.renameModNameRefusal(taken, 'a/b', 'Mod B')).toBe('A mod name cannot contain / or \\');
    expect(commands.renameModNameRefusal(taken, 'a\\b', 'Mod B')).toBe('A mod name cannot contain / or \\');
  });
});
