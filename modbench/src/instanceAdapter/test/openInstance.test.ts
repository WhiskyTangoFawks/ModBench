import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchers, fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { adapterOver } from '../../test/mo2/adapterOver';
import { cloneCorpusFixture } from '../../test/mo2/corpusFixture';
import { expectKind } from '../../test/expectKind';

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

  it('lists the files the mod manager\'s side keeps in the publisher\'s ignore list', async () => {
    await writeFile(join(root, SETTINGS_FILE), JSON.stringify({ Ignore: ['mine'] }));

    await adapterOver(root).keepOutOfPublisher();

    expect(JSON.parse(await readFile(join(root, SETTINGS_FILE), 'utf8'))).toEqual({ Ignore: expect.arrayContaining(['modbench', '.gitignore', 'source']) as unknown });
  });

  it.each([
    ['.env at the instance root when python.envFile names none', undefined, '.env'],
    ['the file python.envFile names', '${workspaceFolder}/config/py.env', 'config\\py.env'],
  ])('lists the script environment\'s file in the publisher\'s ignore list: %s', async (_name, setting, entry) => {
    await writeFile(join(root, SETTINGS_FILE), '{}');

    await adapterOver(root, { pythonEnvFile: setting }).keepOutOfPublisher();

    expect(JSON.parse(await readFile(join(root, SETTINGS_FILE), 'utf8'))).toEqual({ Ignore: expect.arrayContaining([entry]) as unknown });
  });

  it('lists nothing of a script environment\'s file outside the instance', async () => {
    await writeFile(join(root, SETTINGS_FILE), '{}');

    await adapterOver(root, { pythonEnvFile: join(tmpdir(), 'elsewhere.env') }).keepOutOfPublisher();

    const entries: unknown = Reflect.get(JSON.parse(await readFile(join(root, SETTINGS_FILE), 'utf8')), 'Ignore');
    expect(entries).toEqual(expect.not.arrayContaining([expect.stringContaining('elsewhere')]));
  });

  it('drops the entry of a manifest a rename left behind once update manifest keeps the files out again', async () => {
    const adapter = adapterOver(root);
    await writeFile(join(root, SETTINGS_FILE), '{}');
    await mkdir(join(root, 'mods', 'X'), { recursive: true });
    await writeFile(join(root, 'mods', 'X', 'X.manifest.json'), '{}');
    await adapter.keepOutOfPublisher();
    await rename(join(root, 'mods', 'X'), join(root, 'mods', 'Y'));
    await adapter.followModFolders([{ from: join(root, 'mods', 'X'), to: join(root, 'mods', 'Y') }]);
    await rm(join(root, 'mods', 'Y', 'X.manifest.json'));
    await writeFile(join(root, 'mods', 'Y', 'Y.manifest.json'), '{}');

    await adapter.keepOutOfPublisher();

    const entries: unknown = Reflect.get(JSON.parse(await readFile(join(root, SETTINGS_FILE), 'utf8')), 'Ignore');
    expect(entries).toEqual(expect.arrayContaining(['mods\\Y\\Y.manifest.json']));
    expect(entries).not.toContain('mods\\Y\\X.manifest.json');
  });

  it('hears a change to the publisher\'s configuration and to the mod manager\'s files alike, and neither once the listener leaves', () => {
    let signals = 0;
    const subscription = adapterOver(root).subscribe(() => { signals++; });
    const live = () => watchers.filter((watcher) => !watcher.disposed);
    const firedOn = (pattern: string): void => { live().find((watcher) => watcher.pattern === pattern)?.fireChange(); };

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
