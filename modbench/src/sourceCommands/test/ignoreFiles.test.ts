import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifestIn, writeManifestIn, type Manifest } from '../../manifestAdapter/manifestAdapter';
import { fakeInstanceAdapter, modFoldersIn, readingFixture } from '../../test/fakeInstanceAdapter';
import { ignoreFiles } from '../ignoreFiles';

const HA = 'AAAAAAAAAAA=';
const HB = 'BBBBBBBBBBA=';
const EMPTY: Manifest = { packages: [], exclude: [], ignore: [], files: new Map() };
const MEM = 'F4SE/Plugins/BetterConsole.mem';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ignoreFiles-'));
  await mkdir(join(root, 'mods', 'ModA'), { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

const fileOf = (mod: string, relativePath: string) => ({ origin: { kind: 'mod' as const, name: mod }, relativePath });

function over(held: Partial<Manifest> | undefined, files: Record<string, string>) {
  const folder = join(root, 'mods', 'ModA');
  const fake = fakeInstanceAdapter(readingFixture({ modFolders: modFoldersIn(join(root, 'mods'), 'ModA') }), {
    folderFiles: new Map([[folder, Object.keys(files)]]),
    hashes: new Map(Object.entries(files).map(([path, hash]) => [join(folder, path), { size: 1, hash }] as const)),
  });
  return {
    run: async (files_: readonly ReturnType<typeof fileOf>[], ignore: boolean) => {
      if (held !== undefined) await writeManifestIn(folder, { ...EMPTY, ...held });
      return ignoreFiles({ adapter: fake.adapter }, files_, ignore);
    },
    manifest: async () => {
      const read = await manifestIn(folder);
      return read === undefined || 'refused' in read ? read : read.manifest;
    },
  };
}

describe('ignore file', () => {
  it('names the file in its manifest, drops its line and the exclusion of it, and records the rest', async () => {
    const { run, manifest } = over({ exclude: [MEM], files: new Map([[MEM, HB], ['a.nif', HA]]) }, { [MEM]: HB, 'a.nif': HA, 'b.nif': HB });

    const outcome = await run([fileOf('ModA', MEM)], true);

    expect(outcome).toEqual({ landed: [fileOf('ModA', MEM)], refused: [] });
    expect(await manifest()).toEqual({ ...EMPTY, ignore: [MEM], files: new Map([['a.nif', HA], ['b.nif', HB]]) });
  });

  it('creates the manifest of a mod that has none', async () => {
    const { run, manifest } = over(undefined, { [MEM]: HB, 'a.nif': HA });

    await run([fileOf('ModA', MEM)], true);

    expect(await manifest()).toEqual({ ...EMPTY, ignore: [MEM], files: new Map([['a.nif', HA]]) });
  });

  it('refuses a file of Overwrite, naming why, and writes nothing', async () => {
    const { run, manifest } = over(undefined, {});
    const inOverwrite = { origin: { kind: 'runtimeOutput' as const }, relativePath: 'x.txt' };

    const outcome = await run([inOverwrite as never], true);

    expect([outcome, await manifest()]).toEqual([{ landed: [], refused: [{ item: inOverwrite, reason: 'Overwrite is not a mod.' }] }, undefined]);
  });
});

describe('unignore file', () => {
  it('removes the file from the ignore and records it', async () => {
    const { run, manifest } = over({ ignore: [MEM, 'logs'] }, { [MEM]: HB });

    const outcome = await run([fileOf('ModA', MEM)], false);

    expect(outcome.landed).toEqual([fileOf('ModA', MEM)]);
    expect(await manifest()).toEqual({ ...EMPTY, ignore: ['logs'], files: new Map([[MEM, HB]]) });
  });

  it('refuses a file under an ignored folder, naming the folder', async () => {
    const { run, manifest } = over({ ignore: ['logs'] }, { 'logs/run.log': HB });

    const outcome = await run([fileOf('ModA', 'logs/run.log')], false);

    expect([outcome.refused.map(({ reason }) => reason), (await manifest() as Manifest).ignore]).toEqual([["its manifest ignores 'logs', a folder above it"], ['logs']]);
  });
});
