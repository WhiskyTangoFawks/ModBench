import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
