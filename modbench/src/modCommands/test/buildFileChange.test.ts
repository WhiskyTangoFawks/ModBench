import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFileIn, writeBuildFileIn, type Manifest } from '../../manifestAdapter/manifestAdapter';
import { BUILD_FILE } from '../../wire/sourceMod';
import { changeBuildFile } from '../buildFileChange';

const MARK = '.excluded';
const BUILD_FILE_HELD: Manifest = {
  packages: [{ kind: 'installationFile', name: 'Mod.7z', size: 1, hash: 'H' }], output: 'Old Name',
  exclude: [], archives: [{ path: 'Mod - Main.ba2', files: ['meshes/a.nif'] }], steps: [], tools: [], files: [{ path: 'meshes/a.nif', entry: { kind: 'held' } }],
};

let source: string;

beforeEach(async () => { source = await mkdtemp(join(tmpdir(), 'build-file-')); });
afterEach(() => rm(source, { recursive: true, force: true }));

const held = async (): Promise<Manifest> => {
  const read = await buildFileIn(source);
  if (read === undefined || 'refused' in read) throw new Error('no build file');
  return read.manifest;
};

const excluding = (exclude: readonly string[], include: readonly string[] = []) => ({ exclude, include, exclusionMark: MARK });

describe('changeBuildFile', () => {
  it('names the folder with a new output, keeping all else the build file says', async () => {
    await writeBuildFileIn(source, BUILD_FILE_HELD);

    expect(await changeBuildFile(source, { output: 'New Name' })).toBeUndefined();

    expect([await readdir(source), await held()]).toEqual([[BUILD_FILE], { ...BUILD_FILE_HELD, output: 'New Name' }]);
  });

  it.each([
    [[], ['textures/b.dds', 'meshes'], [], ['meshes', 'textures/b.dds']],
    [['textures/b.dds'], ['Textures/B.dds', 'a.esp', 'Z.esp'], [], ['a.esp', 'textures/b.dds', 'Z.esp']],
    [['a.esp', 'textures/b.dds'], [], ['Textures/B.dds'], ['a.esp']],
    [['a.esp'], [], ['a.esp', 'never.esp'], []],
  ])('adds or removes an exclusion by path without case: %j, excluding %j and including %j', async (before, exclude, include, after) => {
    await writeBuildFileIn(source, { ...BUILD_FILE_HELD, exclude: before });

    expect(await changeBuildFile(source, excluding(exclude, include))).toBeUndefined();

    expect((await held()).exclude).toEqual(after);
  });

  it('moves each line to where the folder holds its file once the exclusion changes', async () => {
    await writeBuildFileIn(source, { ...BUILD_FILE_HELD, archives: [], files: [{ path: 'textures/a.dds', entry: { kind: 'held' } }] });

    await changeBuildFile(source, excluding(['textures/a.dds']));

    expect((await held()).files.map(({ path }) => path)).toEqual(['textures/a.dds.excluded']);
  });

  it('refuses a repository that holds no build file, naming it, and writes none', async () => {
    expect(await changeBuildFile(source, { output: 'Other' })).toBe(`"${source}" holds no build file.`);

    expect(await readdir(source)).toEqual([]);
  });

  it('refuses a build file that does not read, naming why, and leaves it as it was', async () => {
    await writeFile(join(source, BUILD_FILE), '{"output": ');

    expect(await changeBuildFile(source, { output: 'Other' })).toBe(`The source mod in "${source}" was not changed: its build file cannot be read at line 1.`);

    expect(await readFile(join(source, BUILD_FILE), 'utf8')).toBe('{"output": ');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('refuses a build file the disk will not let be written, and leaves it as it was', async () => {
    await writeBuildFileIn(source, BUILD_FILE_HELD);
    await chmod(source, 0o555);
    let why: string | undefined;
    try {
      why = await changeBuildFile(source, { output: 'New Name' });
    } finally {
      await chmod(source, 0o755);
    }

    expect([why, await readdir(source)]).toEqual([expect.stringMatching(new RegExp(`^The build file in "${source}" could not be written: `)), [BUILD_FILE]]);
  });
});
