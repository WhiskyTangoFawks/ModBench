import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, matchesGlob } from 'node:path';
import { watchers, fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { adapterOver } from '../../test/mo2/adapterOver';
import { cloneCorpusFixture } from '../../test/mo2/corpusFixture';
import { expectKind } from '../../test/expectKind';
import { heldTexts } from '../../symbolNames/symbolNames';

vi.mock('vscode', () => fakeVscodeModule());

const SETTINGS_FILE = 'compiler_settings.json';

describe('the Instance adapter the build composes: the mod manager\'s implementation beside the publisher\'s (ADR-0024)', () => {
  const root = cloneCorpusFixture();

  afterEach(async () => {
    watchers.length = 0;
    await rm(join(root, SETTINGS_FILE), { force: true });
    await rm(join(root, '.git'), { recursive: true, force: true });
    for (const mod of ['X', 'Y']) await rm(join(root, 'mods', mod), { recursive: true, force: true });
  });

  afterAll(() => rm(root, { recursive: true, force: true }));

  it('declares the publisher\'s tags, and reads its configuration in the same reading as the mod manager\'s files', async () => {
    await writeFile(join(root, SETTINGS_FILE), JSON.stringify({ Include: ['mods\\Harder VATS'] }));
    const adapter = adapterOver(root);

    const { profile, publisherConfiguration } = await adapter.reading();

    expect({
      declared: adapter.publisherTags.map(({ badge }) => badge),
      profile,
      covering: expectKind(publisherConfiguration, 'read').covering(join(root, 'mods', 'Harder VATS'), 'Harder VATS').map(({ badge }) => badge),
    }).toEqual({ declared: ['NM', 'IN', 'IG', 'AE'], profile: 'Default', covering: ['IN'] });
  });

  it('names a mod in the publisher\'s tags beside the mod manager\'s files, and says which mod an entry names at a place', async () => {
    const settings = '{ "Include": [ "mods\\\\Harder VATS\\\\x.esp" ] }';
    await writeFile(join(root, SETTINGS_FILE), settings);
    const adapter = adapterOver(root);
    const harder = { kind: 'mod', name: 'Harder VATS' } as const;

    const { references } = await adapter.entryReferences.read(harder, heldTexts([]));

    expect(references.map(({ file }) => file)).toContain(join(root, SETTINGS_FILE));
    const start = settings.indexOf('Harder');
    expect(await adapter.entryReferences.nameAt(join(root, SETTINGS_FILE), settings, start + 2)).toEqual({ entry: harder, start, end: start + 'Harder VATS'.length });
    expect(await adapter.entryReferences.nameAt(join(root, SETTINGS_FILE), settings, settings.indexOf('x.esp'))).toBeUndefined();
  });

  it('gives the publisher the mods its compile profiles enable, not the instance\'s selected profile', async () => {
    await mkdir(join(root, 'profiles', 'Compile'));
    await writeFile(join(root, 'profiles', 'Compile', 'modlist.txt'), '+Harder VATS\r\n');
    await writeFile(join(root, SETTINGS_FILE), JSON.stringify({ Profile: 'Secondary', AdditionalProfiles: ['Compile'], Include: ['mods'] }));

    const { activeProfile, publisherConfiguration } = { activeProfile: await adapterOver(root).activeProfile(), ...await adapterOver(root).reading() };
    const covering = (mod: string) => expectKind(publisherConfiguration, 'read').covering(join(root, 'mods', mod, 'x.esp'), mod).map(({ badge }) => badge);

    expect({ activeProfile, disabledInIt: covering('Harder VATS'), enabledInIt: covering('ENBoost - 12k') })
      .toEqual({ activeProfile: 'Default', disabledInIt: ['IN'], enabledInIt: [] });
  });

  it('gives the publisher the mod manager\'s Overwrite as a folder it never ships', async () => {
    await writeFile(join(root, SETTINGS_FILE), JSON.stringify({ Include: ['overwrite'] }));

    const { publisherConfiguration } = await adapterOver(root).reading();

    expect(expectKind(publisherConfiguration, 'read').covering(join(root, 'overwrite', 'x.ini'), undefined)).toEqual([]);
  });

  it('lists the files the mod manager\'s side keeps in the publisher\'s ignore list at a reading', async () => {
    await writeFile(join(root, SETTINGS_FILE), JSON.stringify({ Ignore: ['mine'] }));

    await adapterOver(root).reading();

    expect(JSON.parse(await readFile(join(root, SETTINGS_FILE), 'utf8'))).toEqual({ Ignore: expect.arrayContaining(['modbench', '.gitignore', 'source']) as unknown });
  });

  it('lists the script environment\'s file in the publisher\'s ignore list', async () => {
    await writeFile(join(root, SETTINGS_FILE), '{}');

    await adapterOver(root).reading();

    expect(JSON.parse(await readFile(join(root, SETTINGS_FILE), 'utf8'))).toEqual({ Ignore: expect.arrayContaining(['.env']) as unknown });
  });

  it('writes nothing at a reading once the list holds the files, so its own write starts no further write', async () => {
    await writeFile(join(root, SETTINGS_FILE), '{}');
    const adapter = adapterOver(root);
    await adapter.reading();
    const written = await stat(join(root, SETTINGS_FILE), { bigint: true });

    await adapter.reading();

    const again = await stat(join(root, SETTINGS_FILE), { bigint: true });
    expect([again.ino, again.mtimeNs]).toEqual([written.ino, written.mtimeNs]);
  });

  it('lists the files after a change to a publisher tag', async () => {
    await writeFile(join(root, SETTINGS_FILE), '{}');

    await adapterOver(root).changePublisherTag('add', 'Include', [join(root, 'mods', 'Harder VATS')]);

    expect(JSON.parse(await readFile(join(root, SETTINGS_FILE), 'utf8'))).toEqual({ Include: ['mods\\Harder VATS'], Ignore: expect.arrayContaining(['modbench', '.gitignore']) as unknown });
  });

  it('reads the configuration as unreadable, writing nothing, when the files cannot be listed in it', async () => {
    await writeFile(join(root, SETTINGS_FILE), 'not json');

    const { publisherConfiguration } = await adapterOver(root).reading();

    expect([publisherConfiguration.kind, await readFile(join(root, SETTINGS_FILE), 'utf8')]).toEqual(['unreadable', 'not json']);
  });

  it('drops the entry of a manifest a rename left behind at the next reading', async () => {
    const adapter = adapterOver(root);
    await writeFile(join(root, SETTINGS_FILE), '{}');
    await mkdir(join(root, 'mods', 'X'), { recursive: true });
    await writeFile(join(root, 'mods', 'X', 'X.manifest.json'), '{}');
    await adapter.reading();
    await rename(join(root, 'mods', 'X'), join(root, 'mods', 'Y'));
    await adapter.followModFolders([{ from: join(root, 'mods', 'X'), to: join(root, 'mods', 'Y') }]);
    await rm(join(root, 'mods', 'Y', 'X.manifest.json'));
    await writeFile(join(root, 'mods', 'Y', 'Y.manifest.json'), '{}');

    await adapter.reading();

    const entries: unknown = Reflect.get(JSON.parse(await readFile(join(root, SETTINGS_FILE), 'utf8')), 'Ignore');
    expect(entries).toEqual(expect.arrayContaining(['mods\\Y\\Y.manifest.json']));
    expect(entries).not.toContain('mods\\Y\\X.manifest.json');
  });

  it('hears a change to the publisher\'s configuration and to the mod manager\'s files alike, and neither once the listener leaves', () => {
    let signals = 0;
    const subscription = adapterOver(root).subscribe(() => { signals++; });
    const live = () => watchers.filter((watcher) => !watcher.disposed);
    const firedOn = (name: string): void => { live().find((watcher) => watcher.base === root && matchesGlob(name, watcher.pattern))?.fireChange(); };

    firedOn(SETTINGS_FILE);
    firedOn('ModOrganizer.ini');
    subscription.dispose();

    expect({ signals, armed: live().length }).toEqual({ signals: 2, armed: 0 });
  });

  it('has git hold the publisher\'s configuration by the path tokens, the output file each compile chooses blanked', async () => {
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    git('init', '--quiet');
    git('config', 'core.autocrlf', 'false');
    await writeFile(join(root, SETTINGS_FILE), JSON.stringify({ Source: root, OutputFile: join(root, 'LitR.wabbajack') }));

    await adapterOver(root).writePathTokens();
    git('add', '--', SETTINGS_FILE);

    expect(git('cat-file', 'blob', `:${SETTINGS_FILE}`)).toBe(JSON.stringify({ Source: '{instance folder}', OutputFile: '' }));
  });
});
