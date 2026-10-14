import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { NO_DETECTORS } from '../../test/noDetectors';
import { fakeArchiveReader } from '../../test/fakeArchiveReader';

vi.mock('vscode', () => fakeVscodeModule());

import { mo2InstanceAdapter } from '../mo2Instance';

let root: string;

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function instance() {
  root = await mkdtemp(join(tmpdir(), 'modbench-mo2-repository-'));
  return mo2InstanceAdapter({
    instanceRoot: root, gameDirectoryOverrides: () => ({}), gameDirectoryChanged: () => ({ dispose: () => {} }), detectors: NO_DETECTORS,
    archives: fakeArchiveReader([]),
  });
}

async function put(path: string, text = 'x'): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

const runGit = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

describe('the MO2 adapter\'s repository', () => {
  it('reads that the instance holds none until its folder has a .git', async () => {
    const adapter = await instance();
    await put('ModOrganizer.ini', '[General]\r\ngameName=Fallout 4\r\nselected_profile=Default\r\n');
    await put('profiles/Default/modlist.txt', '');
    await put('profiles/Default/plugins.txt', '');
    await mkdir(join(root, 'mods'));
    const before = (await adapter.reading()).holdsRepository;
    runGit('init', '--quiet');

    expect([before, (await adapter.reading()).holdsRepository]).toEqual([false, true]);
  });

  it('names the game files a mod\'s files override as the game folder spells them, with their size and hash', async () => {
    const adapter = await instance();
    await put('Data/meshes/Armor.nif', 'aaaa');
    await put('Data/Game.esm', 'bbbbbb');
    await put('Data/textures', 'a file where a folder is wanted');

    const answer = await adapter.overriddenGameFiles(join(root, 'Data'), ['Meshes/armor.NIF', 'game.esm', 'Game.esm', 'meshes/none.nif', 'textures/a.dds', 'Meshes']);

    const files = answer.kind === 'read' ? answer.answer : [];
    expect(files.map(({ path, size }) => ({ path, size }))).toEqual([{ path: 'meshes/Armor.nif', size: 4 }, { path: 'Game.esm', size: 6 }]);
    expect(files.map(({ hash }) => /^[A-Za-z0-9+/]{11}=$/.test(hash))).toEqual([true, true]);
  });

  it('shows git exactly the whitelist: the manifests, meta.ini, each profile\'s orders and INIs, and the configuration', async () => {
    const adapter = await instance();
    runGit('init', '--quiet');
    const listed = [
      'ModOrganizer.ini', 'profiles/Default/modlist.txt', 'profiles/Default/plugins.txt', 'profiles/Default/loadorder.txt',
      'profiles/Default/settings.ini', 'profiles/Default/fallout4prefs.ini', 'mods/Mod A/meta.ini', 'mods/Mod A/Mod A.manifest',
      'mods/Mod B/meta.ini',
    ];
    const ignored = [
      'mods/Mod A/Mod A.esp', 'mods/Mod A/textures/a.dds', 'mods/Mod A/readme.ini', 'mods/Mod A/.git/HEAD', 'mods/Mod A/nested/meta.ini',
      'profiles/Default/saves/save.fos', 'profiles/Default/nested/modlist.txt', 'downloads/Mod.7z', 'downloads/Mod.7z.meta', 'build/delta.octodiff',
      'source/Mod A/build.json', 'hash-index/hashes.jsonl', 'overwrite/log.txt', 'logs/mo_interface.log', 'webcache/index', 'plugins/x.dll',
    ];
    for (const path of [...listed, ...ignored]) await put(path);

    await adapter.writeIgnoreList();

    const shown = runGit('status', '--porcelain', '-z', '--untracked-files=all').split('\0').filter(Boolean).map((line) => line.slice(3));
    expect(shown.sort()).toEqual([...listed, '.gitignore'].sort());
  });
});
