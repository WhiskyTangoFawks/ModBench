import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILD_FILE, PLUGIN_SOURCE_FOLDER } from '../../wire/sourceMod';
import { buildFileAgainst, buildFileIn, buildFileText, manifestFileFor, manifestIn, writeManifestIn, type BuildFile, type Manifest } from '../manifestAdapter';
import { manifestText } from '../manifestText';
import { writeBuildFile } from '../../test/buildFiles';

const manifest: Manifest = { packages: [], exclude: [], ignore: [], flags: new Map(), files: new Map([['a.nif', 'AAAAAAAAAAA=']]) };

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

  it('lands two writes into one folder at once, leaving one of them and no temp', async () => {
    const other: Manifest = { ...manifest, files: new Map([['b.nif', 'AQAAAAAAAAA=']]) };

    const wrote = await Promise.all([writeManifestIn(folder, manifest), writeManifestIn(folder, other)]);

    expect([wrote, await readdir(folder)]).toEqual([[true, true], ['Mod.manifest.json']]);
    expect([manifestText(manifest), manifestText(other)]).toContain(await readFile(join(folder, 'Mod.manifest.json'), 'utf8'));
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

describe('manifestFileFor', () => {
  it('names the file for the folder when it holds no manifest', async () => {
    expect(await manifestFileFor(folder, manifest)).toEqual({ name: 'Mod.manifest.json', text: manifestText(manifest) });
  });

  it('names the manifest the folder holds, whatever its name, so the folder holds one manifest once it is written', async () => {
    await writeFile(join(folder, 'Old Name.manifest.json'), '{}');

    expect(await manifestFileFor(folder, manifest)).toEqual({ name: 'Old Name.manifest.json', text: manifestText(manifest) });
  });

  it('rejects when the folder holds two manifests', async () => {
    await holdingTwoManifestsThatDifferInCase();

    await expect(manifestFileFor(folder, manifest)).rejects.toThrow("its folder holds two manifests, 'MOD.manifest.json' and 'mod.manifest.json'");
  });

  it('rejects a manifest its schema refuses, with the reason the reader gives', async () => {
    const refused: Manifest = { ...manifest, packages: [{ kind: 'installationFile', name: 'M.7z', size: 1, hash: 'AAAAAAAAAAA=', host: { nexus: { game: 'fallout4', mod: 4, file: 0 } } }] };

    await expect(manifestFileFor(folder, refused)).rejects.toThrow(/cannot be read at its package 1/);
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

describe('buildFileAgainst', () => {
  const holding = async (paths: readonly string[]): Promise<void> => {
    for (const path of paths) {
      await mkdir(join(folder, path, '..'), { recursive: true });
      await writeFile(join(folder, path), '');
    }
  };
  const building = (steps: BuildFile['steps']) => writeBuildFile(folder, { steps });
  const file = () => join(folder, BUILD_FILE);

  it('names each path a step reads from the source folder that names nothing there, by its step', async () => {
    await holding(['textures/a.dds', 'Held.ba2', 'Held.esp', `${PLUGIN_SOURCE_FOLDER}/Built.esp/npc_/1.json`, 'scripts/held.py']);
    await building([
      { kind: 'copy', paths: ['textures', 'meshes'] },
      { kind: 'unpack', archives: [{ path: 'Held.ba2', files: ['a.nif'] }, { path: 'Gone.ba2', files: ['b.nif'] }] },
      { kind: 'decompile', paths: ['Held.esp', 'Gone.esp'] },
      { kind: 'compile', paths: ['Built.esp', 'Renamed.esp'] },
      { kind: 'pack', archives: [{ path: 'Packed.ba2', files: ['made.nif'] }] },
      { kind: 'script', script: 'scripts/held.py', args: [] },
      { kind: 'script', script: 'scripts/gone.py', args: [] },
      { kind: 'task', task: 'Zip', args: ['out.zip'] },
    ]);

    expect(await buildFileAgainst(folder)).toEqual({
      file: file(),
      lacks: [
        { step: 'copy', path: 'meshes' }, { step: 'unpack', path: 'Gone.ba2' }, { step: 'decompile', path: 'Gone.esp' },
        { step: 'compile', path: 'Renamed.esp' }, { step: 'script', path: 'scripts/gone.py' },
      ],
      unreadable: [],
    });
  });

  it.each<[string, readonly string[], BuildFile['steps']]>([
    ['in any case, as mEdit does', [`${PLUGIN_SOURCE_FOLDER}/built.esp/npc_/1.json`], [{ kind: 'compile', paths: ['Built.esp'] }]],
    ['in a decompile step before it', ['Built.esp'], [{ kind: 'decompile', paths: ['Built.esp'] }, { kind: 'compile', paths: ['Built.esp'] }]],
  ])('finds a compiled plugin\'s plugin source %s', async (_where, held, steps) => {
    await holding(held);
    await building(steps);

    expect(await buildFileAgainst(folder)).toEqual({ file: file(), lacks: [], unreadable: [] });
  });

  it('says why a build file it cannot read is unreadable, and names no lack', async () => {
    await writeFile(file(), '{"files": []}');

    expect(await buildFileAgainst(folder)).toEqual({
      file: file(), lacks: [], unreadable: ['its build file is in a format before version 1, and Modbench reads only version 1'],
    });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('(Windows has no POSIX mode bits, and root reads every file) says which plugin sources and paths it cannot read, and names none of them as lacking', async () => {
    await holding(['locked/a.nif', `${PLUGIN_SOURCE_FOLDER}/Built.esp/npc_/1.json`]);
    await building([{ kind: 'copy', paths: ['locked/a.nif'] }, { kind: 'compile', paths: ['Built.esp'] }]);
    await chmod(join(folder, 'locked'), 0o000);
    await chmod(join(folder, PLUGIN_SOURCE_FOLDER), 0o000);

    try {
      expect(await buildFileAgainst(folder)).toEqual({
        file: file(), lacks: [],
        unreadable: [expect.stringMatching(/^its plugin sources could not be read: .*EACCES/), expect.stringMatching(/^'locked\/a\.nif' could not be read: .*EACCES/)],
      });
    } finally {
      await chmod(join(folder, 'locked'), 0o755);
      await chmod(join(folder, PLUGIN_SOURCE_FOLDER), 0o755);
    }
  });

  it('is none when the source folder holds no build file', async () => {
    expect(await buildFileAgainst(folder)).toBeUndefined();
  });
});
