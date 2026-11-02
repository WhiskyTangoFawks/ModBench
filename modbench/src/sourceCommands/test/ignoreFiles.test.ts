import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifestIn, writeManifestIn, type Manifest } from '../../manifestAdapter/manifestAdapter';
import { fakeInstanceAdapter, modFoldersIn, readingFixture, repositoriesOf, type InstanceAnswers } from '../../test/fakeInstanceAdapter';
import { ignoreFiles, type FileToIgnore } from '../ignoreFiles';

const HA = 'AAAAAAAAAAA=';
const HB = 'BBBBBBBBBBA=';
const EMPTY: Manifest = { packages: [], exclude: [], ignore: [], flags: new Map(), files: new Map() };
const MEM = 'F4SE/Plugins/BetterConsole.mem';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ignoreFiles-'));
  await mkdir(join(root, 'mods', 'ModA'), { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

const fileOf = (mod: string, relativePath: string): FileToIgnore => ({ origin: { kind: 'mod', name: mod }, relativePath });

function over(held: Partial<Manifest> | undefined, files: Record<string, string>, sourceFolders: Record<string, string> = {}, answers: InstanceAnswers = {}) {
  const folder = join(root, 'mods', 'ModA');
  const fake = fakeInstanceAdapter(readingFixture({ modFolders: modFoldersIn(join(root, 'mods'), 'ModA'), sourceRepositories: repositoriesOf(sourceFolders) }), {
    folderFiles: new Map([[folder, Object.keys(files)]]),
    hashes: new Map(Object.entries(files).map(([path, hash]) => [join(folder, path), { size: 1, hash }] as const)),
    ...answers,
  });
  return {
    fake,
    run: async (files_: readonly FileToIgnore[], ignore: boolean) => {
      if (held !== undefined) await writeManifestIn(folder, { ...EMPTY, ...held });
      return ignoreFiles({ adapter: fake.adapter, client: new InMemoryMEditClient() }, files_, ignore);
    },
    manifest: async () => {
      const read = await manifestIn(folder);
      return read === undefined || 'refused' in read ? read : read.manifest;
    },
    ignoreOf: async () => {
      const read = await manifestIn(folder);
      return read === undefined || 'refused' in read ? undefined : read.manifest.ignore;
    },
  };
}

describe('ignore file', () => {
  it('names the file in its manifest and drops its line and the exclusion of it, recording nothing else', async () => {
    const { run, manifest } = over({ exclude: [MEM], files: new Map([[MEM, HB], ['a.nif', HA]]) }, { [MEM]: HB, 'a.nif': HA, 'b.nif': HB });

    const outcome = await run([fileOf('ModA', MEM)], true);

    expect(outcome).toEqual({ landed: [fileOf('ModA', MEM)], refused: [] });
    expect(await manifest()).toEqual({ ...EMPTY, ignore: [MEM], flags: new Map(), files: new Map([['a.nif', HA]]) });
  });

  it('refuses a mod with no manifest, naming it, and writes none', async () => {
    const { run, manifest } = over(undefined, { [MEM]: HB, 'a.nif': HA });

    const outcome = await run([fileOf('ModA', MEM)], true);

    expect([outcome.refused.map(({ reason }) => reason), await manifest()]).toEqual([['its mod has no manifest, so update manifest comes first'], undefined]);
  });

  it('refuses a file of Overwrite, naming why, and writes nothing', async () => {
    const { run, manifest } = over(undefined, {});
    const inOverwrite: FileToIgnore = { origin: { kind: 'runtimeOutput' }, relativePath: 'x.txt' };

    const outcome = await run([inOverwrite], true);

    expect([outcome, await manifest()]).toEqual([{ landed: [], refused: [{ item: inOverwrite, reason: 'Overwrite is not a mod.' }] }, undefined]);
  });
});

describe('ignore file, of a mod installed from an installation file', () => {
  it('records no package, since it records no file', async () => {
    const installed = { path: '/downloads/ModA.7z', size: 10, hash: 'HHHHHHHHHHA=', entries: [{ path: 'a.nif', hash: HA }] };
    const { run, manifest } = over({ files: new Map([['a.nif', HA]]) }, { [MEM]: HB, 'a.nif': HA }, {}, { installations: new Map([['ModA', { kind: 'read', answer: installed }]]) });

    await run([fileOf('ModA', MEM)], true);

    expect(await manifest()).toEqual({ ...EMPTY, ignore: [MEM], flags: new Map(), files: new Map([['a.nif', HA]]) });
  });
});

describe('unignore file', () => {
  it('removes the file from the ignore and records its line alone, not another changed file of the mod', async () => {
    const { run, manifest } = over({ ignore: [MEM, 'logs'], flags: new Map(), files: new Map([['a.nif', HA]]) }, { [MEM]: HB, 'a.nif': HB, 'new.nif': HA });

    const outcome = await run([fileOf('ModA', MEM)], false);

    expect(outcome.landed).toEqual([fileOf('ModA', MEM)]);
    expect(await manifest()).toEqual({ ...EMPTY, ignore: ['logs'], flags: new Map(), files: new Map([['a.nif', HA], [MEM, HB]]) });
  });

  it('removes the file from the ignore of a source mod\'s folder and records nothing, since its build records the folder', async () => {
    const built: Partial<Manifest> = { packages: [{ kind: 'repository', name: 'ModA' }], ignore: [MEM] };
    const { run, manifest, fake: { calls } } = over(built, { [MEM]: HB }, { ModA: join(root, 'source', 'ModA') });

    const outcome = await run([fileOf('ModA', MEM)], false);

    expect(outcome.landed).toEqual([fileOf('ModA', MEM)]);
    expect(await manifest()).toEqual({ ...EMPTY, packages: built.packages });
    expect(calls.filter(({ verb }) => verb === 'writeSubmodules')).toEqual([]);
  });

  it('refuses a file under an ignored folder, naming the folder, while its sibling with an entry of its own lands', async () => {
    const { run, manifest } = over({ ignore: ['logs', MEM] }, { 'logs/run.log': HB, [MEM]: HA });

    const outcome = await run([fileOf('ModA', 'logs/run.log'), fileOf('ModA', MEM)], false);

    expect([outcome.landed, outcome.refused.map(({ item, reason }) => [item.relativePath, reason])]).toEqual([
      [fileOf('ModA', MEM)], [['logs/run.log', "its manifest ignores 'logs', a folder above it"]],
    ]);
    expect(await manifest()).toEqual({ ...EMPTY, ignore: ['logs'], flags: new Map(), files: new Map([[MEM, HA]]) });
  });
});
