import { describe, expect, it, vi } from 'vitest';
import { mkdir, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fakeVscodeModule } from '../../../test/mo2/fakeVscodeWatcher';
import { fakeInstallationFileReader } from '../../../test/fakeInstallationFileReader';
import { mo2InstanceHolding } from '../../test/instanceOnDisk';

vi.mock('vscode', () => fakeVscodeModule());

const NO_TRASH = (path: string): Promise<void> => Promise.reject(new Error(`nothing is there to trash: ${path}`));

function holdingMod(files: Readonly<Record<string, string>> = {}) {
  const instance = mo2InstanceHolding(
    { 'mods/Mod/.keep': '', 'Game/Data/Fallout4.esm': 'the game\'s bytes', ...files },
    { installationFileReader: fakeInstallationFileReader(['a.nif', 'textures/b.dds']) },
  );
  const folder = join(instance.root, 'mods', 'Mod');
  return { ...instance, folder, textIn: (path: string): Promise<string> => readFile(join(folder, path), 'utf8') };
}

describe('writing files from their packages', () => {
  it('writes each entry at its path in the folder, one entry at two paths, and a game file, sending a file that is there to the trash first', async () => {
    const { root, adapter, folder, textIn } = holdingMod({ 'mods/Mod/a.nif': 'my edit' });
    const inTrash: Record<string, string> = {};
    const trash = async (path: string): Promise<void> => { inTrash[relative(folder, path)] = await readFile(path, 'utf8'); await rm(path); };

    await adapter.writeFilesIn(folder, [
      { path: 'a.nif', from: { kind: 'entry', downloadedFile: join(root, 'Mod.7z'), entry: 'a.nif' } },
      { path: 'textures/b.dds', from: { kind: 'entry', downloadedFile: join(root, 'Mod.7z'), entry: 'textures/b.dds' } },
      { path: 'copy/b.dds', from: { kind: 'entry', downloadedFile: join(root, 'Mod.7z'), entry: 'textures/b.dds' } },
      { path: 'Fallout4.esm', from: { kind: 'gameFile', root: join(root, 'Game'), path: 'Data/Fallout4.esm' } },
    ], trash);

    expect(await Promise.all(['a.nif', 'textures/b.dds', 'copy/b.dds', 'Fallout4.esm'].map(textIn))).toEqual([
      'bytes of a.nif', 'bytes of textures/b.dds', 'bytes of textures/b.dds', 'the game\'s bytes',
    ]);
    expect(inTrash).toEqual({ 'a.nif': 'my edit' });
  });

  it('leaves nothing of the downloaded file it extracted', async () => {
    const { root, adapter, folder } = holdingMod();

    await adapter.writeFilesIn(folder, [{ path: 'a.nif', from: { kind: 'entry', downloadedFile: join(root, 'Mod.7z'), entry: 'a.nif' } }], NO_TRASH);

    expect(await readdir(join(root, 'hash-index'))).toEqual([]);
  });

  it.each(['../escape.nif', 'a/../../escape.nif', '/escape.nif', 'a\\b.nif'])('refuses a path that leaves the folder, writing nothing: %j', async (path) => {
    const { root, adapter, folder } = holdingMod();
    const writing = adapter.writeFilesIn(folder, [
      { path: 'a.nif', from: { kind: 'entry', downloadedFile: join(root, 'Mod.7z'), entry: 'a.nif' } },
      { path, from: { kind: 'entry', downloadedFile: join(root, 'Mod.7z'), entry: 'a.nif' } },
    ], NO_TRASH);

    await expect(writing).rejects.toThrow(`Not a file of "${folder}": "${path}"`);
    expect(await readdir(folder)).toEqual(['.keep']);
  });

  it('refuses a path a link in the folder takes outside it', async () => {
    const { root, adapter, folder } = holdingMod();
    await mkdir(join(root, 'elsewhere'));
    await symlink(join(root, 'elsewhere'), join(folder, 'linked'));

    const writing = adapter.writeFilesIn(folder, [{ path: 'linked/a.nif', from: { kind: 'entry', downloadedFile: join(root, 'Mod.7z'), entry: 'a.nif' } }], NO_TRASH);

    await expect(writing).rejects.toThrow(`Not a file of "${folder}": "linked/a.nif"`);
    expect(await readdir(join(root, 'elsewhere'))).toEqual([]);
  });
});
