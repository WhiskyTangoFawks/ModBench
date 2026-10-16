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

  describe('a source mod with a remote is a submodule', () => {
    const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    const SOURCE_BUILD = (output: string): string => JSON.stringify({ output });

    async function sourceMod(folder: string, output: string, remote?: string): Promise<string> {
      await put(`source/${folder}/build.json`, SOURCE_BUILD(output));
      const path = join(root, 'source', folder);
      git(path, 'init', '--quiet', '--initial-branch=main');
      if (remote !== undefined) git(path, 'remote', 'add', 'origin', remote);
      git(path, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'first');
      return path;
    }

    const submodulesNamed = (): string[] =>
      runGit('config', '-f', '.gitmodules', '--get-regexp', String.raw`^submodule\..*\.url$`).split('\n').filter(Boolean).sort();

    it('writes its entry in .gitmodules with its remote and its branch, and its line in the ignore list, so git stages it as a submodule', async () => {
      const adapter = await instance();
      runGit('init', '--quiet');
      await adapter.writeIgnoreList();
      await sourceMod('Mod A', 'Mod A', 'https://example.test/a.git');
      await sourceMod('Local', 'Local');

      const notes = await adapter.writeSubmodules();

      runGit('add', '-A', '--', '.');
      expect(notes).toEqual([]);
      expect(submodulesNamed()).toEqual(['submodule.Mod A.url https://example.test/a.git']);
      expect(runGit('config', '-f', '.gitmodules', 'submodule.Mod A.branch').trim()).toBe('main');
      expect(runGit('config', '-f', '.gitmodules', 'submodule.Mod A.path').trim()).toBe('source/Mod A');
      expect(runGit('ls-files', '-s', 'source').trim().split('\n').map((line) => line.slice(0, 6) + line.slice(line.indexOf('\t')))).toEqual(['160000\tsource/Mod A']);
      expect(runGit('ls-files', '.gitmodules')).toBe('.gitmodules\n');
    });

    it('changes nothing when the source mods are as the last call left them', async () => {
      const adapter = await instance();
      runGit('init', '--quiet');
      await adapter.writeIgnoreList();
      await sourceMod('Mod A', 'Mod A', 'https://example.test/a.git');
      await adapter.writeSubmodules();
      const before = [await readFile(join(root, '.gitmodules'), 'utf8'), await readFile(join(root, '.gitignore'), 'utf8')];

      await adapter.writeSubmodules();

      expect([await readFile(join(root, '.gitmodules'), 'utf8'), await readFile(join(root, '.gitignore'), 'utf8')]).toEqual(before);
    });

    it('takes the entry and the line of a source mod that is gone or lost its remote, and keeps the lines it did not write', async () => {
      const adapter = await instance();
      runGit('init', '--quiet');
      await adapter.writeIgnoreList();
      await put('.gitignore', `${await readFile(join(root, '.gitignore'), 'utf8')}mine/\n`);
      const gone = await sourceMod('Gone', 'Gone', 'https://example.test/g.git');
      const unlinked = await sourceMod('Unlinked', 'Unlinked', 'https://example.test/u.git');
      await sourceMod('Kept', 'Kept', 'https://example.test/k.git');
      await adapter.writeSubmodules();
      await rm(gone, { recursive: true });
      git(unlinked, 'remote', 'remove', 'origin');

      await adapter.writeSubmodules();

      expect(submodulesNamed()).toEqual(['submodule.Kept.url https://example.test/k.git']);
      const ignoreList = await readFile(join(root, '.gitignore'), 'utf8');
      expect([ignoreList.includes('Gone'), ignoreList.includes('Unlinked'), ignoreList.includes('Kept'), ignoreList.includes('mine/')]).toEqual([false, false, true, true]);
    });

    it('writes the entry of a source mod by the folder it is in, whatever mod its build names', async () => {
      const adapter = await instance();
      runGit('init', '--quiet');
      await sourceMod('Old Name', 'New Name', 'https://example.test/n.git');

      await adapter.writeSubmodules();

      expect(runGit('config', '-f', '.gitmodules', 'submodule.Old Name.path').trim()).toBe('source/Old Name');
    });

    it('names a source mod whose remote or branch it cannot read, and writes no entry for it', async () => {
      const adapter = await instance();
      runGit('init', '--quiet');
      const detached = await sourceMod('Detached', 'Detached', 'https://example.test/d.git');
      git(detached, 'checkout', '--quiet', '--detach');

      const notes = await adapter.writeSubmodules();

      expect([notes, existsSync(join(root, '.gitmodules')) ? submodulesNamed() : []]).toEqual([
        [{ mod: 'Detached', note: expect.stringContaining('branch') as unknown }], [],
      ]);
    });

    it('makes the repository refuse a push of a pin its source mod\'s remote lacks', async () => {
      const adapter = await instance();
      runGit('init', '--quiet', '--initial-branch=main');
      runGit('config', 'user.name', 't');
      runGit('config', 'user.email', 't@t');
      await adapter.writeIgnoreList();
      const remote = await mkdtemp(join(tmpdir(), 'modbench-mo2-remote-'));
      const bare = await mkdtemp(join(tmpdir(), 'modbench-mo2-modlist-'));
      try {
        git(remote, 'init', '--quiet', '--bare');
        git(bare, 'init', '--quiet', '--bare');
        const mod = await sourceMod('Mod A', 'Mod A', remote);
        git(mod, 'push', '--quiet', 'origin', 'main');
        await adapter.writeSubmodules();
        runGit('add', '-A');
        runGit('commit', '--quiet', '-m', 'pins a published commit');
        runGit('remote', 'add', 'origin', bare);
        await adapter.refuseUnpublishedPins();
        runGit('push', '--quiet', 'origin', 'main');
        git(mod, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'second');
        runGit('add', '-A');
        runGit('commit', '--quiet', '-m', 'pins a commit the remote lacks');

        expect(() => { runGit('push', '--quiet', 'origin', 'main'); }).toThrow();
      } finally {
        await rm(remote, { recursive: true, force: true });
        await rm(bare, { recursive: true, force: true });
      }
    });
  });
});
