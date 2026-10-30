import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeManifestIn, sourceManifestFile, writeManifestIn, writeSourceManifestIn, type Manifest } from '../manifestAdapter';
import { manifestText } from '../manifestText';

const manifest: Manifest = { packages: [], exclude: [], archives: [], steps: [], tools: [], files: [{ path: 'a.nif', entry: { kind: 'notHeld' } }] };

let root: string;
let folder: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'manifestFiles-'));
  folder = join(root, 'Mod');
  await mkdir(folder);
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('writeManifestIn', () => {
  it('writes the manifest named for the folder and says it wrote', async () => {
    const wrote = await writeManifestIn(folder, manifest);

    expect([wrote, await readFile(join(folder, 'Mod.manifest.json'), 'utf8'), await readdir(folder)]).toEqual([true, manifestText(manifest), ['Mod.manifest.json']]);
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
    await writeManifestIn(folder, { ...manifest, files: [{ path: 'meshes/café.nif', entry: { kind: 'notHeld' } }] });

    const bytes = await readFile(join(folder, 'Mod.manifest.json'));
    expect([bytes[0], bytes.toString('utf8')]).toEqual([0x7b, expect.stringContaining('café') as unknown]);
  });

  it('keeps the spelling of the manifest the folder holds, as the folder reads alike on Windows and Linux', async () => {
    await writeFile(join(folder, 'MOD.manifest.json'), '{}');

    const wrote = await writeManifestIn(folder, manifest);

    expect([wrote, await readdir(folder), await readFile(join(folder, 'MOD.manifest.json'), 'utf8')]).toEqual([true, ['MOD.manifest.json'], manifestText(manifest)]);
  });

  it('rejects, writing nothing, when the folder holds two manifests', async () => {
    await writeFile(join(folder, 'MOD.manifest.json'), '{}');
    await writeFile(join(folder, 'mod.manifest.json'), '{}');

    await expect(writeManifestIn(folder, manifest)).rejects.toThrow("its folder holds two manifests, 'MOD.manifest.json' and 'mod.manifest.json'");
  });

  it('rejects, making no folder, when the folder is not there', async () => {
    await expect(writeManifestIn(join(root, 'Gone'), manifest)).rejects.toThrow();

    expect(await readdir(root)).toEqual(['Mod']);
  });
});

describe('writeSourceManifestIn', () => {
  const built: Manifest = { ...manifest, output: 'Mod' };

  it('writes the manifest named for its output folder and says it wrote', async () => {
    const wrote = await writeSourceManifestIn(folder, built);

    expect([wrote, await readdir(folder), await readFile(join(folder, 'Mod.manifest.json'), 'utf8')]).toEqual([true, ['Mod.manifest.json'], manifestText(built)]);
  });

  it('writes nothing, and says so, when the manifest already holds that text', async () => {
    await writeFile(join(folder, 'Mod.manifest.json'), manifestText(built));

    expect(await writeSourceManifestIn(folder, built)).toBe(false);
  });

  it('replaces the manifest named for another output folder, as a rename of the output renames it', async () => {
    await writeFile(join(folder, 'Old.manifest.json'), manifestText({ ...built, output: 'Old' }));

    const wrote = await writeSourceManifestIn(folder, built);

    expect([wrote, await readdir(folder)]).toEqual([true, ['Mod.manifest.json']]);
  });

  it('renames a manifest whose name differs from its output folder\'s in case alone', async () => {
    await writeFile(join(folder, 'MOD.manifest.json'), manifestText(built));

    await writeSourceManifestIn(folder, built);

    expect(await readdir(folder)).toEqual(['Mod.manifest.json']);
  });

  it('rejects, writing nothing, a manifest that names no output folder', async () => {
    await expect(writeSourceManifestIn(folder, manifest)).rejects.toThrow('names no output folder');

    expect(await readdir(folder)).toEqual([]);
  });
});

describe('sourceManifestFile', () => {
  it('is the name and text the source mod\'s repository holds its manifest as', () => {
    expect(sourceManifestFile({ ...manifest, output: 'Mod' })).toEqual({ name: 'Mod.manifest.json', text: manifestText({ ...manifest, output: 'Mod' }) });
  });
});

describe('removeManifestIn', () => {
  it('removes the manifest named for the folder in any case, and leaves the rest', async () => {
    await writeFile(join(folder, 'MOD.manifest.json'), '{}');
    await writeFile(join(folder, 'a.nif'), 'a');

    await removeManifestIn(folder);

    expect(await readdir(folder)).toEqual(['a.nif']);
  });

  it('does nothing when the folder holds none', async () => {
    await removeManifestIn(folder);

    expect(await readdir(folder)).toEqual([]);
  });
});
