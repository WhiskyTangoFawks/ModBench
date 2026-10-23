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

const writeSettings = (settings: unknown): Promise<void> =>
  writeFile(join(root, SETTINGS_FILE), typeof settings === 'string' ? settings : JSON.stringify(settings));

async function covering(...segments: string[]): Promise<string[]> {
  const configuration = await wabbajackPublisher(root).configuration();
  if (configuration.kind !== 'read') throw new Error(`expected read, got ${JSON.stringify(configuration)}`);
  return configuration.covering(join(root, ...segments)).map(({ name }) => name);
}

describe('Wabbajack as a publisher (publishing.md, Publishers, story 1)', () => {
  it('declares its four publisher tags, Always Enabled marking only mods and shipping a disabled one', () => {
    expect(wabbajackPublisher(root).tags).toEqual([
      { name: 'No Match Include', badge: 'NM', marksPaths: true, shipsDisabledMod: false },
      { name: 'Include', badge: 'IN', marksPaths: true, shipsDisabledMod: false },
      { name: 'Ignore', badge: 'IG', marksPaths: true, shipsDisabledMod: false },
      { name: 'Always Enabled', badge: 'AE', marksPaths: false, shipsDisabledMod: true },
    ]);
  });

  it('is no publisher while the instance holds no compiler settings', async () => {
    expect(await wabbajackPublisher(root).configuration()).toEqual({ kind: 'none' });
  });

  it('reads no publisher tag from a mod\'s metadata, where Wabbajack once kept them (Publisher tags, story 5)', async () => {
    await mkdir(join(root, 'mods', 'A'), { recursive: true });
    await writeFile(join(root, 'mods', 'A', 'meta.ini'), '[General]\nnotes=WABBAJACK_ALWAYS_ENABLE WABBAJACK_INCLUDE\n');
    expect(await wabbajackPublisher(root).configuration()).toEqual({ kind: 'none' });

    await writeSettings({ Include: [] });
    expect(await covering('mods', 'A')).toEqual([]);
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
    await writeSettings({ Ignore: ['MODS\\a'], NoMatchInclude: ['mods/B/'] });

    expect([await covering('mods', 'A', 'x.esp'), await covering('mods', 'B', 'x.esp')]).toEqual([['Ignore'], ['No Match Include']]);
  });

  it('gives a row each publisher tag that covers it once, in the order Wabbajack declares them', async () => {
    await writeSettings({ AlwaysEnabled: ['mods\\A'], Ignore: ['mods\\A\\x.esp', 'mods\\A'], NoMatchInclude: ['mods'] });

    expect([await covering('mods', 'A'), await covering('mods', 'A', 'x.esp')])
      .toEqual([['No Match Include', 'Ignore', 'Always Enabled'], ['No Match Include', 'Ignore', 'Always Enabled']]);
  });

  it('covers nothing outside the instance', async () => {
    await writeSettings({ Include: [''] });

    const configuration = await wabbajackPublisher(root).configuration();
    expect(configuration.kind === 'read' && [configuration.covering(join(root, 'a.dds')), configuration.covering(join(root, '..', 'a.dds'))].map((tags) => tags.length))
      .toEqual([1, 0]);
  });
});

describe('compiler settings Modbench cannot read (Never silently wrong)', () => {
  const reason = async (): Promise<string> => {
    const configuration = await wabbajackPublisher(root).configuration();
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

  it('says so when they are not an object', async () => {
    await writeSettings('[]');

    expect(await reason()).toContain(SETTINGS_FILE);
  });
});

describe('the watch on the compiler settings (ADR-0003)', () => {
  const live = () => watchers.filter((watcher) => !watcher.disposed);

  it('arms nothing until someone listens, hears the file created, changed or deleted at the instance root, and disarms when they leave', () => {
    const publisher = wabbajackPublisher(root);
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
