import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchers, fakeVscodeModule } from '../../../test/mo2/fakeVscodeWatcher';
import { adapterOver } from '../../../test/mo2/adapterOver';
import { expectKind } from '../../../test/expectKind';
import type { FileRead, InstanceAdapter, PublisherConfiguration } from '../../instanceAdapter';
import { heldTexts, type HeldTexts } from '../../../symbolNames/symbolNames';

vi.mock('vscode', () => fakeVscodeModule());

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'modbench-wabbajack-'));
  await mkdir(join(root, 'mods'));
  await writeFile(join(root, 'ModOrganizer.ini'), '[General]\r\ngameName=Fallout 4\r\nselected_profile=Main\r\n');
  for (const [profile, modlist] of [['Main', '+Enabled\r\n'], ['Extra', '+enabled elsewhere\r\n']] as const) {
    await mkdir(join(root, 'profiles', profile), { recursive: true });
    await writeFile(join(root, 'profiles', profile, 'modlist.txt'), modlist);
    await writeFile(join(root, 'profiles', profile, 'plugins.txt'), '');
  }
});

afterEach(async () => {
  watchers.length = 0;
  await rm(root, { recursive: true, force: true });
});

const SETTINGS_FILE = 'compiler_settings.json';

const NEVER_SHIPPED = 'overwrite';

const publisherOver = (): InstanceAdapter => adapterOver(root, { pythonEnvFile: join(root, '..', 'outside.env') });

const configurationOf = async (adapter: InstanceAdapter): Promise<PublisherConfiguration> => (await adapter.reading()).publisherConfiguration;

const settingsNaming = async (adapter: InstanceAdapter, entry: Parameters<InstanceAdapter['entryReferences']['read']>[0], held: HeldTexts) => {
  const { references, leftOut } = await adapter.entryReferences.read(entry, held);
  return { references: references.filter(({ file }) => file === join(root, SETTINGS_FILE)), leftOut };
};

const writeSettings = (settings: unknown): Promise<void> =>
  writeFile(join(root, SETTINGS_FILE), typeof settings === 'string' ? settings : JSON.stringify(settings));

async function covering(...segments: string[]): Promise<string[]> {
  const configuration = expectKind(await configurationOf(publisherOver()), 'read');
  return configuration.covering(join(root, ...segments), segments[0] === 'mods' ? segments[1] : undefined).map(({ name }) => name);
}

describe('Wabbajack as a publisher (publishing.md, Publishers, story 1)', () => {
  it('declares its four publisher tags, Always Enabled marking only mods', () => {
    expect(publisherOver().publisherTags).toEqual([
      { name: 'No Match Include', badge: 'NM', marksPaths: true },
      { name: 'Include', badge: 'IN', marksPaths: true },
      { name: 'Ignore', badge: 'IG', marksPaths: true },
      { name: 'Always Enabled', badge: 'AE', marksPaths: false },
    ]);
  });

  it('is no publisher while the instance holds no compiler settings', async () => {
    expect(await configurationOf(publisherOver())).toEqual({ kind: 'none' });
  });

  it('reads no publisher tag from a mod\'s metadata, where Wabbajack once kept them (Publisher tags, story 5)', async () => {
    await mkdir(join(root, 'mods', 'A'), { recursive: true });
    await writeFile(join(root, 'mods', 'A', 'meta.ini'), '[General]\nnotes=WABBAJACK_ALWAYS_ENABLE WABBAJACK_INCLUDE\n');
    expect(await configurationOf(publisherOver())).toEqual({ kind: 'none' });

    await writeSettings({ Include: [] });
    expect(await covering('mods', 'A')).toEqual([]);
  });

  it('reads compiler settings as Wabbajack does, with comments and trailing commas', async () => {
    await writeSettings([
      '{', '  // what ships', '  "ModListWebsite": "http://example.org/*, ]",', '  "Include": ["mods\\\\A", "mods\\\\B,]",],',
      '  /* none, "Ignore": ["mods"] */ "Ignore": [],', '}',
    ].join('\n'));

    expect([await covering('mods', 'A'), await covering('mods', 'B,]'), await covering('mods', 'C')]).toEqual([['Include'], ['Include'], []]);
  });
});

describe('the rows a Wabbajack publisher tag covers (publishing.md, Publisher tags, story 1)', () => {
  it('covers the path it names and everything in it, by whole names, as Wabbajack matches a path', async () => {
    await writeSettings({ Include: ['mods\\A\\textures'] });

    expect([
      await covering('mods', 'A', 'textures'), await covering('mods', 'A', 'textures', 'armor', 'a.dds'),
      await covering('mods', 'A'), await covering('mods', 'A', 'textures2', 'a.dds'),
    ]).toEqual([['Include'], ['Include'], [], []]);
  });

  it('matches a path without case, and spelled with either separator', async () => {
    await writeSettings({ Include: ['MODS\\a'], NoMatchInclude: ['mods/B/'] });

    expect([await covering('mods', 'A', 'x.esp'), await covering('mods', 'B', 'x.esp')]).toEqual([['Include'], ['No Match Include']]);
  });

  it('gives a row each publisher tag that covers it once, in the order Wabbajack declares them', async () => {
    await writeSettings({ AlwaysEnabled: ['mods\\A'], Include: ['mods\\A\\x.esp', 'mods\\A'], NoMatchInclude: ['mods'] });

    expect([await covering('mods', 'A'), await covering('mods', 'A', 'x.esp')])
      .toEqual([['No Match Include', 'Include', 'Always Enabled'], ['No Match Include', 'Include', 'Always Enabled']]);
  });

  it('gives a row Ignore covers Ignore alone: the compiler ignores it before any other publisher tag applies', async () => {
    await writeSettings({ AlwaysEnabled: ['mods\\A'], Include: ['mods\\A'], NoMatchInclude: ['mods'], Ignore: ['mods\\A\\x.esp'] });

    expect([await covering('mods', 'A', 'x.esp'), await covering('mods', 'A')])
      .toEqual([['Ignore'], ['No Match Include', 'Include', 'Always Enabled']]);
  });

  it('covers nothing outside the instance', async () => {
    await writeSettings({ Include: [''] });

    expect([await covering('a.dds'), await covering('..', 'a.dds')]).toEqual([['Include'], []]);
  });
});

describe('a mod Wabbajack\'s compile profiles leave disabled, as its compiler applies its publisher tags to it', () => {
  const COMPILE_PROFILES = { Profile: 'Main', AdditionalProfiles: ['Extra'] };

  it('a mod no compile profile enables, and a file in it, carry no Include nor No Match Include: the compiler drops its files', async () => {
    await writeSettings({ ...COMPILE_PROFILES, Include: ['mods\\Disabled'], NoMatchInclude: ['mods\\Disabled\\textures'] });

    expect([await covering('mods', 'Disabled'), await covering('mods', 'Disabled', 'textures', 'a.dds')]).toEqual([[], []]);
  });

  it('a mod any compile profile enables carries them, its name matched without case, whatever profile the instance has selected', async () => {
    await writeSettings({ ...COMPILE_PROFILES, Include: ['mods'] });

    expect([await covering('mods', 'Enabled', 'x.esp'), await covering('mods', 'Enabled Elsewhere', 'x.esp')]).toEqual([['Include'], ['Include']]);
  });

  it('a disabled Always Enabled mod and a file in it carry each publisher tag, as an enabled mod\'s do', async () => {
    await writeSettings({ ...COMPILE_PROFILES, Include: ['mods\\Disabled'], AlwaysEnabled: ['mods\\Disabled'] });

    expect([await covering('mods', 'Disabled'), await covering('mods', 'Disabled', 'x.esp')])
      .toEqual([['Include', 'Always Enabled'], ['Include', 'Always Enabled']]);
  });

  it('a file in a disabled mod carries Ignore, which the compiler applies before it drops a disabled mod\'s files', async () => {
    await writeSettings({ ...COMPILE_PROFILES, Ignore: ['mods\\Disabled\\x.esp'] });

    expect(await covering('mods', 'Disabled', 'x.esp')).toEqual(['Ignore']);
  });

  it('drops no mod while the settings name no compile profile, as the compiler then runs no disabled-mod step', async () => {
    await writeSettings({ Profile: ' ', Include: ['mods'] });

    expect(await covering('mods', 'Disabled', 'x.esp')).toEqual(['Include']);
  });
});

describe('a folder Wabbajack\'s compiler never ships, as the mod manager names it', () => {
  it('a path in it carries Ignore alone: the compiler drops the folder after it applies Ignore and before the rest', async () => {
    await writeSettings({
      Include: [NEVER_SHIPPED, 'overwrite2'], NoMatchInclude: [`${NEVER_SHIPPED}\\F4SE`], Ignore: [`${NEVER_SHIPPED}\\F4SE\\x.ini`], AlwaysEnabled: [NEVER_SHIPPED],
    });

    expect([
      await covering(NEVER_SHIPPED), await covering('OVERWRITE', 'F4SE'), await covering(NEVER_SHIPPED, 'F4SE', 'x.ini'), await covering('overwrite2', 'a'),
    ]).toEqual([[], [], ['Ignore'], ['Include']]);
  });

  it('leaves every other path as the publisher tags that cover it say', async () => {
    await writeSettings({ Include: ['mods'] });

    expect(await covering('mods', 'A')).toEqual(['Include']);
  });
});

describe('a file the compiler has no way to ship, once no package holds its bytes or a file of its name (publishing.md, What ships, story 2)', () => {
  const COMPILE_PROFILES = { Profile: 'Main' };
  const REASON = 'no package holds its bytes or a file of its name, and no Include or No Match Include publisher tag covers it';

  async function unshippable(mod: string, pathInMod: string, folder: readonly string[] = ['mods', mod], heldByPackage = false, entries?: FileRead<readonly string[]>): Promise<string | undefined> {
    const { unshippable: judged } = expectKind(await configurationOf(publisherOver()), 'read');
    return judged.reason(join(root, ...folder), pathInMod, mod, heldByPackage, entries);
  }

  describe('hands back the same judgement while what it judges by is unchanged', () => {
    const judgeOf = async (publisher: InstanceAdapter) => expectKind(await configurationOf(publisher), 'read').unshippable.reason;

    it('across readings of unchanged settings and unchanged enabled mods', async () => {
      await writeSettings({ ...COMPILE_PROFILES, Include: ['mods\\\\A'] });
      const publisher = publisherOver();

      expect(await judgeOf(publisher)).toBe(await judgeOf(publisher));
    });

    it('is replaced by a new one when the settings change', async () => {
      await writeSettings({ ...COMPILE_PROFILES, Include: ['mods\\\\A'] });
      const publisher = publisherOver();
      const before = await judgeOf(publisher);

      await writeSettings({ ...COMPILE_PROFILES, Include: ['mods\\\\B'] });

      expect(await judgeOf(publisher)).not.toBe(before);
    });

    it('is replaced by a new one when the mods a compile profile enables change', async () => {
      await writeSettings(COMPILE_PROFILES);
      const publisher = publisherOver();
      const before = await judgeOf(publisher);

      await writeFile(join(root, 'profiles', 'Main', 'modlist.txt'), '+Enabled\r\n+Newly Enabled\r\n');

      expect(await judgeOf(publisher)).not.toBe(before);
    });
  });

  it('names the compiler settings as the file it is shown on', async () => {
    await writeSettings({});

    expect(expectKind(await configurationOf(publisherOver()), 'read').unshippable.file).toBe(join(root, SETTINGS_FILE));
  });

  it('judges a file in an enabled mod that no Include nor No Match Include covers to be one, and says why', async () => {
    await writeSettings(COMPILE_PROFILES);

    expect(await unshippable('Enabled', 'x.esp')).toBe(REASON);
  });

  it.each([['Include'], ['NoMatchInclude']])('judges it shippable once %s covers its folder or the file', async (listedUnder) => {
    await writeSettings({ ...COMPILE_PROFILES, [listedUnder]: ['mods\\Enabled\\textures', 'mods\\Enabled\\x.esp'] });

    expect([await unshippable('Enabled', join('textures', 'a.dds')), await unshippable('Enabled', 'x.esp'), await unshippable('Enabled', 'y.esp')])
      .toEqual([undefined, undefined, REASON]);
  });

  it('judges a file Ignore covers shippable, since the compiler never asks for it', async () => {
    await writeSettings({ Ignore: ['mods\\Enabled'] });

    expect(await unshippable('Enabled', 'x.esp')).toBeUndefined();
  });

  it('judges a file in a mod no compile profile enables, or in a folder the compiler never ships, shippable', async () => {
    await writeSettings(COMPILE_PROFILES);

    expect([await unshippable('Disabled', 'x.esp'), await unshippable('Enabled', 'x.ini', [NEVER_SHIPPED])]).toEqual([undefined, undefined]);
  });

  it('judges a file in a disabled Always Enabled mod one, as the compiler ships that mod', async () => {
    await writeSettings({ ...COMPILE_PROFILES, AlwaysEnabled: ['mods\\Disabled'] });

    expect(await unshippable('Disabled', 'x.esp')).toBe(REASON);
  });

  it('judges a file one of its mod\'s packages holds shippable, though no publisher tag covers it', async () => {
    await writeSettings(COMPILE_PROFILES);

    expect(await unshippable('Enabled', 'x.esp', ['mods', 'Enabled'], true)).toBeUndefined();
  });

  describe('an archive, judged entry by entry as the compiler deconstructs it', () => {
    const NOT_COVERED = 'and no Include or No Match Include publisher tag covers it';

    it('judges it shippable when a package holds every entry', async () => {
      await writeSettings(COMPILE_PROFILES);

      expect(await unshippable('Enabled', 'a.ba2', ['mods', 'Enabled'], false, { kind: 'read', answer: [] })).toBeUndefined();
    });

    it('judges it unshippable, naming the entry no package holds, though other entries are held', async () => {
      await writeSettings(COMPILE_PROFILES);

      expect(await unshippable('Enabled', 'a.ba2', ['mods', 'Enabled'], false, { kind: 'read', answer: ['textures/a.dds', 'textures/b.dds'] }))
        .toBe(`no package holds its entry 'textures/a.dds', nor 1 other, ${NOT_COVERED}`);
    });

    it('judges it unshippable, saying why, when its entries cannot be read', async () => {
      await writeSettings(COMPILE_PROFILES);

      expect(await unshippable('Enabled', 'a.ba2', ['mods', 'Enabled'], false, { kind: 'unreadable', reason: 'not a BA2' }))
        .toBe(`its entries cannot be read (not a BA2), ${NOT_COVERED}`);
    });

    it('judges it shippable when Include covers it, though an entry is unheld', async () => {
      await writeSettings({ ...COMPILE_PROFILES, Include: ['mods\\Enabled\\a.ba2'] });

      expect(await unshippable('Enabled', 'a.ba2', ['mods', 'Enabled'], false, { kind: 'read', answer: ['textures/a.dds'] })).toBeUndefined();
    });
  });

  it('judges a file outside the instance shippable', async () => {
    await writeSettings({});

    expect(await unshippable('Enabled', 'x.esp', ['..'])).toBeUndefined();
  });
});

describe('compiler settings Modbench cannot read (Never silently wrong)', () => {
  const reason = async (): Promise<string> => expectKind(await configurationOf(publisherOver()), 'unreadable').reason;

  it('says so, naming the file, when they are not JSON', async () => {
    await writeSettings('{ "Include": [');

    expect(await reason()).toContain(join(root, SETTINGS_FILE));
  });

  it.each([
    ['a publisher tag holds a list that holds other than paths', { Include: ['mods\\A', 3] }, 'Include'],
    ['a publisher tag holds other than a list', { Ignore: 'mods\\A' }, 'Ignore'],
    ['they hold a compile profile other than a name', { Profile: 3 }, 'Profile'],
    ['they hold compile profiles other than names', { Profile: 'Main', AdditionalProfiles: 'Extra' }, 'AdditionalProfiles'],
  ])('says so, naming the file and its key, when %s', async (_, settings, key) => {
    await writeSettings(settings);

    expect(await reason()).toMatch(new RegExp(`${SETTINGS_FILE}.*${key}`));
  });

  it('says so, with the mod manager\'s reason, when a compile profile\'s mods cannot be read', async () => {
    await writeSettings({ Profile: 'Gone' });

    expect(await reason()).toContain(join('profiles', 'Gone', 'modlist.txt'));
  });

  it('says so when they are not an object', async () => {
    await writeSettings('[]');

    expect(await reason()).toContain(SETTINGS_FILE);
  });
});

describe('the publisher tags the configuration lists on a path (publishing.md, Publisher tags, story 2: what remove takes away)', () => {
  const listed = async (...segments: string[]): Promise<string[]> => {
    return expectKind(await configurationOf(publisherOver()), 'read').listed(join(root, ...segments)).map(({ name }) => name);
  };

  it('are those that name exactly the path, in the order Wabbajack declares them, and not those that name a path above or below it', async () => {
    await writeSettings({ AlwaysEnabled: ['mods\\A'], Include: ['MODS/a/', 'mods\\A\\x.esp'], NoMatchInclude: ['mods'] });

    expect([await listed('mods', 'A'), await listed('mods', 'A', 'x.esp'), await listed('mods', 'A', 'y.esp'), await listed('mods')])
      .toEqual([['Include', 'Always Enabled'], ['Include'], [], ['No Match Include']]);
  });

  it('are listed whatever the compiler does with the path: a disabled mod, and an Ignored path that shadows its other tags', async () => {
    await writeSettings({ Profile: 'Main', Include: ['mods\\Disabled', 'mods\\Enabled\\x.esp'], Ignore: ['mods\\Enabled\\x.esp'] });

    expect([await listed('mods', 'Disabled'), await listed('mods', 'Enabled', 'x.esp')]).toEqual([['Include'], ['Include', 'Ignore']]);
    expect(await covering('mods', 'Disabled')).toEqual([]);
    expect(await covering('mods', 'Enabled', 'x.esp')).toEqual(['Ignore']);
  });
});

describe('changing a publisher tag in the compiler settings (publishing.md, Publisher tags, stories 2 and 5)', () => {
  const settingsText = () => readFile(join(root, SETTINGS_FILE), 'utf8');
  const settings = async (): Promise<unknown> => JSON.parse(await settingsText());

  it('adds the path under the tag\'s list, relative to the instance and spelled as Wabbajack spells one, keeping every other setting', async () => {
    await writeSettings({ OutputFile: 'C:\\out\\list.wabbajack', Include: ['mods\\A'] });

    const refused = await publisherOver().changePublisherTag('add', 'Ignore', [join(root, 'mods', 'B', 'x.esp')]);

    expect({ refused, settings: await settings() })
      .toEqual({ refused: [], settings: { OutputFile: 'C:\\out\\list.wabbajack', Include: ['mods\\A'], Ignore: ['mods\\B\\x.esp'] } });
  });

  it('writes nothing for a path the tag already names, however it is spelled', async () => {
    const text = '{"Include":["MODS/a/"]}';
    await writeSettings(text);

    const refused = await publisherOver().changePublisherTag('add', 'Include', [join(root, 'mods', 'A')]);

    expect({ refused, text: await settingsText() }).toEqual({ refused: [], text });
  });

  it('removes the entry that names the path, whatever its spelling, and leaves the other entries', async () => {
    await writeSettings({ Include: ['MODS/a/', 'mods\\B'] });

    const refused = await publisherOver().changePublisherTag('remove', 'Include', [join(root, 'mods', 'A')]);

    expect(refused).toEqual([]);
    expect(await settings()).toMatchObject({ Include: ['mods\\B'] });
  });

  it('refuses a path outside the instance and lands the rest', async () => {
    await writeSettings({ Include: ['mods\\A'] });
    const outside = join(root, '..', 'elsewhere');

    const refused = await publisherOver().changePublisherTag('remove', 'Include', [outside, join(root, 'mods', 'A')]);

    expect(refused).toEqual([{ path: outside, reason: 'It is outside the instance.' }]);
    expect(await settings()).toMatchObject({ Include: [] });
  });

  it('removes nothing, writes nothing and refuses nothing for a path the tag does not name, though a path above it does', async () => {
    const text = '{"Include":["mods\\\\A"]}';
    await writeSettings(text);

    const refused = await publisherOver().changePublisherTag('remove', 'Include', [join(root, 'mods', 'A', 'x.esp'), join(root, 'mods', 'B')]);

    expect({ refused, text: await settingsText() }).toEqual({ refused: [], text });
  });

  it('keeps the file\'s indentation, line ends and final newline', async () => {
    await writeSettings('{\r\n    "Include": [\r\n        "mods\\\\A"\r\n    ]\r\n}\r\n');

    await publisherOver().changePublisherTag('add', 'Include', [join(root, 'mods', 'B')]);

    expect(await settingsText()).toBe('{\r\n    "Include": [\r\n        "mods\\\\A",\r\n        "mods\\\\B"\r\n    ]\r\n}\r\n');
  });

  it('rejects, writing nothing, for a tag it does not declare', async () => {
    const text = '{"Include":[]}';
    await writeSettings(text);

    await expect(publisherOver().changePublisherTag('add', 'Nope', [join(root, 'mods', 'A')])).rejects.toThrow('Nope');

    expect(await settingsText()).toBe(text);
  });

  it('rejects while the instance holds no compiler settings, creating none', async () => {
    await expect(publisherOver().changePublisherTag('add', 'Include', [join(root, 'mods', 'A')])).rejects.toThrow(SETTINGS_FILE);
    await expect(readFile(join(root, SETTINGS_FILE), 'utf8')).rejects.toThrow();
  });
});

describe('publisher tags following a mod folder (publishing.md, Publisher tags, story 3)', () => {
  const settingsText = () => readFile(join(root, SETTINGS_FILE), 'utf8');
  const folder = (name: string) => join(root, 'mods', name);

  it('moves every entry at or under the old folder to the new one, in every list, keeping the rest of each path and the other entries', async () => {
    await writeSettings({ Include: ['MODS/a/', 'mods\\A\\Textures\\x.dds', 'mods\\B'], Ignore: ['mods\\a\\x.esp'], AlwaysEnabled: ['mods\\A'] });

    await publisherOver().followModFolders([{ from: folder('A'), to: folder('C') }]);

    expect(JSON.parse(await settingsText())).toEqual({
      Include: ['mods\\C', 'mods\\C\\Textures\\x.dds', 'mods\\B'], Ignore: ['mods\\C\\x.esp'], AlwaysEnabled: ['mods\\C'],
    });
  });

  it('removes every entry at or under the folder when the mod has no new one', async () => {
    await writeSettings({ Include: ['mods\\A', 'mods\\A\\x.esp', 'mods\\AB'], Ignore: ['mods\\B'] });

    await publisherOver().followModFolders([{ from: folder('A') }, { from: folder('B') }]);

    expect(JSON.parse(await settingsText())).toEqual({ Include: ['mods\\AB'], Ignore: [] });
  });

  it('leaves a duplicate the move does not touch beside the entries it moves', async () => {
    await writeSettings({ Include: ['mods\\X', 'mods/x', 'mods\\A'] });

    await publisherOver().followModFolders([{ from: folder('A'), to: folder('C') }]);

    expect(JSON.parse(await settingsText())).toEqual({ Include: ['mods\\X', 'mods/x', 'mods\\C'] });
  });

  it('lists an entry once when the new folder already has it', async () => {
    await writeSettings({ Include: ['mods\\A', 'mods\\C'] });

    await publisherOver().followModFolders([{ from: folder('A'), to: folder('C') }]);

    expect(JSON.parse(await settingsText())).toEqual({ Include: ['mods\\C'] });
  });

  it('writes nothing when no entry is under the folder', async () => {
    const text = '{"Include":["mods\\\\B"]}';
    await writeSettings(text);

    await publisherOver().followModFolders([{ from: folder('A'), to: folder('C') }]);

    expect(await settingsText()).toBe(text);
  });

  it('writes nothing when the settings hold a duplicate the move does not touch', async () => {
    const text = '{"Include":["mods\\\\X","mods/x","mods\\\\B"]}';
    await writeSettings(text);

    await publisherOver().followModFolders([{ from: folder('A'), to: folder('C') }]);

    expect(await settingsText()).toBe(text);
  });
});

describe('keeping Modbench\'s files out of what Wabbajack ships (publishing.md, What ships, story 1)', () => {
  const settingsText = () => readFile(join(root, SETTINGS_FILE), 'utf8');
  const holding = async (...files: string[]): Promise<void> => {
    for (const file of files) {
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, '');
    }
  };

  it('lists each file in Ignore, after the entries already there, in every other list left as written', async () => {
    await writeSettings({ Include: ['mods\\A'], Ignore: ['mine'] });
    await holding(join(root, '.gitignore'), join(root, 'mods', 'A', 'A.manifest.json'));

    await publisherOver().reading();

    expect(JSON.parse(await settingsText())).toEqual({ Include: ['mods\\A'], Ignore: ['mine', '.gitignore', 'mods\\A\\A.manifest.json'] });
  });

  it('writes nothing for a file an entry already lists, however it is spelled, or an ignored folder holds', async () => {
    const text = '{"Ignore":["HASH-INDEX/","mods/a/A.MANIFEST.json"]}';
    await writeSettings(text);
    await holding(join(root, 'mods', 'A', 'A.manifest.json'), join(root, 'hash-index', 'x', 'y'));

    await publisherOver().reading();

    expect(await settingsText()).toBe(text);
  });

  it('drops an entry for a file of Modbench\'s that is gone, however it is spelled, and keeps every other entry as written', async () => {
    await writeSettings({ Ignore: ['MODS/Gone/gone.MANIFEST.json', 'mods\\Here\\Here.manifest.json', 'mods\\Gone', 'mods\\Gone\\notes.txt', 'mine'], Include: ['mods\\Gone\\Gone.manifest.json'] });
    await holding(join(root, 'mods', 'Here', 'Here.manifest.json'));

    await publisherOver().reading();

    expect(JSON.parse(await settingsText())).toEqual({ Ignore: ['mods\\Here\\Here.manifest.json', 'mods\\Gone', 'mods\\Gone\\notes.txt', 'mine'], Include: ['mods\\Gone\\Gone.manifest.json'] });
  });

  it('skips a file outside the instance', async () => {
    const text = '{"Ignore":[]}';
    await writeSettings(text);

    await publisherOver().reading();

    expect(await settingsText()).toBe(text);
  });

  it('lists the script environment file in Ignore when it is in the instance', async () => {
    await writeSettings({ Ignore: [] });

    await adapterOver(root).reading();

    expect(JSON.parse(await settingsText())).toEqual({ Ignore: ['.env'] });
  });
});

describe('a change to the compiler settings', () => {
  const settingsText = () => readFile(join(root, SETTINGS_FILE), 'utf8');
  const changeTag = () => publisherOver().changePublisherTag('add', 'Include', [join(root, 'mods', 'A')]);
  const followFolders = () => publisherOver().followModFolders([{ from: join(root, 'mods', 'A'), to: join(root, 'mods', 'C') }]);
  const keepOut = () => adapterOver(root).reading();

  it.each([
    ['changing a publisher tag', changeTag],
    ['following a mod folder', followFolders],
  ])('rejects, writing nothing, for settings it cannot read, %s', async (_, change) => {
    await writeSettings('not json');

    await expect(change()).rejects.toThrow(SETTINGS_FILE);

    expect(await settingsText()).toBe('not json');
  });

  it('reads settings it cannot read as unreadable, writing nothing, while keeping Modbench\'s files out', async () => {
    await writeSettings('not json');

    const { publisherConfiguration } = await keepOut();

    expect([publisherConfiguration.kind, await settingsText()]).toEqual(['unreadable', 'not json']);
  });

  it.each([
    ['following a mod folder', followFolders],
    ['keeping Modbench\'s files out', keepOut],
  ])('does nothing while the instance holds no compiler settings, creating none, %s', async (_, change) => {
    await change();

    await expect(settingsText()).rejects.toThrow();
  });
});

describe('the watch on the compiler settings (ADR-0003)', () => {
  const live = () => watchers.filter((watcher) => !watcher.disposed);
  const settingsWatchers = () => live().filter(({ pattern }) => pattern === SETTINGS_FILE);

  it('arms nothing until someone listens, hears the file created, changed or deleted at the instance root, and disarms when they leave', () => {
    const publisher = publisherOver();
    const armedBefore = live().length;
    let signals = 0;
    const subscription = publisher.subscribe(() => { signals++; });
    const watcher = live().find(({ pattern }) => pattern === SETTINGS_FILE);

    watcher?.fireCreate(join(root, SETTINGS_FILE));
    watcher?.fireChange(join(root, SETTINGS_FILE));
    watcher?.fireDelete(join(root, SETTINGS_FILE));
    subscription.dispose();

    expect({ armedBefore, signals, watched: [watcher?.base, watcher?.pattern], armedAfter: live().length })
      .toEqual({ armedBefore: 0, signals: 3, watched: [root, SETTINGS_FILE], armedAfter: settingsWatchers().length });
  });
});

describe('the publisher tags that name no path in the instance (publishing.md, Publisher tags, story 4)', () => {
  const naming = () => configurationOf(publisherOver());
  const reads = (pathProblems: unknown) => ({ kind: 'read', pathProblems });

  it('lists an entry naming no file or folder, with its line, as comments and trailing commas leave it', async () => {
    await mkdir(join(root, 'mods', 'A', 'textures'), { recursive: true });
    await writeFile(join(root, 'mods', 'A', 'meta.ini'), '');
    await writeSettings([
      '{',
      '  // "Ignore": ["gone"]',
      '  "Include": ["mods\\\\A", "mods\\\\Gone",],',
      '  "Ignore": [',
      '    "mods/A/meta.ini",',
      '    "mods/A/meta.ini/inside",',
      '    "mods\\\\A\\\\Gone.txt"',
      '  ],',
      '  "AlwaysEnabled": ["mods\\\\Missing"]',
      '}',
    ].join('\n'));
    const file = join(root, SETTINGS_FILE);

    expect(await naming()).toMatchObject(reads([
      { kind: 'namesNoPath', file, line: 3, tag: { name: 'Include' }, entry: 'mods\\Gone' },
      { kind: 'namesNoPath', file, line: 6, tag: { name: 'Ignore' }, entry: 'mods/A/meta.ini/inside' },
      { kind: 'namesNoPath', file, line: 7, tag: { name: 'Ignore' }, entry: 'mods\\A\\Gone.txt' },
      { kind: 'namesNoPath', file, line: 9, tag: { name: 'Always Enabled' }, entry: 'mods\\Missing' },
    ]));
  });

  it('takes a key listed twice at its last, as the parse does', async () => {
    await writeSettings('{\n  "Include": ["first"],\n  "Include": [\n    "second"\n  ]\n}');

    expect(await naming()).toMatchObject(reads([{ kind: 'namesNoPath', line: 4, entry: 'second' }]));
  });

  it('matches a path without case, at either separator', async () => {
    await mkdir(join(root, 'mods', 'Alpha'), { recursive: true });
    await writeSettings({ Include: ['mods\\alpha', 'MODS/ALPHA/'] });

    expect(await naming()).toMatchObject(reads([]));
  });

  it('says a folder it cannot list could not be checked, and keeps every other entry and the configuration read', async () => {
    await mkdir(join(root, 'mods', 'A'), { recursive: true });
    await symlink(join(root, 'mods', 'loop'), join(root, 'mods', 'loop'), 'dir');
    await writeSettings({ Include: ['mods\\loop\\x', 'mods\\A', 'mods\\Gone'] });

    expect(await naming()).toMatchObject(reads([
      { kind: 'notChecked', entry: 'mods\\loop\\x', reason: expect.stringMatching(/ELOOP/) as unknown },
      { kind: 'namesNoPath', entry: 'mods\\Gone' },
    ]));
    expect(await covering('mods', 'A')).toEqual(['Include']);
  });

  it('refuses an unreadable configuration without walking the instance', async () => {
    await writeSettings('{ not json');

    expect(await publisherOver().publisherConfigurationRefusal()).toContain('is not JSON: ');
  });

  it('says where the configuration broke', async () => {
    await writeSettings('{\n  "Include": [\n    "a" "b"\n  ]\n}');

    expect(await configurationOf(publisherOver())).toMatchObject({ kind: 'unreadable', reason: expect.stringMatching(/ at line 3, column 9$/) as unknown });
  });
});

describe('a write to the compiler settings changes only the entries it names (Never silently wrong)', () => {
  const settingsText = () => readFile(join(root, SETTINGS_FILE), 'utf8');
  const folder = (name: string) => join(root, 'mods', name);
  const settingsWith = (list: string, key = 'Include') => `// shaped by hand\n{\n  /* mine */\n  "${key}": ${list},\n  "Mine": 1,\n}\n`;
  const entries = (...lines: string[]) => `[\n${lines.map((line) => `    ${line}`).join('\n')}\n  ]`;

  type Gesture = () => Promise<unknown>;
  const removal = (name: string): Gesture => () => publisherOver().changePublisherTag('remove', 'Include', [folder(name)]);
  const addition = (name: string): Gesture => () => publisherOver().changePublisherTag('add', 'Include', [folder(name)]);
  const renaming = (from: string, to: string): Gesture => () => publisherOver().followModFolders([{ from: folder(from), to: folder(to) }]);

  const cases: readonly [name: string, gesture: Gesture, before: string, after: string, atLineEnds: boolean][] = [
    ['remove: a block comment before the comma stays', removal('A'),
      settingsWith(entries('"mods/A" /* x */,', '"mods/B"')), settingsWith(entries(' /* x */', '"mods/B"')), false],
    ['remove: a line comment after the comma stays', removal('A'),
      settingsWith(entries('"mods/A", // about a', '"mods/B"')), settingsWith(entries(' // about a', '"mods/B"')), false],
    ['remove: the first entry takes its line', removal('A'),
      settingsWith(entries('"mods/A",', '"mods/B",', '"mods/C"')), settingsWith(entries('"mods/B",', '"mods/C"')), true],
    ['remove: a middle entry takes its line', removal('B'),
      settingsWith(entries('"mods/A", // about a', '"mods/B",', '"mods/C" // about c')), settingsWith(entries('"mods/A", // about a', '"mods/C" // about c')), false],
    ['remove: the last entry without a trailing comma takes the comma before it, not the comment after that comma', removal('C'),
      settingsWith(entries('"mods/A",', '"mods/B", // about b', '"mods/C"')), settingsWith(entries('"mods/A",', '"mods/B" // about b')), false],
    ['remove: the last entry with a trailing comma takes its line', removal('C'),
      settingsWith(entries('"mods/A",', '"mods/C",')), settingsWith(entries('"mods/A",')), false],
    ['remove: the only entry leaves an empty list', removal('A'),
      settingsWith(entries('"mods/A"')), settingsWith('[\n  ]'), false],
    ['remove: an inline entry with a comment between it and its comma', removal('A'),
      settingsWith('["mods/A" /* x */, "mods/B"]'), settingsWith('[ /* x */ "mods/B"]'), false],
    ['remove: a block comment before the value stays', removal('A'),
      settingsWith(entries('/* c */ "mods/A",', '"mods/B"')), settingsWith(entries('/* c */ ', '"mods/B"')), false],
    ['add: after a last entry with a trailing comma and a comment, the comment stays on its entry', addition('X'),
      settingsWith(entries('"mods/C", // about c')), settingsWith(entries('"mods/C", // about c', '"mods\\\\X",')), true],
    ['add: after a last entry without a comma, the comment stays on its entry', addition('X'),
      settingsWith(entries('"mods/C" // about c')), settingsWith(entries('"mods/C", // about c', '"mods\\\\X"')), false],
    ['add: after a last entry with a block comment, the comment stays on its entry', addition('X'),
      settingsWith(entries('"mods/B",', '"mods/C" /* about c */')), settingsWith(entries('"mods/B",', '"mods/C", /* about c */', '"mods\\\\X"')), false],
    ['add: after a plain last entry', addition('X'),
      settingsWith(entries('"mods/C"')), settingsWith(entries('"mods/C",', '"mods\\\\X"')), false],
    ['add: to an inline list', addition('X'),
      settingsWith('["mods/C"]'), settingsWith('["mods/C", "mods\\\\X"]'), false],
    ['add: to an empty list', addition('X'),
      settingsWith('[]'), settingsWith('["mods\\\\X"]'), false],
    ['add: a list the settings lack follows the settings it keeps', () => publisherOver().changePublisherTag('add', 'Always Enabled', [folder('C')]),
      settingsWith(entries('"mods/A"')), settingsWith(entries('"mods/A"')).replace('  "Mine": 1,\n', '  "Mine": 1,\n  "AlwaysEnabled": [\n    "mods\\\\C"\n  ],\n'), false],
    ['add: a list the settings lack follows the last setting, before the comment after it', () => publisherOver().changePublisherTag('add', 'Always Enabled', [folder('C')]),
      '{\n  "Mine": 1, // mine\n}\n', '{\n  "Mine": 1, // mine\n  "AlwaysEnabled": [\n    "mods\\\\C"\n  ],\n}\n', true],
    ['add: a list the settings lack follows a last setting without a comma', () => publisherOver().changePublisherTag('add', 'Always Enabled', [folder('C')]),
      '{\n  "Mine": 1 // mine\n}\n', '{\n  "Mine": 1, // mine\n  "AlwaysEnabled": [\n    "mods\\\\C"\n  ]\n}\n', false],
    ['add: to the empty last list of a key listed twice, the one the compiler reads', addition('X'),
      '{\n  "Include": [\n    "mods/old"\n  ],\n  "Include": [\n  ]\n}\n', '{\n  "Include": [\n    "mods/old"\n  ],\n  "Include": [\n    "mods\\\\X"\n  ]\n}\n', true],
    ['keep-out: a gone manifest goes and the file is added, leaving the comment', async () => {
      await mkdir(join(root, 'mods', 'B'), { recursive: true });
      await writeFile(join(root, 'mods', 'B', 'B.manifest.json'), '');
      return publisherOver().reading();
    },
      settingsWith(entries('"mods/Old/Old.manifest.json", // gone', '"mine"'), 'Ignore'),
      settingsWith(entries(' // gone', '"mine",', '"mods\\\\B\\\\B.manifest.json"'), 'Ignore'), false],
    ['follow: a renamed entry keeps its comments and its place', renaming('B', 'D'),
      settingsWith(entries('"mods/A",', '"mods/B", // about b', '"mods/C"')), settingsWith(entries('"mods/A",', '"mods\\\\D", // about b', '"mods/C"')), false],
  ];

  it.each(cases)('%s', async (_, gesture, before, after) => {
    await writeSettings(before);

    await gesture();

    expect(await settingsText()).toBe(after);
  });

  it.each(cases.filter(([, , , , atLineEnds]) => atLineEnds))('in CRLF, where a line ends decides the edit, %s', async (_, gesture, before, after) => {
    await writeSettings(before.replaceAll('\n', '\r\n'));

    await gesture();

    expect(await settingsText()).toBe(after.replaceAll('\n', '\r\n'));
  });

  it('keeps a tab indent and a missing final newline', async () => {
    await writeSettings('{\n\t"Include": [\n\t\t"mods\\\\A"\n\t]\n}');

    await publisherOver().changePublisherTag('add', 'Include', [folder('C')]);

    expect(await settingsText()).toBe('{\n\t"Include": [\n\t\t"mods\\\\A",\n\t\t"mods\\\\C"\n\t]\n}');
  });

  it('edits the last of a key listed twice, the one the compiler reads', async () => {
    await writeSettings('{\n  "Ignore": [\n    "ignored"\n  ],\n  "Ignore": [\n    "read"\n  ]\n}');

    await publisherOver().changePublisherTag('add', 'Ignore', [folder('C')]);
    await publisherOver().followModFolders([{ from: join(root, 'read'), to: folder('D') }]);
    await publisherOver().changePublisherTag('remove', 'Ignore', [folder('C')]);

    expect(await settingsText()).toBe('{\n  "Ignore": [\n    "ignored"\n  ],\n  "Ignore": [\n    "mods\\\\D"\n  ]\n}');
  });
});

describe('where the publisher tags name a mod folder (ADR-0028)', () => {
  const SETTINGS = '{\n  "Include": [ "MODS/a/", "mods\\\\A\\\\x.esp", "mods\\\\B" ],\n  "AlwaysEnabled": [ "mods\\\\A" ]\n}';
  const place = (line: number, start: number, end: number) => ({ file: join(root, SETTINGS_FILE), start: { line, character: start }, end: { line, character: end } });

  it('names the mod folder at its segment of each entry at or under it, in every list, and in no entry of another folder', async () => {
    await writeSettings(SETTINGS);

    const { references, leftOut } = await settingsNaming(publisherOver(), { kind: 'mod', name: 'A' }, heldTexts([]));

    expect(leftOut).toEqual([]);
    expect(references).toEqual([place(1, 21, 22), place(1, 33, 34), place(2, 28, 29)]);
  });

  it('reads the text the editor holds unsaved in place of the file, and names nothing in a configuration the instance lacks', async () => {
    expect((await settingsNaming(publisherOver(), { kind: 'mod', name: 'A' }, heldTexts([]))).references).toEqual([]);

    const { references } = await settingsNaming(publisherOver(), { kind: 'mod', name: 'A' }, heldTexts([[join(root, SETTINGS_FILE), '{"Ignore":["mods/A"]}']]));

    expect(references).toHaveLength(1);
  });

  it('says why a configuration it cannot read is left out', async () => {
    await writeSettings('{ not json');

    const { references, leftOut } = await settingsNaming(publisherOver(), { kind: 'mod', name: 'A' }, heldTexts([]));

    expect([references, leftOut]).toEqual([[], [expect.stringContaining(SETTINGS_FILE) as unknown]]);
  });

  const OTHER_PARENT = '{ "Include": [ "other\\\\A" ] }';
  const A_UNDER_MODS = SETTINGS.indexOf('"mods\\\\A\\\\x') + 7;
  it.each([
    ['the mod folder\'s segment', SETTINGS_FILE, SETTINGS, A_UNDER_MODS, { entry: { kind: 'mod', name: 'A' }, start: A_UNDER_MODS, end: A_UNDER_MODS + 1 }],
    ['no segment above the mod folder, which names no mod', SETTINGS_FILE, SETTINGS, A_UNDER_MODS - 4, undefined],
    ['no segment under a parent other than the mods folder', SETTINGS_FILE, OTHER_PARENT, OTHER_PARENT.indexOf('A'), undefined],
    ['no segment outside an entry', SETTINGS_FILE, SETTINGS, SETTINGS.indexOf('Include'), undefined],
    ['no segment in a file that is no configuration', 'notes.json', SETTINGS, A_UNDER_MODS, undefined],
  ])('says which folder\'s segment is under a place, as the entry spells it: %s', async (_case, name, text, offset, expected) => {
    expect(await publisherOver().entryReferences.nameAt(join(root, name), text, offset)).toEqual(expected);
  });
});

describe('where the compiler settings name a profile (ADR-0028)', () => {
  const SETTINGS = '{\n  "Profile": "Main",\n  "AdditionalProfiles": [ "Extra", "main" ]\n}';
  const place = (line: number, start: number, end: number) => ({ file: join(root, SETTINGS_FILE), start: { line, character: start }, end: { line, character: end } });
  const profile = (name: string) => ({ kind: 'profile', name }) as const;
  const settingsText = () => readFile(join(root, SETTINGS_FILE), 'utf8');

  it('names a profile, whatever its case, at the compile profile and at each additional profile', async () => {
    await writeSettings(SETTINGS);

    const { references, leftOut } = await settingsNaming(publisherOver(), profile('MAIN'), heldTexts([]));

    expect(leftOut).toEqual([]);
    expect(references).toEqual([place(1, 14, 18), place(2, 36, 40)]);
  });

  it('names no mod', async () => {
    await writeSettings(SETTINGS);

    expect((await settingsNaming(publisherOver(), { kind: 'mod', name: 'Main' }, heldTexts([]))).references).toEqual([]);
  });

  it('says why settings it cannot read are left out, naming the file first as every owner does', async () => {
    await writeSettings('{ not json');

    const { leftOut } = await settingsNaming(publisherOver(), profile('Main'), heldTexts([]));

    const file = join(root, SETTINGS_FILE);
    expect(leftOut).toEqual([`${file}: ${file} is not JSON: InvalidSymbol at line 1, column 3`]);
  });

  it.each([
    ['the compile profile', SETTINGS_FILE, SETTINGS.indexOf('Main') + 1, { entry: profile('Main'), start: SETTINGS.indexOf('Main'), end: SETTINGS.indexOf('Main') + 4 }],
    ['an additional profile', SETTINGS_FILE, SETTINGS.indexOf('Extra'), { entry: profile('Extra'), start: SETTINGS.indexOf('Extra'), end: SETTINGS.indexOf('Extra') + 5 }],
    ['no profile at a key', SETTINGS_FILE, SETTINGS.indexOf('Profile'), undefined],
    ['no profile in a file that is no configuration', 'notes.json', SETTINGS.indexOf('Main'), undefined],
  ])('says which profile is under a place: %s', async (_case, name, offset, expected) => {
    expect(await publisherOver().entryReferences.nameAt(join(root, name), SETTINGS, offset)).toEqual(expected);
  });

  it('follows a profile\'s rename at the compile profile and each additional profile, and leaves every other line as written', async () => {
    await writeSettings(SETTINGS);

    await publisherOver().renameProfile('Main', 'Renamed');

    expect(await settingsText()).toBe('{\n  "Profile": "Renamed",\n  "AdditionalProfiles": [ "Extra", "Renamed" ]\n}');
  });

  it('writes no settings the instance lacks', async () => {
    await publisherOver().renameProfile('Main', 'Renamed');

    await expect(settingsText()).rejects.toThrow();
  });
});
