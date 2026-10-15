import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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

    const hash: unknown = expect.stringMatching(/^[A-Za-z0-9+/]{11}=$/);
    expect(answer).toEqual({ kind: 'read', answer: [{ path: 'meshes/Armor.nif', size: 4, hash }, { path: 'Game.esm', size: 6, hash }] });
  });

  it('names the game files the files in a mod\'s folder override, whether or not the active profile lists the mod', async () => {
    const adapter = await instance();
    await put('Data/meshes/Armor.nif', 'aaaa');
    await put('Data/Other.esm', 'bbbbbb');
    await put('mods/Unlisted/Meshes/armor.nif', 'mine');
    await put('mods/Unlisted/own.txt');

    const answer = await adapter.gameFilesOverriddenBy(join(root, 'Data'), 'Unlisted');

    expect(answer).toEqual({
      kind: 'read', answer: { gameFiles: [{ path: 'meshes/Armor.nif', size: 4, hash: expect.stringMatching(/^[A-Za-z0-9+/]{11}=$/) as unknown }], notes: [] },
    });
  });

  it('names each entry of the mod\'s folder its listing skipped, such as a broken link, beside the game files', async () => {
    const adapter = await instance();
    await put('mods/Unlisted/own.txt');
    await symlink(join(root, 'nowhere.nif'), join(root, 'mods', 'Unlisted', 'Broken.nif'));

    const answer = await adapter.gameFilesOverriddenBy(join(root, 'Data'), 'Unlisted');

    expect(answer.kind === 'read' ? answer.answer.notes.join('\n') : answer.reason).toMatch(/Broken\.nif/);
  });

  it('refuses to write over an ignore list already in the instance folder, naming it, and leaves it as it is', async () => {
    const adapter = await instance();
    await put('.gitignore', 'mine\n');

    await expect(adapter.writeIgnoreList()).rejects.toThrow(join(root, '.gitignore'));

    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('mine\n');
  });

  it('takes back the ignore list it wrote', async () => {
    const adapter = await instance();
    await adapter.writeIgnoreList();

    await adapter.removeIgnoreList();

    expect(existsSync(join(root, '.gitignore'))).toBe(false);
  });

  it('keeps the stat cache in a folder at the instance root, beside the mod folders', async () => {
    const adapter = await instance();

    expect(adapter.statCacheFolder).toBe(join(root, 'stat-cache'));
  });

  it('shows git exactly the whitelist: the manifests, each profile\'s orders and INIs, and the configuration', async () => {
    const adapter = await instance();
    runGit('init', '--quiet');
    const listed = [
      'ModOrganizer.ini', 'profiles/Default/modlist.txt', 'profiles/Default/plugins.txt', 'profiles/Default/loadorder.txt',
      'profiles/Default/settings.ini', 'profiles/Default/fallout4prefs.ini', 'mods/Mod A/Mod A.manifest',
    ];
    const ignored = [
      'mods/Mod A/Mod A.esp', 'mods/Mod A/textures/a.dds', 'mods/Mod A/readme.ini', 'mods/Mod A/.git/HEAD', 'mods/Mod A/meta.ini', 'mods/Mod B/meta.ini',
      'profiles/Default/saves/save.fos', 'profiles/Default/nested/modlist.txt', 'downloads/Mod.7z', 'downloads/Mod.7z.meta',
      'source/Mod A/build.json', 'hash-index/hashes.jsonl', 'stat-cache/Mod A', 'overwrite/log.txt', 'logs/mo_interface.log', 'webcache/index', 'plugins/x.dll',
    ];
    await Promise.all([...listed, ...ignored].map((path) => put(path)));

    await adapter.writeIgnoreList();

    const shown = runGit('status', '--porcelain', '-z', '--untracked-files=all').split('\0').filter(Boolean).map((line) => line.slice(3));
    expect(shown.sort()).toEqual([...listed, '.gitignore'].sort());
  });
});
