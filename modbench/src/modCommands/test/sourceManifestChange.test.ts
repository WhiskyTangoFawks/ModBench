import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceManifestIn, writeSourceManifestIn, type Manifest } from '../../manifestAdapter/manifestAdapter';
import { changeSourceManifest } from '../sourceManifestChange';

const MARK = '.excluded';
const PACK = { kind: 'installationFile', name: 'Pack-1.0.zip', size: 10, hash: 'hash' } as const;
const BUILT: Manifest = {
  packages: [{ kind: 'sourceRepository', name: 'Mod', isSubmodule: true }], version: '1.0', output: 'Old Name',
  exclude: [], archives: [{ path: 'Mod - Main.ba2', files: ['meshes/a.nif'] }], steps: [], tools: [], files: [{ path: 'Mod.esp', entry: { kind: 'held' } }],
};

let source: string;

beforeEach(async () => { source = await mkdtemp(join(tmpdir(), 'source-manifest-')); });
afterEach(() => rm(source, { recursive: true, force: true }));

const held = async (): Promise<Manifest> => {
  const read = await sourceManifestIn(source);
  if (read === undefined || 'refused' in read) throw new Error('no manifest');
  return read.manifest;
};

const excluding = (exclude: readonly string[], include: readonly string[] = []) => ({ exclude, include, exclusionMark: MARK });

describe('changeSourceManifest', () => {
  it('names the folder with a new output, keeping all else the manifest says', async () => {
    await writeSourceManifestIn(source, BUILT);

    expect(await changeSourceManifest(source, { output: 'New Name' })).toBeUndefined();

    expect([await readdir(source), await held()]).toEqual([['New Name.manifest.json'], { ...BUILT, output: 'New Name' }]);
  });

  it.each([
    [[], ['textures/b.dds', 'meshes'], [], ['meshes', 'textures/b.dds']],
    [['textures/b.dds'], ['Textures/B.dds', 'a.esp', 'Z.esp'], [], ['a.esp', 'textures/b.dds', 'Z.esp']],
    [['a.esp', 'textures/b.dds'], [], ['Textures/B.dds'], ['a.esp']],
    [['a.esp'], [], ['a.esp', 'never.esp'], []],
  ])('adds or removes an exclusion by path without case: %j, excluding %j and including %j', async (before, exclude, include, after) => {
    await writeSourceManifestIn(source, { ...BUILT, exclude: before });

    expect(await changeSourceManifest(source, excluding(exclude, include))).toBeUndefined();

    expect((await held()).exclude).toEqual(after);
  });

  it.each([
    ['textures/a.txt', 'textures/a.txt.excluded'],
    ['textures', 'textures.excluded/a.txt'],
  ])('moves the line of a taken file to where the folder holds it once %s is excluded, keeping its path in its package', async (excluded, lineAt) => {
    await writeSourceManifestIn(source, { ...BUILT, packages: [PACK], files: [{ path: 'textures/a.txt', entry: { kind: 'held' } }] });

    await changeSourceManifest(source, excluding([excluded]));

    expect((await held()).files).toEqual([{ path: lineAt, entry: { kind: 'heldAt', path: 'textures/a.txt' } }]);
  });

  it('moves the line of a taken file back to its own path once it is included', async () => {
    await writeSourceManifestIn(source, {
      ...BUILT, packages: [PACK], exclude: ['textures/a.txt'], files: [{ path: 'textures/a.txt.excluded', entry: { kind: 'heldAt', path: 'textures/a.txt' } }],
    });

    await changeSourceManifest(source, excluding([], ['textures/a.txt']));

    expect((await held()).files).toEqual([{ path: 'textures/a.txt', entry: { kind: 'held' } }]);
  });

  it('moves the line of a built file with the folder, excluded and included again', async () => {
    await writeSourceManifestIn(source, { ...BUILT, archives: [], files: [{ path: 'textures/a.dds', entry: { kind: 'held' } }] });

    await changeSourceManifest(source, excluding(['textures/a.dds']));
    const excluded = (await held()).files.map(({ path }) => path);
    await changeSourceManifest(source, excluding([], ['textures/a.dds']));
    const included = (await held()).files.map(({ path }) => path);

    expect([excluded, included]).toEqual([['textures/a.dds.excluded'], ['textures/a.dds']]);
  });

  it('refuses a repository that holds no manifest, naming it, and writes none', async () => {
    expect(await changeSourceManifest(source, { output: 'Other' })).toBe(`"${source}" holds no manifest.`);

    expect(await readdir(source)).toEqual([]);
  });

  it('refuses a manifest that does not read, naming why, and leaves it as it was', async () => {
    await writeFile(join(source, 'Mod.manifest.json'), '{"output": ');

    expect(await changeSourceManifest(source, { output: 'Other' })).toMatch(new RegExp(`^The source mod in "${source}" was not changed: `));

    expect(await readFile(join(source, 'Mod.manifest.json'), 'utf8')).toBe('{"output": ');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('refuses a manifest the disk will not let be written, and leaves it as it was', async () => {
    await writeSourceManifestIn(source, BUILT);
    await chmod(source, 0o555);
    let why: string | undefined;
    try {
      why = await changeSourceManifest(source, { output: 'New Name' });
    } finally {
      await chmod(source, 0o755);
    }

    expect([why, await readdir(source)]).toEqual([expect.stringMatching(new RegExp(`^The manifest in "${source}" could not be written: `)), ['Old Name.manifest.json']]);
  });
});
