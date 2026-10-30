import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeInstallationFileReader } from '../../../test/fakeInstallationFileReader';
import { packageFilesWriter } from '../packageFiles';

let root: string;
let folder: string;
let scratch: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'modbench-package-files-'));
  folder = join(root, 'mods', 'Mod');
  scratch = join(root, 'scratch');
  await mkdir(folder, { recursive: true });
  await mkdir(join(root, 'Game', 'Data'), { recursive: true });
  await writeFile(join(root, 'Game', 'Data', 'Fallout4.esm'), 'the game\'s bytes');
});
afterEach(() => rm(root, { recursive: true, force: true }));

const writer = () => packageFilesWriter(scratch, fakeInstallationFileReader(['a.nif', 'textures/b.dds']));
const textIn = (path: string): Promise<string> => readFile(join(folder, path), 'utf8');

describe('writing files from their packages', () => {
  it('writes each entry at its path in the folder, one entry at two paths, and a game file, replacing a file that is there', async () => {
    await writeFile(join(folder, 'a.nif'), 'my edit');

    await writer().writeFilesIn(folder, [
      { path: 'a.nif', from: { kind: 'entry', downloadedFile: join(root, 'Mod.7z'), entry: 'a.nif' } },
      { path: 'textures/b.dds', from: { kind: 'entry', downloadedFile: join(root, 'Mod.7z'), entry: 'textures/b.dds' } },
      { path: 'copy/b.dds', from: { kind: 'entry', downloadedFile: join(root, 'Mod.7z'), entry: 'textures/b.dds' } },
      { path: 'Fallout4.esm', from: { kind: 'gameFile', root: join(root, 'Game'), path: 'Data/Fallout4.esm' } },
    ]);

    expect(await Promise.all(['a.nif', 'textures/b.dds', 'copy/b.dds', 'Fallout4.esm'].map(textIn))).toEqual([
      'bytes of a.nif', 'bytes of textures/b.dds', 'bytes of textures/b.dds', 'the game\'s bytes',
    ]);
  });

  it('leaves nothing of the downloaded file it extracted', async () => {
    await writer().writeFilesIn(folder, [{ path: 'a.nif', from: { kind: 'entry', downloadedFile: join(root, 'Mod.7z'), entry: 'a.nif' } }]);

    expect(await readdir(scratch)).toEqual([]);
  });

  it.each(['../escape.nif', 'a/../../escape.nif', '/escape.nif', 'a\\b.nif'])('refuses a path that leaves the folder, writing nothing: %j', async (path) => {
    const writing = writer().writeFilesIn(folder, [
      { path: 'a.nif', from: { kind: 'entry', downloadedFile: join(root, 'Mod.7z'), entry: 'a.nif' } },
      { path, from: { kind: 'entry', downloadedFile: join(root, 'Mod.7z'), entry: 'a.nif' } },
    ]);

    await expect(writing).rejects.toThrow(`Not a file of "${folder}": "${path}"`);
    expect(await readdir(folder)).toEqual([]);
  });

  it('refuses a path a link in the folder takes outside it', async () => {
    await mkdir(join(root, 'elsewhere'));
    await symlink(join(root, 'elsewhere'), join(folder, 'linked'));

    const writing = writer().writeFilesIn(folder, [{ path: 'linked/a.nif', from: { kind: 'entry', downloadedFile: join(root, 'Mod.7z'), entry: 'a.nif' } }]);

    await expect(writing).rejects.toThrow(`Not a file of "${folder}": "linked/a.nif"`);
    expect(await readdir(join(root, 'elsewhere'))).toEqual([]);
  });
});
