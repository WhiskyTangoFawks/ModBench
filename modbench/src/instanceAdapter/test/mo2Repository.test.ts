import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { NO_DETECTORS } from '../../test/noDetectors';
import { fakeArchiveReader } from '../../test/fakeArchiveReader';

vi.mock('vscode', () => fakeVscodeModule());

import { mo2InstanceAdapter } from '../mo2Instance';
import { PRE_PUSH_HOOK } from '../prePushHook';

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

      const report = await adapter.writeSubmodules();

      runGit('add', '-A', '--', '.');
      expect(report).toEqual({ notes: [], other: [] });
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

    async function submoduleOfOne(): Promise<{ adapter: Awaited<ReturnType<typeof instance>>; folder: string }> {
      const adapter = await instance();
      runGit('init', '--quiet');
      await adapter.writeIgnoreList();
      const folder = await sourceMod('Mod A', 'Mod A', 'https://example.test/a.git');
      await adapter.writeSubmodules();
      return { adapter, folder };
    }

    const urlOf = (): string => runGit('config', '-f', '.gitmodules', 'submodule.Mod A.url').trim();

    it('names a source mod with a remote and no branch checked out, and writes no entry for it', async () => {
      const adapter = await instance();
      runGit('init', '--quiet');
      const detached = await sourceMod('Detached', 'Detached', 'https://example.test/d.git');
      git(detached, 'checkout', '--quiet', '--detach');

      const report = await adapter.writeSubmodules();

      expect([report.notes, existsSync(join(root, '.gitmodules'))]).toEqual([[{ mod: 'Detached', note: expect.stringContaining('branch') as unknown }], false]);
    });

    it('keeps the entry and the line of a source mod whose branch it can no longer read, and names it', async () => {
      const { adapter, folder } = await submoduleOfOne();
      git(folder, 'checkout', '--quiet', '--detach');

      const report = await adapter.writeSubmodules();

      expect([report.notes.map(({ mod }) => mod), urlOf(), (await readFile(join(root, '.gitignore'), 'utf8')).includes('Mod A')]).toEqual([['Mod A'], 'https://example.test/a.git', true]);
    });

    it('names a source mod whose remote it cannot read, writes the others, and keeps its entry', async () => {
      const { adapter, folder } = await submoduleOfOne();
      await sourceMod('Mod B', 'Mod B', 'https://example.test/b.git');
      await writeFile(join(folder, '.git', 'config'), '[remote "origin"\n');

      const report = await adapter.writeSubmodules();

      expect([report.notes.map(({ mod }) => mod), urlOf(), submodulesNamed().length]).toEqual([['Mod A'], 'https://example.test/a.git', 2]);
    });

    it('takes the entry of a source mod whose folder name holds brackets when it is gone, and goes on', async () => {
      const adapter = await instance();
      runGit('init', '--quiet');
      await adapter.writeIgnoreList();
      const bracketed = await sourceMod('[NoDelete] Foo', '[NoDelete] Foo', 'https://example.test/f.git');
      await sourceMod('Kept', 'Kept', 'https://example.test/k.git');
      await adapter.writeSubmodules();
      await rm(bracketed, { recursive: true });

      const report = await adapter.writeSubmodules();

      expect([report, submodulesNamed()]).toEqual([{ notes: [], other: [] }, ['submodule.Kept.url https://example.test/k.git']]);
      expect(await readFile(join(root, '.gitignore'), 'utf8')).not.toContain('NoDelete');
    });

    it('keeps the entry and the line of a source mod whose build configuration it cannot read, and says which', async () => {
      const { adapter, folder } = await submoduleOfOne();
      await writeFile(join(folder, 'build.json'), 'not json');

      const report = await adapter.writeSubmodules();

      expect([report.other, urlOf(), (await readFile(join(root, '.gitignore'), 'utf8')).includes('Mod A')]).toEqual([
        [expect.stringContaining('Mod A') as unknown], 'https://example.test/a.git', true,
      ]);
    });

    it('keeps the lines of the ignore list it did not write, including blank lines and its own let-in of a source folder', async () => {
      const adapter = await instance();
      runGit('init', '--quiet');
      await adapter.writeIgnoreList();
      const mine = `${await readFile(join(root, '.gitignore'), 'utf8')}\n!/source/\n/source/*\n!/source/Mine\n\nnotes/\n`;
      await put('.gitignore', mine);
      await sourceMod('Mod A', 'Mod A', 'https://example.test/a.git');

      await adapter.writeSubmodules();
      await adapter.writeSubmodules();
      const lines = (await readFile(join(root, '.gitignore'), 'utf8')).split('\n').slice(0, -1);

      expect([lines.filter((line) => line === '!/source/Mine').length, lines.includes('notes/'), lines.includes('!/source/Mod A'), lines.filter((line) => line === '').length]).toEqual([1, true, true, 2]);
    });

    it('says, naming it, that a pre-push hook is already in the repository', async () => {
      const adapter = await instance();
      runGit('init', '--quiet');
      await put('.git/hooks/pre-push', 'mine\n');

      await expect(adapter.checkPushRefusalFree()).rejects.toThrow(join(root, '.git', 'hooks', 'pre-push'));
    });

    it('says before the repository exists that a pre-push hook is already where the global core.hooksPath points', async () => {
      const adapter = await instance();
      await put('global.config', `[core]\n\thooksPath = ${join(root, 'global-hooks')}\n`);
      await put('global-hooks/pre-push', 'mine\n');
      vi.stubEnv('GIT_CONFIG_GLOBAL', join(root, 'global.config'));

      try {
        await expect(adapter.checkPushRefusalFree()).rejects.toThrow(join(root, 'global-hooks', 'pre-push'));
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('finds the place free when no hook is there', async () => {
      const adapter = await instance();

      await expect(adapter.checkPushRefusalFree()).resolves.toBeUndefined();
    });

    describe('a push of the modlist', () => {
      const remotes: string[] = [];

      afterEach(async () => {
        await Promise.all(remotes.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
      });

      const bareRepository = async (): Promise<string> => {
        const folder = await mkdtemp(join(tmpdir(), 'modbench-mo2-bare-'));
        remotes.push(folder);
        git(folder, 'init', '--quiet', '--bare', '--initial-branch=main');
        return folder;
      };

      async function pinnedSourceMod() {
        const adapter = await instance();
        runGit('init', '--quiet', '--initial-branch=main');
        runGit('config', 'user.name', 't');
        runGit('config', 'user.email', 't@t');
        await adapter.writeIgnoreList();
        const mod = await sourceMod('Mod A', 'Mod A', await bareRepository());
        await adapter.writeSubmodules();
        runGit('remote', 'add', 'origin', await bareRepository());
        return { adapter, mod };
      }

      const pin = (): void => {
        runGit('add', '-A');
        runGit('commit', '--quiet', '--allow-empty', '-m', 'pin');
      };
      const pushed = (): 'allowed' | 'refused' => {
        try {
          runGit('push', '--quiet', 'origin', 'main');
          return 'allowed';
        } catch {
          return 'refused';
        }
      };

      it('is refused while the source mod was never pushed, which git\'s own check lets through', async () => {
        const { adapter } = await pinnedSourceMod();
        await adapter.refuseUnpublishedPins();
        pin();

        expect(pushed()).toBe('refused');
      });

      it('is allowed once the source mod\'s remote holds the pin', async () => {
        const { adapter, mod } = await pinnedSourceMod();
        await adapter.refuseUnpublishedPins();
        git(mod, 'push', '--quiet', 'origin', 'main');
        pin();

        expect(pushed()).toBe('allowed');
      });

      it('is refused while a pin it changes is missing from the source mod\'s tracked remote', async () => {
        const { adapter, mod } = await pinnedSourceMod();
        await adapter.refuseUnpublishedPins();
        git(mod, 'push', '--quiet', 'origin', 'main');
        pin();
        const first = pushed();
        git(mod, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'second');
        pin();

        expect([first, pushed()]).toEqual(['allowed', 'refused']);
      });

      it('installs its hook where git looks for hooks, whatever core.hooksPath says', async () => {
        const adapter = await instance();
        runGit('init', '--quiet');
        runGit('config', 'core.hooksPath', join(root, 'my-hooks'));

        await adapter.refuseUnpublishedPins();

        expect([existsSync(join(root, 'my-hooks', 'pre-push')), existsSync(join(root, '.git', 'hooks', 'pre-push'))]).toEqual([true, false]);
      });

      it('installs its hook in the git directory a .git file names', async () => {
        const adapter = await instance();
        const separate = join(root, '..', `${basename(root)}-git`);
        runGit('init', '--quiet', '--separate-git-dir', separate);

        await adapter.refuseUnpublishedPins();

        expect(existsSync(join(separate, 'hooks', 'pre-push'))).toBe(true);
        await rm(separate, { recursive: true, force: true });
      });

      it('allows a new branch from a clone that has not restored its source mods, when the remote holds their pins', async () => {
        const { mod } = await pinnedSourceMod();
        git(mod, 'push', '--quiet', 'origin', 'main');
        pin();
        runGit('push', '--quiet', 'origin', 'main');
        const clone = await mkdtemp(join(tmpdir(), 'modbench-mo2-clone-'));
        remotes.push(clone);
        const origin = runGit('remote', 'get-url', 'origin').trim();
        git(clone, 'clone', '--quiet', origin, 'modlist');
        const cloned = join(clone, 'modlist');
        await mkdir(join(cloned, 'source', 'Mod A'), { recursive: true });
        await mkdir(join(cloned, '.git', 'hooks'), { recursive: true });
        await writeFile(join(cloned, '.git', 'hooks', 'pre-push'), PRE_PUSH_HOOK, { mode: 0o755 });
        git(cloned, 'config', 'user.name', 't');
        git(cloned, 'config', 'user.email', 't@t');
        git(cloned, 'commit', '--quiet', '--allow-empty', '-m', 'unrelated');

        expect(() => git(cloned, 'push', '--quiet', 'origin', 'HEAD:refs/heads/other')).not.toThrow();
      });

      it('refuses a pin it has no checkout to verify, saying so', async () => {
        const { mod } = await pinnedSourceMod();
        git(mod, 'push', '--quiet', 'origin', 'main');
        pin();
        runGit('push', '--quiet', 'origin', 'main');
        const clone = await mkdtemp(join(tmpdir(), 'modbench-mo2-clone-'));
        remotes.push(clone);
        git(clone, 'clone', '--quiet', runGit('remote', 'get-url', 'origin').trim(), 'modlist');
        const cloned = join(clone, 'modlist');
        await mkdir(join(cloned, 'source', 'Mod A'), { recursive: true });
        await mkdir(join(cloned, '.git', 'hooks'), { recursive: true });
        await writeFile(join(cloned, '.git', 'hooks', 'pre-push'), PRE_PUSH_HOOK, { mode: 0o755 });
        git(cloned, 'config', 'user.name', 't');
        git(cloned, 'config', 'user.email', 't@t');
        git(cloned, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},source/Mod A`);
        git(cloned, 'commit', '--quiet', '-m', 'repin');

        expect(() => execFileSync('git', ['push', '--quiet', 'origin', 'HEAD:refs/heads/other'], { cwd: cloned, stdio: 'pipe' })).toThrow(/no checkout/);
      });

      it('leaves a pre-push hook already in the repository as it is, naming it', async () => {
        const adapter = await instance();
        runGit('init', '--quiet');
        await put('.git/hooks/pre-push', 'mine\n');

        await expect(adapter.refuseUnpublishedPins()).rejects.toThrow(join(root, '.git', 'hooks', 'pre-push'));

        expect(await readFile(join(root, '.git', 'hooks', 'pre-push'), 'utf8')).toBe('mine\n');
      });
    });
  });
});
