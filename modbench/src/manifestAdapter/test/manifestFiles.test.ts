import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILD_FILE } from '../../wire/sourceMod';
import { buildFileIn, buildFileText, manifestIn, writeManifestIn, type BuildFile, type Manifest } from '../manifestAdapter';
import { manifestText } from '../manifestText';

const manifest: Manifest = { packages: [], exclude: [], ignore: [], files: new Map([['a.nif', 'AAAAAAAAAAA=']]) };

let root: string;
let folder: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'manifestFiles-'));
  folder = join(root, 'Mod');
  await mkdir(folder);
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function holdingTwoManifestsThatDifferInCase(): Promise<void> {
  if (process.platform === 'win32') execFileSync('fsutil.exe', ['file', 'setCaseSensitiveInfo', folder, 'enable']);
  await writeFile(join(folder, 'MOD.manifest.json'), '{}');
  await writeFile(join(folder, 'mod.manifest.json'), '{}');
}

describe('manifestIn', () => {
  it('refuses a folder that holds two manifests, naming both', async () => {
    await holdingTwoManifestsThatDifferInCase();

    expect(await manifestIn(folder)).toEqual({ refused: "its folder holds two manifests, 'MOD.manifest.json' and 'mod.manifest.json'" });
  });

  it('reads the one manifest a folder renamed outside Modbench holds, under the name it had (source.md, Build, story 4)', async () => {
    await writeFile(join(folder, 'Old Name.manifest.json'), manifestText(manifest));

    expect(await manifestIn(folder)).toEqual({ manifest });
  });

  it('refuses a folder that holds manifests of two names, naming both', async () => {
    await writeFile(join(folder, 'Mod.manifest.json'), '{}');
    await writeFile(join(folder, 'Old Name.manifest.json'), '{}');

    expect(await manifestIn(folder)).toEqual({ refused: "its folder holds two manifests, 'Mod.manifest.json' and 'Old Name.manifest.json'" });
  });
});

describe('writeManifestIn', () => {
  it('writes the manifest named for the folder and says it wrote', async () => {
    const wrote = await writeManifestIn(folder, manifest);

    expect([wrote, await readFile(join(folder, 'Mod.manifest.json'), 'utf8'), await readdir(folder)]).toEqual([true, manifestText(manifest), ['Mod.manifest.json']]);
  });

  it('refuses, writing nothing, a manifest its schema refuses, with the reason the reader gives', async () => {
    const refused: Manifest = { ...manifest, packages: [{ kind: 'installationFile', name: 'M.7z', size: 1, hash: 'AAAAAAAAAAA=', host: { nexus: { game: 'fallout4', mod: 4, file: 0 } } }] };

    await expect(writeManifestIn(folder, refused)).rejects.toThrow(/cannot be read at its package 1/);
    expect(await readdir(folder)).toEqual([]);
  });

  it('writes nothing, and says so, when the manifest already holds that text', async () => {
    await writeFile(join(folder, 'Mod.manifest.json'), manifestText(manifest));
    const before = (await stat(join(folder, 'Mod.manifest.json'))).mtimeMs;

    const wrote = await writeManifestIn(folder, manifest);

    expect([wrote, (await stat(join(folder, 'Mod.manifest.json'))).mtimeMs]).toEqual([false, before]);
  });

  it('writes nothing when the manifest holds that text behind a byte order mark', async () => {
    await writeFile(join(folder, 'Mod.manifest.json'), `\uFEFF${manifestText(manifest)}`);

    const wrote = await writeManifestIn(folder, manifest);

    expect([wrote, (await readFile(join(folder, 'Mod.manifest.json'), 'utf8')).startsWith('\uFEFF')]).toEqual([false, true]);
  });

  it('writes no byte order mark, and keeps a non-ASCII name readable', async () => {
    await writeManifestIn(folder, { ...manifest, files: new Map([['meshes/café.nif', 'AAAAAAAAAAA=']]) });

    const bytes = await readFile(join(folder, 'Mod.manifest.json'));
    expect([bytes[0], bytes.toString('utf8')]).toEqual([0x7b, expect.stringContaining('café') as unknown]);
  });

  it('keeps the spelling of the manifest the folder holds, as the folder reads alike on Windows and Linux', async () => {
    await writeFile(join(folder, 'MOD.manifest.json'), '{}');

    const wrote = await writeManifestIn(folder, manifest);

    expect([wrote, await readdir(folder), await readFile(join(folder, 'MOD.manifest.json'), 'utf8')]).toEqual([true, ['MOD.manifest.json'], manifestText(manifest)]);
  });

  it('writes the manifest under the folder\'s name, and removes the one named as the folder was before a rename', async () => {
    await writeFile(join(folder, 'Old Name.manifest.json'), '{}');

    const wrote = await writeManifestIn(folder, manifest);

    expect([wrote, await readdir(folder), await readFile(join(folder, 'Mod.manifest.json'), 'utf8')]).toEqual([true, ['Mod.manifest.json'], manifestText(manifest)]);
  });

  it('rejects, writing nothing, when the folder holds two manifests', async () => {
    await holdingTwoManifestsThatDifferInCase();

    await expect(writeManifestIn(folder, manifest)).rejects.toThrow("its folder holds two manifests, 'MOD.manifest.json' and 'mod.manifest.json'");
  });

  it('rejects, making no folder, when the folder is not there', async () => {
    await expect(writeManifestIn(join(root, 'Gone'), manifest)).rejects.toThrow();

    expect(await readdir(root)).toEqual(['Mod']);
  });
});

describe('buildFileIn', () => {
  const buildFile: BuildFile = { steps: [{ kind: 'pack', archives: [{ path: 'a.ba2', files: ['a.nif'] }] }, { kind: 'task', task: 'Zip', args: [], page: 'https://example.com/zip' }] };

  it('reads the build file at the root of the repository, in any case', async () => {
    await writeFile(join(folder, BUILD_FILE.toUpperCase()), buildFileText(buildFile));

    expect(await buildFileIn(folder)).toEqual({ buildFile });
  });

  it('is none when the repository holds none, whatever manifest it holds', async () => {
    await writeFile(join(folder, 'Mod.manifest.json'), buildFileText(buildFile));

    expect(await buildFileIn(folder)).toBeUndefined();
  });

  it('refuses a repository that holds two build files, naming both', async () => {
    if (process.platform === 'win32') execFileSync('fsutil.exe', ['file', 'setCaseSensitiveInfo', folder, 'enable']);
    await writeFile(join(folder, BUILD_FILE.toUpperCase()), buildFileText(buildFile));
    await writeFile(join(folder, BUILD_FILE), buildFileText(buildFile));

    expect(await buildFileIn(folder)).toEqual({ refused: `its repository holds two build files, '${BUILD_FILE.toUpperCase()}' and '${BUILD_FILE}'` });
  });

  it('refuses a build file of the format before version 1, naming both versions', async () => {
    await writeFile(join(folder, BUILD_FILE), '{"files": []}');

    expect(await buildFileIn(folder)).toEqual({ refused: 'its build file is in a format before version 1, and Modbench reads only version 1' });
  });

  it('refuses a build file that holds exclusions, which the modlist holds', async () => {
    await writeFile(join(folder, BUILD_FILE), '{"version":1,"exclude":[]}');

    expect(await buildFileIn(folder)).toEqual({ refused: "its build file holds 'exclude', which Modbench does not read" });
  });
});
