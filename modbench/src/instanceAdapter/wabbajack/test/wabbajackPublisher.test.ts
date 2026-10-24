import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchers, fakeVscodeModule } from '../../../test/mo2/fakeVscodeWatcher';
import { wabbajackPublisher } from '../wabbajackPublisher';

vi.mock('vscode', () => fakeVscodeModule());

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'modbench-wabbajack-'));
});

afterEach(async () => {
  watchers.length = 0;
  await rm(root, { recursive: true, force: true });
});

const SETTINGS_FILE = 'compiler_settings.json';

const NEVER_SHIPPED = 'Runtime Output';

const ENABLED_BY_PROFILE: Record<string, readonly string[]> = { Main: ['Enabled'], Extra: ['enabled elsewhere'] };

const publisherOver = () => wabbajackPublisher(root, {
  neverShipped: [join(root, NEVER_SHIPPED)],
  enabledMods: (profile) => {
    const enabled = ENABLED_BY_PROFILE[profile];
    return enabled === undefined ? Promise.reject(new Error(`no profile ${profile}`)) : Promise.resolve(enabled);
  },
});

const writeSettings = (settings: unknown): Promise<void> =>
  writeFile(join(root, SETTINGS_FILE), typeof settings === 'string' ? settings : JSON.stringify(settings));

async function covering(...segments: string[]): Promise<string[]> {
  const configuration = await publisherOver().configuration();
  if (configuration.kind !== 'read') throw new Error(`expected read, got ${JSON.stringify(configuration)}`);
  return configuration.covering(join(root, ...segments), segments[0] === 'mods' ? segments[1] : undefined).map(({ name }) => name);
}

describe('Wabbajack as a publisher (publishing.md, Publishers, story 1)', () => {
  it('declares its four publisher tags, Always Enabled marking only mods', () => {
    expect(publisherOver().tags).toEqual([
      { name: 'No Match Include', badge: 'NM', marksPaths: true },
      { name: 'Include', badge: 'IN', marksPaths: true },
      { name: 'Ignore', badge: 'IG', marksPaths: true },
      { name: 'Always Enabled', badge: 'AE', marksPaths: false },
    ]);
  });

  it('is no publisher while the instance holds no compiler settings', async () => {
    expect(await publisherOver().configuration()).toEqual({ kind: 'none' });
  });

  it('reads no publisher tag from a mod\'s metadata, where Wabbajack once kept them (Publisher tags, story 5)', async () => {
    await mkdir(join(root, 'mods', 'A'), { recursive: true });
    await writeFile(join(root, 'mods', 'A', 'meta.ini'), '[General]\nnotes=WABBAJACK_ALWAYS_ENABLE WABBAJACK_INCLUDE\n');
    expect(await publisherOver().configuration()).toEqual({ kind: 'none' });

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

    const configuration = await publisherOver().configuration();
    expect(configuration.kind === 'read' && [configuration.covering(join(root, 'a.dds'), undefined), configuration.covering(join(root, '..', 'a.dds'), undefined)]
      .map((tags) => tags.length)).toEqual([1, 0]);
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
      Include: [NEVER_SHIPPED, 'Runtime Output2'], NoMatchInclude: [`${NEVER_SHIPPED}\\F4SE`], Ignore: [`${NEVER_SHIPPED}\\F4SE\\x.ini`], AlwaysEnabled: [NEVER_SHIPPED],
    });

    expect([
      await covering(NEVER_SHIPPED), await covering('runtime output', 'F4SE'), await covering(NEVER_SHIPPED, 'F4SE', 'x.ini'), await covering('Runtime Output2', 'a'),
    ]).toEqual([[], [], ['Ignore'], ['Include']]);
  });

  it('leaves every other path as the publisher tags that cover it say', async () => {
    await writeSettings({ Include: ['mods'] });

    expect(await covering('mods', 'A')).toEqual(['Include']);
  });
});

describe('compiler settings Modbench cannot read (Never silently wrong)', () => {
  const reason = async (): Promise<string> => {
    const configuration = await publisherOver().configuration();
    return configuration.kind === 'unreadable' ? configuration.reason : `not unreadable: ${configuration.kind}`;
  };

  it('says so, naming the file, when they are not JSON', async () => {
    await writeSettings('{ "Include": [');

    expect(await reason()).toContain(join(root, SETTINGS_FILE));
  });

  it.each([
    ['a list that holds other than paths', { Include: ['mods\\A', 3] }, 'Include'],
    ['other than a list', { Ignore: 'mods\\A' }, 'Ignore'],
  ])('says so, naming the file and its key, when a publisher tag holds %s', async (_, settings, key) => {
    await writeSettings(settings);

    expect(await reason()).toMatch(new RegExp(`${SETTINGS_FILE}.*${key}`));
  });

  it.each([
    ['a compile profile other than a name', { Profile: 3 }, 'Profile'],
    ['compile profiles other than names', { Profile: 'Main', AdditionalProfiles: 'Extra' }, 'AdditionalProfiles'],
  ])('says so, naming the file and its key, when they hold %s', async (_, settings, key) => {
    await writeSettings(settings);

    expect(await reason()).toMatch(new RegExp(`${SETTINGS_FILE}.*${key}`));
  });

  it('says so, with the mod manager\'s reason, when a compile profile\'s mods cannot be read', async () => {
    await writeSettings({ Profile: 'Gone' });

    expect(await reason()).toContain('no profile Gone');
  });

  it('says so when they are not an object', async () => {
    await writeSettings('[]');

    expect(await reason()).toContain(SETTINGS_FILE);
  });
});

describe('the publisher tags the configuration lists on a path (publishing.md, Publisher tags, story 2: what remove takes away)', () => {
  const listed = async (...segments: string[]): Promise<string[]> => {
    const configuration = await publisherOver().configuration();
    if (configuration.kind !== 'read') throw new Error(`expected read, got ${JSON.stringify(configuration)}`);
    return configuration.listed(join(root, ...segments)).map(({ name }) => name);
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

    const refused = await publisherOver().changeTag('add', 'Ignore', [join(root, 'mods', 'B', 'x.esp')]);

    expect({ refused, settings: await settings() })
      .toEqual({ refused: [], settings: { OutputFile: 'C:\\out\\list.wabbajack', Include: ['mods\\A'], Ignore: ['mods\\B\\x.esp'] } });
  });

  it('writes nothing for a path the tag already names, however it is spelled', async () => {
    const text = '{"Include":["MODS/a/"]}';
    await writeSettings(text);

    const refused = await publisherOver().changeTag('add', 'Include', [join(root, 'mods', 'A')]);

    expect({ refused, text: await settingsText() }).toEqual({ refused: [], text });
  });

  it('removes the entry that names the path, whatever its spelling, and leaves the other entries', async () => {
    await writeSettings({ Include: ['MODS/a/', 'mods\\B'] });

    const refused = await publisherOver().changeTag('remove', 'Include', [join(root, 'mods', 'A')]);

    expect(refused).toEqual([]);
    expect(await settings()).toMatchObject({ Include: ['mods\\B'] });
  });

  it('refuses a path outside the instance and lands the rest', async () => {
    await writeSettings({ Include: ['mods\\A'] });
    const outside = join(root, '..', 'elsewhere');

    const refused = await publisherOver().changeTag('remove', 'Include', [outside, join(root, 'mods', 'A')]);

    expect(refused).toEqual([{ path: outside, reason: 'It is outside the instance.' }]);
    expect(await settings()).toMatchObject({ Include: [] });
  });

  it('removes nothing, writes nothing and refuses nothing for a path the tag does not name, though a path above it does', async () => {
    const text = '{"Include":["mods\\\\A"]}';
    await writeSettings(text);

    const refused = await publisherOver().changeTag('remove', 'Include', [join(root, 'mods', 'A', 'x.esp'), join(root, 'mods', 'B')]);

    expect({ refused, text: await settingsText() }).toEqual({ refused: [], text });
  });

  it('keeps the file\'s indentation, line ends and final newline', async () => {
    await writeSettings('{\r\n    "Include": [\r\n        "mods\\\\A"\r\n    ]\r\n}\r\n');

    await publisherOver().changeTag('add', 'Include', [join(root, 'mods', 'B')]);

    expect(await settingsText()).toBe('{\r\n    "Include": [\r\n        "mods\\\\A",\r\n        "mods\\\\B"\r\n    ]\r\n}\r\n');
  });

  it('rejects, writing nothing, for a tag it does not declare, and for settings it cannot read', async () => {
    await writeSettings('{"Include":[]}');
    await expect(publisherOver().changeTag('add', 'Nope', [join(root, 'mods', 'A')])).rejects.toThrow('Nope');
    await writeSettings('not json');
    await expect(publisherOver().changeTag('add', 'Include', [join(root, 'mods', 'A')])).rejects.toThrow(SETTINGS_FILE);
    expect(await settingsText()).toBe('not json');
  });

  it('rejects while the instance holds no compiler settings, creating none', async () => {
    await expect(publisherOver().changeTag('add', 'Include', [join(root, 'mods', 'A')])).rejects.toThrow(SETTINGS_FILE);
    await expect(readFile(join(root, SETTINGS_FILE), 'utf8')).rejects.toThrow();
  });
});

describe('publisher tags following a mod folder (publishing.md, Publisher tags, story 3)', () => {
  const settingsText = () => readFile(join(root, SETTINGS_FILE), 'utf8');
  const folder = (name: string) => join(root, 'mods', name);

  it('moves every entry at or under the old folder to the new one, in every list, keeping the rest of each path and the other entries', async () => {
    await writeSettings({ Include: ['MODS/a/', 'mods\\A\\Textures\\x.dds', 'mods\\B'], Ignore: ['mods\\a\\x.esp'], AlwaysEnabled: ['mods\\A'] });

    await publisherOver().followFolders([{ from: folder('A'), to: folder('C') }]);

    expect(JSON.parse(await settingsText())).toEqual({
      Include: ['mods\\C', 'mods\\C\\Textures\\x.dds', 'mods\\B'], Ignore: ['mods\\C\\x.esp'], AlwaysEnabled: ['mods\\C'],
    });
  });

  it('removes every entry at or under the folder when the mod has no new one', async () => {
    await writeSettings({ Include: ['mods\\A', 'mods\\A\\x.esp', 'mods\\AB'], Ignore: ['mods\\B'] });

    await publisherOver().followFolders([{ from: folder('A') }, { from: folder('B') }]);

    expect(JSON.parse(await settingsText())).toEqual({ Include: ['mods\\AB'], Ignore: [] });
  });

  it('leaves a duplicate the move does not touch beside the entries it moves', async () => {
    await writeSettings({ Include: ['mods\\X', 'mods/x', 'mods\\A'] });

    await publisherOver().followFolders([{ from: folder('A'), to: folder('C') }]);

    expect(JSON.parse(await settingsText())).toEqual({ Include: ['mods\\X', 'mods/x', 'mods\\C'] });
  });

  it('lists an entry once when the new folder already has it', async () => {
    await writeSettings({ Include: ['mods\\A', 'mods\\C'] });

    await publisherOver().followFolders([{ from: folder('A'), to: folder('C') }]);

    expect(JSON.parse(await settingsText())).toEqual({ Include: ['mods\\C'] });
  });

  it('writes nothing when no entry is under the folder', async () => {
    const text = '{"Include":["mods\\\\B"]}';
    await writeSettings(text);

    await publisherOver().followFolders([{ from: folder('A'), to: folder('C') }]);

    expect(await settingsText()).toBe(text);
  });

  it('rejects, writing nothing, for settings it cannot read', async () => {
    await writeSettings('not json');
    await expect(publisherOver().followFolders([{ from: folder('A') }])).rejects.toThrow(SETTINGS_FILE);
    expect(await settingsText()).toBe('not json');
  });

  it('writes nothing when the settings hold a duplicate the move does not touch', async () => {
    const text = '{"Include":["mods\\\\X","mods/x","mods\\\\B"]}';
    await writeSettings(text);

    await publisherOver().followFolders([{ from: folder('A'), to: folder('C') }]);

    expect(await settingsText()).toBe(text);
  });

  it('does nothing while the instance holds no compiler settings, creating none', async () => {
    await publisherOver().followFolders([{ from: folder('A'), to: folder('C') }]);
    await expect(readFile(join(root, SETTINGS_FILE), 'utf8')).rejects.toThrow();
  });
});

describe('keeping Modbench\'s files out of what Wabbajack ships (publishing.md, What ships, story 1)', () => {
  const settingsText = () => readFile(join(root, SETTINGS_FILE), 'utf8');

  it('lists each file in Ignore, after the entries already there, in every other list left as written', async () => {
    await writeSettings({ Include: ['mods\\A'], Ignore: ['mine'] });

    await publisherOver().keepOut([join(root, '.gitignore'), join(root, 'mods', 'A', 'A.manifest.json')]);

    expect(JSON.parse(await settingsText())).toEqual({ Include: ['mods\\A'], Ignore: ['mine', '.gitignore', 'mods\\A\\A.manifest.json'] });
  });

  it('writes nothing for a file an entry already lists, however it is spelled, or an ignored folder holds', async () => {
    const text = '{"Ignore":["HASH-INDEX/","mods/a/A.MANIFEST.json"]}';
    await writeSettings(text);

    await publisherOver().keepOut([join(root, 'hash-index'), join(root, 'mods', 'A', 'A.manifest.json'), join(root, 'hash-index', 'x', 'y')]);

    expect(await settingsText()).toBe(text);
  });

  it('skips a file outside the instance', async () => {
    const text = '{"Ignore":[]}';
    await writeSettings(text);

    await publisherOver().keepOut([join(root, '..', 'elsewhere')]);

    expect(await settingsText()).toBe(text);
  });

  it('rejects, writing nothing, for settings it cannot read', async () => {
    await writeSettings('not json');
    await expect(publisherOver().keepOut([join(root, 'x')])).rejects.toThrow(SETTINGS_FILE);
    expect(await settingsText()).toBe('not json');
  });

  it('does nothing while the instance holds no compiler settings, creating none', async () => {
    await publisherOver().keepOut([join(root, 'x')]);
    await expect(settingsText()).rejects.toThrow();
  });
});

describe('the watch on the compiler settings (ADR-0003)', () => {
  const live = () => watchers.filter((watcher) => !watcher.disposed);

  it('arms nothing until someone listens, hears the file created, changed or deleted at the instance root, and disarms when they leave', () => {
    const publisher = publisherOver();
    const armedBefore = live().length;
    let signals = 0;
    const subscription = publisher.subscribe(() => { signals++; });
    const [watcher] = live();

    watcher?.fireCreate(join(root, SETTINGS_FILE));
    watcher?.fireChange(join(root, SETTINGS_FILE));
    watcher?.fireDelete(join(root, SETTINGS_FILE));
    subscription.dispose();

    expect({ armedBefore, signals, watched: [watcher?.base, watcher?.pattern], armedAfter: live().length })
      .toEqual({ armedBefore: 0, signals: 3, watched: [root, SETTINGS_FILE], armedAfter: 0 });
  });
});
