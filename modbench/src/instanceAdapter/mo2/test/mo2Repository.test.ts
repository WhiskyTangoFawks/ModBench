import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fakeVscodeModule } from '../../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { adapterOver, managerOver } from '../../../test/mo2/adapterOver';
import type { GamePlace } from '../../instanceAdapter';
import type { ManagerAdapter as Adapter } from '../../publisher';
import { PRE_PUSH_HOOK } from '../../prePushHook';
import { whitelistIgnoreList, withSourceModLines } from '../layout';

let root: string;

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function instance() {
  root = await mkdtemp(join(tmpdir(), 'modbench-mo2-repository-'));
  return managerOver(root);
}

const gamePlace = (): GamePlace => ({ root: join(root, 'game'), holdsDataFiles: true, depots: [], depotProblems: [] });

async function put(path: string, text = 'x'): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

const runGit = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

const SETTINGS_NAMING_DOWNLOADS = '[General]\r\ngameName=Fallout 4\r\n[Settings]\r\ndownload_directory=@ByteArray(my downloads)\r\n';

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

  describe('the ignore list', () => {
    const crlf = (text: string): string => text.replaceAll('\n', '\r\n');
    const withSourceMod = withSourceModLines(whitelistIgnoreList(undefined), ['Mod A']) ?? '';
    const ignoreList = (): Promise<string> => readFile(join(root, '.gitignore'), 'utf8');

    const whitelistLines = whitelistIgnoreList(undefined).trimEnd().split('\n');
    const joined = (lines: string[]): string => `${lines.join('\n')}\n`;
    const withoutLastLine = joined(whitelistLines.slice(0, -1));
    const swapped = joined([whitelistLines[1] ?? '', whitelistLines[0] ?? '', ...whitelistLines.slice(2)]);
    const trailingSpace = joined([`${whitelistLines[0] ?? ''} `, ...whitelistLines.slice(1)]);

    it.each([
      ['the lines of an ignore list already there', 'mine\n', `mine\n${whitelistIgnoreList(undefined)}`],
      ['an ignore list with no final newline', 'mine', `mine\n${whitelistIgnoreList(undefined)}`],
      ['an ignore list of CRLF lines', 'mine\r\n', `mine\r\n${crlf(whitelistIgnoreList(undefined))}`],
      ['an ignore list whose whitelist lacks a line', withoutLastLine, `${withoutLastLine}${whitelistIgnoreList(undefined)}`],
      ['an ignore list whose whitelist lines are out of order', swapped, `${swapped}${whitelistIgnoreList(undefined)}`],
      ['an ignore list that holds its whitelist', whitelistIgnoreList(undefined), whitelistIgnoreList(undefined)],
      ['an ignore list that holds its whitelist and its source mods', withSourceMod, withSourceMod],
      ['an ignore list that holds its whitelist, then lines of the user', `${whitelistIgnoreList(undefined)}!/README.md\n!/docs/\n`, `${whitelistIgnoreList(undefined)}!/README.md\n!/docs/\n`],
      ['an ignore list that holds lines of the user, then its whitelist', `mine/\n${whitelistIgnoreList(undefined)}`, `mine/\n${whitelistIgnoreList(undefined)}`],
      ['an ignore list that holds lines of the user on both sides of its whitelist', `mine/\n${whitelistIgnoreList(undefined)}!/docs/\n`, `mine/\n${whitelistIgnoreList(undefined)}!/docs/\n`],
      ['an ignore list that holds its whitelist and its source mods, then lines of the user', `${withSourceMod}!/docs/\n`, `${withSourceMod}!/docs/\n`],
      ['an ignore list of CRLF lines that holds its whitelist, then lines of the user', crlf(`${whitelistIgnoreList(undefined)}!/docs/\n`), crlf(`${whitelistIgnoreList(undefined)}!/docs/\n`)],
      ['an ignore list that holds its whitelist with a trailing space, then lines of the user', `${trailingSpace}!/docs/\n`, `${trailingSpace}!/docs/\n`],
    ])('writes the ignore list for %s, and takes back to what the file was', async (_name, before, after) => {
      const adapter = await instance();
      await put('.gitignore', before);

      const takeBack = await adapter.writeIgnoreList();
      const written = await ignoreList();
      await takeBack();

      expect([written, await ignoreList()]).toEqual([after, before]);
    });

    it('keeps the workspace settings file out of the repository, so the deployment folder is in no commit', async () => {
      const adapter = await instance();
      runGit('init', '--quiet');
      await put('.vscode/settings.json', '{}');

      await adapter.writeIgnoreList();

      expect(runGit('check-ignore', '.vscode/settings.json').trim()).toBe('.vscode/settings.json');
    });

    it('takes back only its own lines, keeping a line another program added after them', async () => {
      const adapter = await instance();
      await put('.gitignore', 'mine\n');
      const takeBack = await adapter.writeIgnoreList();
      await put('.gitignore', `${await ignoreList()}theirs\n`);

      await takeBack();

      expect(await ignoreList()).toBe('mine\ntheirs\n');
    });

    it('takes back nothing, and keeps what another program wrote, when it added nothing', async () => {
      const adapter = await instance();
      await put('.gitignore', whitelistIgnoreList(undefined));
      const takeBack = await adapter.writeIgnoreList();
      await put('.gitignore', 'theirs\n');

      await takeBack();

      expect(await ignoreList()).toBe('theirs\n');
    });

    it('lets git see the publisher\'s configuration', async () => {
      root = await mkdtemp(join(tmpdir(), 'modbench-mo2-repository-'));
      const adapter = managerOver(root, {}, { name: 'publisher.json', spelling: { separators: [], ends: '"', nativeStarts: [] } });
      await put('publisher.json', '{}');
      await put('other.json', '{}');
      runGit('init', '--quiet');

      await adapter.writeIgnoreList();

      expect(runGit('status', '--porcelain', '--untracked-files=all')).toContain('publisher.json');
      expect(runGit('status', '--porcelain', '--untracked-files=all')).not.toContain('other.json');
    });

    it('takes back the ignore list it wrote', async () => {
      const adapter = await instance();
      const takeBack = await adapter.writeIgnoreList();

      await takeBack();

      expect(existsSync(join(root, '.gitignore'))).toBe(false);
    });
  });

  describe('the files Modbench keeps in the instance', () => {
    it('are its record index, hash index, source folder and repository files, every manifest a mod folder holds, and every other manifest', async () => {
      const adapter = await instance();
      await put('ModOrganizer.ini', SETTINGS_NAMING_DOWNLOADS);
      await put('mods/A/A.manifest.json');
      await put('mods/A/meta.ini');
      await put('mods/B/Renamed.manifest.json');
      await mkdir(join(root, 'mods', 'C'));

      await put('plugins/rootbuilder/rootbuilder.manifest.json');
      await put('plugins/rootbuilder/rootbuilder.py');

      expect((await adapter.filesKept()).present.map((path) => relative(root, path).replaceAll('\\', '/')).sort()).toEqual([
        '.git', '.gitignore', '.gitmodules', 'hash-index', 'modbench', 'mods/A/A.manifest.json', 'mods/B/Renamed.manifest.json',
        'plugins/rootbuilder/rootbuilder.manifest.json', 'source',
      ].sort());
    });
  });

  it.each([
    ['a manifest of the mod\'s name, however it is cased', ['MODS', 'Gone', 'gone.MANIFEST.json'], true],
    ['a manifest a rename left in the folder of another mod', ['mods', 'Y', 'X.manifest.json'], true],
    ['a mod folder', ['mods', 'Gone'], false],
    ['another file in a mod folder', ['mods', 'Gone', 'notes.txt'], false],
    ['a path below a manifest', ['mods', 'A', 'A.manifest.json', 'x'], false],
    ['a manifest in a folder of a mod', ['mods', 'A', 'sub', 'A.manifest.json'], false],
    ['a source mod\'s manifest', ['source', 'A', 'A.manifest.json'], false],
    ['a manifest outside the mod folders, named for the folder it is in, there or not', ['plugins', 'Rootbuilder', 'rootbuilder.MANIFEST.json'], true],
    ['a manifest at the instance root', ['instance.manifest.json'], false],
    ['a manifest outside the mod folders named for another folder', ['plugins', 'rootbuilder', 'other.manifest.json'], false],
    ['a manifest in a profile\'s folder', ['profiles', 'P', 'P.manifest.json'], false],
    ['a manifest in the downloads folder', ['my downloads', 'D', 'D.manifest.json'], false],
    ['a manifest below the folder of another', ['Stock Game', 'Data', 'Data.manifest.json'], true],
  ])('owns %s: %s', async (_name, segments, owned) => {
    const adapter = await instance();
    await put('ModOrganizer.ini', SETTINGS_NAMING_DOWNLOADS);
    await put('Stock Game/Stock Game.manifest.json');
    const { owns } = await adapter.filesKept();

    expect(owns(join(root, ...segments))).toBe(owned);
  });

  describe('whether git init has set the repository up', () => {
    const INSTANCE_FILES = {
      'ModOrganizer.ini': '[General]\r\ngameName=Fallout 4\r\nselected_profile=Default\r\n',
      'profiles/Default/modlist.txt': '',
      'profiles/Default/plugins.txt': '',
    };

    it.each([
      ['no repository', () => Promise.resolve(), false],
      ['a repository with neither the push check nor the path tokens', () => { runGit('init', '--quiet'); return Promise.resolve(); }, false],
      ['a repository with the push check and the path tokens', async (adapter: Adapter) => {
        runGit('init', '--quiet');
        await adapter.refuseUnpublishedPins();
        await adapter.writePathTokens();
      }, true],
      ['a repository with the path tokens and another pre-push hook', async (adapter: Adapter) => {
        runGit('init', '--quiet');
        await put('.git/hooks/pre-push', 'mine\n');
        await adapter.writePathTokens();
      }, false],
      ['a repository with the push check and no path tokens', async (adapter: Adapter) => {
        runGit('init', '--quiet');
        await adapter.refuseUnpublishedPins();
      }, false],
    ])('reads %s', async (_name, arrange, expected) => {
      const adapter = await instance();
      await Promise.all(Object.entries(INSTANCE_FILES).map(([path, text]) => put(path, text)));
      await mkdir(join(root, 'mods'));
      await arrange(adapter);

      expect((await adapter.reading()).repositorySetUp).toBe(expected);
    });

    it('reads a repository whose filter programs are gone as set up only once they are written again', async () => {
      const adapter = await instance();
      await Promise.all(Object.entries(INSTANCE_FILES).map(([path, text]) => put(path, text)));
      await mkdir(join(root, 'mods'));
      runGit('init', '--quiet');
      await adapter.refuseUnpublishedPins();
      await adapter.writePathTokens();
      await rm(join(root, '.git', 'modbench'), { recursive: true });

      const withoutPrograms = (await adapter.reading()).repositorySetUp;
      await adapter.writePathTokens();

      expect([withoutPrograms, (await adapter.reading()).repositorySetUp]).toEqual([false, true]);
    });

    it('reads a repository whose path tokens cover no publisher\'s configuration as set up only once they cover it', async () => {
      const before = await instance();
      await Promise.all(Object.entries(INSTANCE_FILES).map(([path, text]) => put(path, text)));
      await mkdir(join(root, 'mods'));
      runGit('init', '--quiet');
      await before.refuseUnpublishedPins();
      await before.writePathTokens();
      const adapter = managerOver(root, {}, { name: 'publisher.json', spelling: { separators: [], ends: '"' } });

      const beforeCovered = (await adapter.reading()).repositorySetUp;
      await adapter.writePathTokens();

      expect([beforeCovered, (await adapter.reading()).repositorySetUp]).toEqual([false, true]);
    });
  });

  describe('the push check', () => {
    const hook = (): string => join(root, '.git', 'hooks', 'pre-push');

    it.each([
      ['removes the hook it wrote', async (adapter: Adapter) => (await adapter.refuseUnpublishedPins())(), false],
      ['keeps a hook of its own that was there before', async (adapter: Adapter) => {
        await adapter.refuseUnpublishedPins();
        await (await adapter.refuseUnpublishedPins())();
      }, true],
      ['keeps a hook another program put in its place', async (adapter: Adapter) => {
        const takeBack = await adapter.refuseUnpublishedPins();
        await writeFile(hook(), 'theirs\n');
        await takeBack();
      }, true],
    ])('%s when taken back', async (_name, arrange, kept) => {
      const adapter = await instance();
      runGit('init', '--quiet');

      await arrange(adapter);

      expect(existsSync(hook())).toBe(kept);
    });
  });

  describe('every other manifest', () => {
    const NOT_SEARCHED = [
      'mods/A/A.manifest.json', 'mods/A/sub/sub.manifest.json', 'profiles/P/P.manifest.json', 'overwrite/O/O.manifest.json',
      'my downloads/D/D.manifest.json', 'source/S/S.manifest.json', '.git/G/G.manifest.json',
    ];
    const ignoreList = (): Promise<string> => readFile(join(root, '.gitignore'), 'utf8');

    it('is each folder outside the mod folders, profiles, Overwrite, downloads, source mods and repository that holds a manifest named for it', async () => {
      const adapter = await instance();
      await put('ModOrganizer.ini', SETTINGS_NAMING_DOWNLOADS);
      await Promise.all([
        'Stock Game/Stock Game.manifest.json', 'plugins/rootbuilder/rootbuilder.manifest.json', 'plugins/x.dll',
        'plugins/other/notes.manifest.json', 'downloads/D/D.manifest.json', ...NOT_SEARCHED,
      ].map((path) => put(path)));

      expect(await adapter.otherManifests()).toEqual({
        manifests: [
          { name: 'Stock Game/', folder: join(root, 'Stock Game') },
          { name: 'downloads/D/', folder: join(root, 'downloads', 'D') },
          { name: 'plugins/rootbuilder/', folder: join(root, 'plugins', 'rootbuilder') },
        ],
        unsearched: [],
        nested: [],
      });
    });

    it('answers a manifest inside the folder of another as refused with the other, and neither as a manifest', async () => {
      const adapter = await instance();
      await put('ModOrganizer.ini', SETTINGS_NAMING_DOWNLOADS);
      await Promise.all(['Stock Game/Stock Game.manifest.json', 'Stock Game/Data/Data.manifest.json', 'plugins/rootbuilder/rootbuilder.manifest.json'].map((path) => put(path)));

      expect(await adapter.otherManifests()).toEqual({
        manifests: [{ name: 'plugins/rootbuilder/', folder: join(root, 'plugins', 'rootbuilder') }],
        unsearched: [],
        nested: [
          { name: 'Stock Game/', reason: "was skipped: its folder holds the folder of 'Stock Game/Data/'." },
          { name: 'Stock Game/Data/', reason: "was skipped: its folder is inside the folder of 'Stock Game/'." },
        ],
      });
    });

    it.skipIf(process.platform === 'win32')('(a link needs no privilege on POSIX) is never a folder a link reaches, which can be outside the instance', async () => {
      const adapter = await instance();
      await put('ModOrganizer.ini', SETTINGS_NAMING_DOWNLOADS);
      await put('elsewhere/linked.manifest.json');
      await symlink(join(root, 'elsewhere'), join(root, 'linked'));

      expect(await adapter.otherManifests()).toEqual({ manifests: [], unsearched: [], nested: [] });
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('(Windows has no POSIX mode bits, and root reads every folder) names each folder it cannot read, finds the rest, and leaves their lines in the ignore list as they are', async () => {
      const adapter = await instance();
      await put('ModOrganizer.ini', SETTINGS_NAMING_DOWNLOADS);
      await put('.gitignore', 'mine\n');
      await put('plugins/rootbuilder/rootbuilder.manifest.json');
      await put('logs/a.log');
      await chmod(join(root, 'logs'), 0o000);
      try {
        const answer = await adapter.otherManifests();
        const writing = adapter.writeOtherManifestLines();

        expect(answer).toEqual({
          manifests: [{ name: 'plugins/rootbuilder/', folder: join(root, 'plugins', 'rootbuilder') }],
          unsearched: [{ name: 'logs/', reason: expect.stringContaining('EACCES') as unknown }],
          nested: [],
        });
        await expect(writing).rejects.toThrow(/logs\/.*EACCES/);
        expect(await ignoreList()).toBe('mine\n');
      } finally {
        await chmod(join(root, 'logs'), 0o755);
      }
    });

    it('is not searched for, naming why, when the downloads folder the settings name cannot be resolved', async () => {
      await instance();
      await put('ModOrganizer.ini', SETTINGS_NAMING_DOWNLOADS);
      const adapter = managerOver(root, { downloadsFolder: { kind: 'unresolved', reason: 'download_directory "%X%" could not be resolved' } });

      await expect(adapter.otherManifests()).rejects.toThrow('download_directory "%X%" could not be resolved');
    });

    it('is what git sees of its folder and the folders above it', async () => {
      const adapter = await instance();
      runGit('init', '--quiet');
      await put('ModOrganizer.ini', SETTINGS_NAMING_DOWNLOADS);
      const listed = ['ModOrganizer.ini', 'Stock Game/Stock Game.manifest.json', 'Stock Game/Data/Data.manifest.json', 'plugins/rootbuilder/rootbuilder.manifest.json', 'plugins/[x]/[x].manifest.json'];
      const ignored = ['Stock Game/Fallout4.exe', 'Stock Game/Data/Fallout4.esm', 'plugins/rootbuilder/rootbuilder.py', 'plugins/x.dll', 'plugins/[x]/x.py', 'logs/a.log'];
      await Promise.all([...listed, ...ignored].map((path) => put(path)));
      await adapter.writeIgnoreList();

      await adapter.writeOtherManifestLines();

      const shown = runGit('status', '--porcelain', '-z', '--untracked-files=all').split('\0').filter(Boolean).map((line) => line.slice(3));
      expect(shown.sort()).toEqual([...listed, '.gitignore'].sort());
    });

    it('keeps the effect of each line written after the whitelist, lets no such line hide a manifest or a source mod, and writes the same lines again', async () => {
      const adapter = await instance();
      runGit('init', '--quiet');
      await put('ModOrganizer.ini', SETTINGS_NAMING_DOWNLOADS);
      await adapter.writeIgnoreList();
      await writeFile(join(root, '.gitignore'), `${await ignoreList()}!/plugins/\n/plugins/*\n!/plugins/mine.py\n!/source/\n/source/*\n!/source/notes.md\n`);
      await Promise.all(['plugins/mine.py', 'plugins/x.dll', 'plugins/rootbuilder/rootbuilder.manifest.json', 'source/notes.md'].map((path) => put(path)));
      await put('source/Mod A/Mod A.manifest.json', JSON.stringify({ output: 'Mod A', files: [] }));
      const repository = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });
      repository(join(root, 'source', 'Mod A'), 'init', '--quiet', '--initial-branch=main');
      repository(join(root, 'source', 'Mod A'), 'remote', 'add', 'origin', 'https://example.test/a.git');
      repository(join(root, 'source', 'Mod A'), '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'first');

      await adapter.writeSubmodules('every');
      await adapter.writeOtherManifestLines();
      const written = await ignoreList();
      await adapter.writeSubmodules('every');
      const rewrittenOnce = await ignoreList();
      await adapter.writeOtherManifestLines();

      const ignored = (path: string): boolean => spawnSync('git', ['check-ignore', '--quiet', path], { cwd: root }).status === 0;
      expect(['plugins/mine.py', 'source/notes.md', 'plugins/rootbuilder/rootbuilder.manifest.json', 'source/Mod A', 'plugins/x.dll'].map(ignored))
        .toEqual([false, false, false, false, true]);
      expect([rewrittenOnce, await ignoreList()]).toEqual([written, written]);
    });

    it('takes the lines of a manifest that is gone, keeping every line it did not write', async () => {
      const adapter = await instance();
      await put('ModOrganizer.ini', SETTINGS_NAMING_DOWNLOADS);
      await put('.gitignore', 'mine\n');
      await put('Stock Game/Stock Game.manifest.json');
      await put('plugins/rootbuilder/rootbuilder.manifest.json');
      await adapter.writeOtherManifestLines();
      await writeFile(join(root, '.gitignore'), `${await ignoreList()}theirs\n`);
      await rm(join(root, 'plugins', 'rootbuilder', 'rootbuilder.manifest.json'));

      await adapter.writeOtherManifestLines();

      expect(await ignoreList()).toBe([
        '# Manifests outside the mod folders, the rest left out', '/Stock Game/*', '# End of manifests outside the mod folders, the rest left out',
        'mine', 'theirs',
        '# Manifests outside the mod folders', '!/Stock Game/', '!/Stock Game/Stock Game.manifest.json', '# End of manifests outside the mod folders', '',
      ].join('\n'));
    });

    it('rewrites its lines in place in an ignore list of CRLF lines, as Windows writes them', async () => {
      const adapter = await instance();
      await put('ModOrganizer.ini', SETTINGS_NAMING_DOWNLOADS);
      await put('.gitignore', whitelistIgnoreList(undefined));
      await put('plugins/rootbuilder/rootbuilder.manifest.json');
      await adapter.writeOtherManifestLines();
      const crlf = (await ignoreList()).replaceAll('\n', '\r\n');
      await writeFile(join(root, '.gitignore'), crlf);

      await adapter.writeOtherManifestLines();

      expect(await ignoreList()).toBe(crlf);
    });

    it('writes no ignore list where there is none', async () => {
      const adapter = await instance();
      await put('plugins/rootbuilder/rootbuilder.manifest.json');

      await adapter.writeOtherManifestLines();

      expect(existsSync(join(root, '.gitignore'))).toBe(false);
    });
  });

  it('shows git exactly the whitelist: the manifests, each profile\'s orders and INIs, and the configuration', async () => {
    const adapter = await instance();
    runGit('init', '--quiet');
    const listed = [
      'ModOrganizer.ini', 'profiles/Default/modlist.txt', 'profiles/Default/plugins.txt', 'profiles/Default/loadorder.txt',
      'profiles/Default/settings.ini', 'profiles/Default/fallout4prefs.ini', 'mods/Mod A/Mod A.manifest.json',
    ];
    const ignored = [
      'mods/Mod A/Mod A.esp', 'mods/Mod A/textures/a.dds', 'mods/Mod A/readme.ini', 'mods/Mod A/Mod A.json', 'mods/Mod A/Mod A.manifest', 'mods/Mod A/.git/HEAD', 'mods/Mod A/meta.ini', 'mods/Mod B/meta.ini',
      'profiles/Default/saves/save.fos', 'profiles/Default/nested/modlist.txt', 'downloads/Mod.7z', 'downloads/Mod.7z.meta',
      'source/Mod A/Mod A.manifest.json', 'hash-index/hashes.jsonl', 'overwrite/log.txt', 'logs/mo_interface.log', 'webcache/index', 'plugins/x.dll',
    ];
    await Promise.all([...listed, ...ignored].map((path) => put(path)));

    await adapter.writeIgnoreList();

    const shown = runGit('status', '--porcelain', '-z', '--untracked-files=all').split('\0').filter(Boolean).map((line) => line.slice(3));
    expect(shown.sort()).toEqual([...listed, '.gitignore'].sort());
  });

  describe('a source mod with a remote is a submodule', () => {
    const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    const SOURCE_MANIFEST = (output: string): string => JSON.stringify({ output, files: [] });

    async function sourceMod(folder: string, output: string, remote?: string): Promise<string> {
      await put(`source/${folder}/${output}.manifest.json`, SOURCE_MANIFEST(output));
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

      const report = await adapter.writeSubmodules('every');

      runGit('add', '-A', '--', '.');
      expect(report).toEqual({ notes: [], other: [] });
      expect(submodulesNamed()).toEqual(['submodule.Mod A.url https://example.test/a.git']);
      expect(runGit('config', '-f', '.gitmodules', 'submodule.Mod A.branch').trim()).toBe('main');
      expect(runGit('config', '-f', '.gitmodules', 'submodule.Mod A.output').trim()).toBe('Mod A');
      expect(runGit('config', '-f', '.gitmodules', 'submodule.Mod A.path').trim()).toBe('source/Mod A');
      expect(runGit('ls-files', '-s', 'source').trim().split('\n').map((line) => line.slice(0, 6) + line.slice(line.indexOf('\t')))).toEqual(['160000\tsource/Mod A']);
      expect(runGit('ls-files', '.gitmodules')).toBe('.gitmodules\n');
    });

    it('writes the entry and line of the source mods it acts on alone, and keeps those of every other, though it sweeps none', async () => {
      const adapter = await instance();
      runGit('init', '--quiet');
      await adapter.writeIgnoreList();
      await sourceMod('Mod A', 'Mod A', 'https://example.test/a.git');
      await sourceMod('Mod B', 'Mod B', 'https://example.test/b.git');
      await adapter.writeSubmodules(['Mod A']);
      const afterA = submodulesNamed();
      await rm(join(root, 'source', 'Mod A'), { recursive: true });

      await adapter.writeSubmodules(['Mod B']);

      expect([afterA, submodulesNamed(), (await readFile(join(root, '.gitignore'), 'utf8')).includes('Mod A')]).toEqual([
        ['submodule.Mod A.url https://example.test/a.git'],
        ['submodule.Mod A.url https://example.test/a.git', 'submodule.Mod B.url https://example.test/b.git'], true,
      ]);
    });

    it('records the output of a repository whose folder is not cloned, so its mod is built before the clone', async () => {
      const adapter = await instance();
      runGit('init', '--quiet');
      await adapter.writeIgnoreList();
      const path = await sourceMod('Mod A source', 'Mod A', 'https://example.test/a.git');
      await adapter.writeSubmodules('every');
      await rm(path, { recursive: true });
      await rm(join(root, 'source', 'Other'), { recursive: true, force: true });

      const sources = await adapter.sourceMods();

      expect([sources.builds('mod a'), sources.builds('Mod B'), sources.folderOf('Mod A')]).toEqual([true, false, undefined]);
    });

    it('lets the manifest of a cloned repository speak, not the output .gitmodules recorded before a rename', async () => {
      const adapter = await instance();
      runGit('init', '--quiet');
      await adapter.writeIgnoreList();
      await sourceMod('Mod A source', 'Mod A', 'https://example.test/a.git');
      await adapter.writeSubmodules('every');
      await rm(join(root, 'source', 'Mod A source', 'Mod A.manifest.json'));
      await put('source/Mod A source/Mod B.manifest.json', SOURCE_MANIFEST('Mod B'));

      const sources = await adapter.sourceMods();

      expect([sources.builds('Mod A'), sources.builds('Mod B')]).toEqual([false, true]);
    });

    it('takes back the output when the source is trashed, uncloned or not, and keeps the entry for update manifest', async () => {
      const adapter = await instance();
      runGit('init', '--quiet');
      await adapter.writeIgnoreList();
      await sourceMod('Mod A source', 'Mod A', 'https://example.test/a.git');
      await adapter.writeSubmodules('every');

      await adapterOver(root).trashSourceFolder('Mod A', (path) => rm(path, { recursive: true }));

      const sources = await adapter.sourceMods();
      expect([sources.builds('Mod A'), runGit('config', '-f', '.gitmodules', 'submodule.Mod A source.url').trim()]).toEqual([false, 'https://example.test/a.git']);
    });

    it('notes a .gitmodules it cannot read, rather than naming no uncloned source mod in silence', async () => {
      const adapter = await instance();
      await put('.gitmodules', '[submodule "A"\n');

      const { notes } = await adapter.sourceMods();

      expect(notes).toEqual([expect.stringContaining('.gitmodules could not be read')]);
    });

    it('changes nothing when the source mods are as the last call left them', async () => {
      const adapter = await instance();
      runGit('init', '--quiet');
      await adapter.writeIgnoreList();
      await sourceMod('Mod A', 'Mod A', 'https://example.test/a.git');
      await adapter.writeSubmodules('every');
      const before = [await readFile(join(root, '.gitmodules'), 'utf8'), await readFile(join(root, '.gitignore'), 'utf8')];

      await adapter.writeSubmodules('every');

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
      await adapter.writeSubmodules('every');
      await rm(gone, { recursive: true });
      git(unlinked, 'remote', 'remove', 'origin');

      await adapter.writeSubmodules('every');

      expect(submodulesNamed()).toEqual(['submodule.Kept.url https://example.test/k.git']);
      const ignoreList = await readFile(join(root, '.gitignore'), 'utf8');
      expect([ignoreList.includes('Gone'), ignoreList.includes('Unlinked'), ignoreList.includes('Kept'), ignoreList.includes('mine/')]).toEqual([false, false, true, true]);
    });

    it('writes the entry of a source mod by the folder it is in, whatever mod its build names', async () => {
      const adapter = await instance();
      runGit('init', '--quiet');
      await sourceMod('Old Name', 'New Name', 'https://example.test/n.git');

      await adapter.writeSubmodules('every');

      expect(runGit('config', '-f', '.gitmodules', 'submodule.Old Name.path').trim()).toBe('source/Old Name');
    });

    async function submoduleOfOne(): Promise<{ adapter: Awaited<ReturnType<typeof instance>>; folder: string }> {
      const adapter = await instance();
      runGit('init', '--quiet');
      await adapter.writeIgnoreList();
      const folder = await sourceMod('Mod A', 'Mod A', 'https://example.test/a.git');
      await adapter.writeSubmodules('every');
      return { adapter, folder };
    }

    const urlOf = (): string => runGit('config', '-f', '.gitmodules', 'submodule.Mod A.url').trim();

    it('writes its remote with no credential', async () => {
      const adapter = await instance();
      runGit('init', '--quiet');
      await sourceMod('Mod A', 'Mod A', 'https://user:token@example.test/a.git');

      const report = await adapter.writeSubmodules('every');

      expect([report.notes, urlOf()]).toEqual([[], 'https://example.test/a.git']);
    });

    it.each([
      ['https://user:p@ss@example.test/a.git', 'its remote holds a credential that cannot safely be left out of its URL, so it is no submodule'],
      ['../a', 'its remote is on this machine alone, so it is no submodule'],
    ])('takes the entry and the line of a source mod whose remote %s is no host, and names it', async (remote, note) => {
      const { adapter, folder } = await submoduleOfOne();
      git(folder, 'remote', 'set-url', 'origin', remote);

      const report = await adapter.writeSubmodules('every');

      expect([
        report.notes, runGit('config', '-f', '.gitmodules', '--list').trim(), (await readFile(join(root, '.gitignore'), 'utf8')).includes('Mod A'),
      ]).toEqual([[{ mod: 'Mod A', note }], '', false]);
    });

    describe('a source mod\'s host', () => {
      const UNSAFE = 'its remote holds a credential that cannot safely be left out of its URL';
      const LOCAL = 'its remote is on this machine alone';

      it.each([
        ['https://example.test/a.git', { kind: 'host', url: 'https://example.test/a.git' }],
        ['https://user:token@example.test/a.git', { kind: 'host', url: 'https://example.test/a.git' }],
        ['ssh://git:secret@example.test/a.git', { kind: 'host', url: 'ssh://git@example.test/a.git' }],
        ['git@example.test:owner/a.git', { kind: 'host', url: 'git@example.test:owner/a.git' }],
        ['https://user:p@ss@example.test/a.git', { kind: 'noHost', why: UNSAFE }],
        ['ssh://git:p@ss@example.test/a.git', { kind: 'noHost', why: UNSAFE }],
        ['user:secret@example.test:a.git', { kind: 'noHost', why: UNSAFE }],
        ['../a', { kind: 'noHost', why: LOCAL }],
        ['/srv/a.git', { kind: 'noHost', why: LOCAL }],
        ['C:\\srv\\a.git', { kind: 'noHost', why: LOCAL }],
        ['file:///srv/a.git', { kind: 'noHost', why: LOCAL }],
      ])('reads the remote %s as %j', async (remote, host) => {
        const adapter = await instance();
        const folder = await sourceMod('Mod A', 'Mod A', remote);

        expect(await adapter.sourceHost(folder)).toEqual({ kind: 'read', answer: host });
      });

      it.each([
        ['fork', 'origin', 'origin'],
        ['upstream', 'fork', 'fork'],
      ])('reads origin, else the first remote by name, of %s and %s', async (first, second, read) => {
        const adapter = await instance();
        const folder = await sourceMod('Mod A', 'Mod A');
        git(folder, 'remote', 'add', first, `https://example.test/${first}.git`);
        git(folder, 'remote', 'add', second, `https://example.test/${second}.git`);

        expect(await adapter.sourceHost(folder)).toEqual({ kind: 'read', answer: { kind: 'host', url: `https://example.test/${read}.git` } });
      });

      it('reads a repository with no remote as having none', async () => {
        const adapter = await instance();

        expect(await adapter.sourceHost(await sourceMod('Mod A', 'Mod A'))).toEqual({ kind: 'read', answer: { kind: 'noRemote' } });
      });
    });

    it('names a source mod with a remote and no branch checked out, and writes no entry for it', async () => {
      const adapter = await instance();
      runGit('init', '--quiet');
      const detached = await sourceMod('Detached', 'Detached', 'https://example.test/d.git');
      git(detached, 'checkout', '--quiet', '--detach');

      const report = await adapter.writeSubmodules('every');

      expect([report.notes, existsSync(join(root, '.gitmodules'))]).toEqual([[{ mod: 'Detached', note: expect.stringContaining('branch') as unknown }], false]);
    });

    it('keeps the entry and the line of a source mod whose branch it cannot read, and names it', async () => {
      const { adapter, folder } = await submoduleOfOne();
      git(folder, 'checkout', '--quiet', '--detach');

      const report = await adapter.writeSubmodules('every');

      expect([report.notes.map(({ mod }) => mod), urlOf(), (await readFile(join(root, '.gitignore'), 'utf8')).includes('Mod A')]).toEqual([['Mod A'], 'https://example.test/a.git', true]);
    });

    it('names a source mod whose remote it cannot read, writes the others, and keeps its entry', async () => {
      const { adapter, folder } = await submoduleOfOne();
      await sourceMod('Mod B', 'Mod B', 'https://example.test/b.git');
      await writeFile(join(folder, '.git', 'config'), '[remote "origin"\n');

      const report = await adapter.writeSubmodules('every');

      expect([report.notes.map(({ mod }) => mod), urlOf(), submodulesNamed().length]).toEqual([['Mod A'], 'https://example.test/a.git', 2]);
    });

    it('takes the entry of a source mod whose folder name holds brackets when it is gone, and goes on', async () => {
      const adapter = await instance();
      runGit('init', '--quiet');
      await adapter.writeIgnoreList();
      const bracketed = await sourceMod('[NoDelete] Foo', '[NoDelete] Foo', 'https://example.test/f.git');
      await sourceMod('Kept', 'Kept', 'https://example.test/k.git');
      await adapter.writeSubmodules('every');
      await rm(bracketed, { recursive: true });

      const report = await adapter.writeSubmodules('every');

      expect([report, submodulesNamed()]).toEqual([{ notes: [], other: [] }, ['submodule.Kept.url https://example.test/k.git']]);
      expect(await readFile(join(root, '.gitignore'), 'utf8')).not.toContain('NoDelete');
    });

    it('keeps the entry and the line of a source mod whose manifest it cannot read, and says which', async () => {
      const { adapter, folder } = await submoduleOfOne();
      await writeFile(join(folder, 'Mod A.manifest.json'), 'not json');

      const report = await adapter.writeSubmodules('every');

      expect([report.other, urlOf(), (await readFile(join(root, '.gitignore'), 'utf8')).includes('Mod A')]).toEqual([
        [expect.stringContaining('Mod A') as unknown], 'https://example.test/a.git', true,
      ]);
    });

    it('writes the lines that let it in after every line written after them, and changes nothing when nothing changed', async () => {
      const adapter = await instance();
      runGit('init', '--quiet');
      await adapter.writeIgnoreList();
      await sourceMod('Mod A', 'Mod A', 'https://example.test/a.git');
      await adapter.writeSubmodules('every');
      await put('.gitignore', `${await readFile(join(root, '.gitignore'), 'utf8')}after/\n`);
      await adapter.writeSubmodules('every');
      const before = await readFile(join(root, '.gitignore'), 'utf8');
      await adapter.writeSubmodules('every');
      const unchanged = await readFile(join(root, '.gitignore'), 'utf8');
      await sourceMod('Mod B', 'Mod B', 'https://example.test/b.git');

      await adapter.writeSubmodules('every');
      const lines = (await readFile(join(root, '.gitignore'), 'utf8')).split('\n');

      expect([unchanged, lines.indexOf('after/') < lines.indexOf('!/source/Mod A'), lines.at(-3), lines.at(-2)])
        .toEqual([before, true, '!/source/Mod B', '# End of source mods with a remote']);
    });

    it.each([
      ['begin', '# Source mods with a remote\n!/source/\n'],
      ['end', '!/source/\n# End of source mods with a remote\n'],
    ])('leaves the ignore list as it is when its block has only an %s marker, and names it', async (_marker, block) => {
      const adapter = await instance();
      runGit('init', '--quiet');
      await adapter.writeIgnoreList();
      await put('.gitignore', `${await readFile(join(root, '.gitignore'), 'utf8')}${block}mine/\n`);
      const before = await readFile(join(root, '.gitignore'), 'utf8');
      await sourceMod('Mod A', 'Mod A', 'https://example.test/a.git');

      const report = await adapter.writeSubmodules('every');

      expect([await readFile(join(root, '.gitignore'), 'utf8'), report.other]).toEqual([before, [expect.stringContaining(join(root, '.gitignore')) as unknown]]);
    });

    it('keeps the lines of the ignore list it did not write, including blank lines and its own let-in of a source folder', async () => {
      const adapter = await instance();
      runGit('init', '--quiet');
      await adapter.writeIgnoreList();
      const mine = `${await readFile(join(root, '.gitignore'), 'utf8')}\n!/source/\n/source/*\n!/source/Mine\n\nnotes/\n`;
      await put('.gitignore', mine);
      await sourceMod('Mod A', 'Mod A', 'https://example.test/a.git');

      await adapter.writeSubmodules('every');
      await adapter.writeSubmodules('every');
      const lines = (await readFile(join(root, '.gitignore'), 'utf8')).split('\n').slice(0, -1);

      expect([lines.filter((line) => line === '!/source/Mine').length, lines.includes('notes/'), lines.includes('!/source/Mod A'), lines.filter((line) => line === '').length]).toEqual([1, true, true, 2]);
    });

    it('says, naming it, that a pre-push hook is already in the repository', async () => {
      const adapter = await instance();
      runGit('init', '--quiet');
      await put('.git/hooks/pre-push', 'mine\n');

      await expect(adapter.checkPushRefusalFree()).rejects.toThrow(join(root, '.git', 'hooks', 'pre-push'));
    });

    it('refuses before the repository exists when the global core.hooksPath points outside the instance, naming it and where', async () => {
      const adapter = await instance();
      await put('global.config', `[core]\n\thooksPath = ${join(root, 'global-hooks').replaceAll('\\', '/')}\n`);
      vi.stubEnv('GIT_CONFIG_GLOBAL', join(root, 'global.config'));

      try {
        await expect(adapter.checkPushRefusalFree()).rejects.toThrow(new RegExp(`core\\.hooksPath.*${join(root, 'global-hooks').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('rejects with git\'s reason when the global config is malformed, rather than reading no hooks path', async () => {
      const adapter = await instance();
      await put('global.config', '[core]\n\thooksPath = C:\\Users\\x\\hooks\n');
      vi.stubEnv('GIT_CONFIG_GLOBAL', join(root, 'global.config'));

      try {
        await expect(adapter.checkPushRefusalFree()).rejects.toThrow(/bad config/);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('reads a ~ in core.hooksPath as git does, so the refusal names where it points', async () => {
      const adapter = await instance();
      await put('global.config', '[core]\n\thooksPath = ~/.githooks\n');
      vi.stubEnv('GIT_CONFIG_GLOBAL', join(root, 'global.config'));
      vi.stubEnv('HOME', root);

      try {
        await expect(adapter.checkPushRefusalFree()).rejects.toThrow(join(root, '.githooks'));
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('reads from disk whether the instance folder holds a repository', async () => {
      const adapter = await instance();
      const before = await adapter.repositoryOnDisk();
      runGit('init', '--quiet');

      expect([before, await adapter.repositoryOnDisk()]).toEqual([false, true]);
    });

    it('does not take back a repository that holds a commit, which git init did not make', async () => {
      const adapter = await instance();
      runGit('init', '--quiet');
      runGit('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'mine');

      await expect(adapter.removeRepository()).rejects.toThrow(join(root, '.git'));

      expect(runGit('log', '--format=%s').trim()).toBe('mine');
    });

    it('takes the repository it made back, leaving nothing of it', async () => {
      const adapter = await instance();
      runGit('init', '--quiet');

      await adapter.removeRepository();

      expect(existsSync(join(root, '.git'))).toBe(false);
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

      async function pinnedSourceMods(names: readonly string[]) {
        const adapter = await instance();
        runGit('init', '--quiet', '--initial-branch=main');
        runGit('config', 'user.name', 't');
        runGit('config', 'user.email', 't@t');
        await adapter.writeIgnoreList();
        const hosted = (name: string): string => `https://example.test/${encodeURIComponent(name)}.git`;
        const mods = await Promise.all(names.map((name) => sourceMod(name, name, hosted(name))));
        await adapter.writeSubmodules('every');
        const pinned = await Promise.all(mods.map(async (mod) => ({ mod, modRemote: await bareRepository() })));
        for (const { mod } of pinned) {
          for (const [index, { modRemote }] of pinned.entries()) git(mod, 'config', `url.${modRemote}.insteadOf`, hosted(names[index] ?? ''));
        }
        runGit('remote', 'add', 'origin', await bareRepository());
        return { adapter, pinned };
      }

      async function pinnedSourceMod() {
        const { adapter, pinned: [only] } = await pinnedSourceMods(['Mod A']);
        if (only === undefined) throw new Error('no source mod was pinned');
        return { adapter, ...only };
      }

      const pin = (): void => {
        runGit('add', '-A');
        runGit('commit', '--quiet', '--allow-empty', '-m', 'pin');
      };
      const pushRefusal = (): string | undefined => {
        const { status, stderr } = spawnSync('git', ['push', '--quiet', 'origin', 'main'], { cwd: root, encoding: 'utf8' });
        return status === 0 ? undefined : stderr;
      };

      const REMOTE_LACKS = /Push refused: source\/Mod A pins \w+, which https:\/\/example\.test\/Mod%20A\.git lacks\./;

      it('is refused, naming the remote, while the source mod was never pushed', async () => {
        const { adapter } = await pinnedSourceMod();
        await adapter.refuseUnpublishedPins();
        pin();

        expect(pushRefusal()).toMatch(REMOTE_LACKS);
      });

      it('is allowed once the source mod\'s remote holds the pin', async () => {
        const { adapter, mod } = await pinnedSourceMod();
        await adapter.refuseUnpublishedPins();
        git(mod, 'push', '--quiet', 'origin', 'main');
        pin();

        expect(pushRefusal()).toBeUndefined();
      });

      it('is refused while a pin it changes is missing from the source mod\'s remote', async () => {
        const { adapter, mod } = await pinnedSourceMod();
        await adapter.refuseUnpublishedPins();
        git(mod, 'push', '--quiet', 'origin', 'main');
        pin();
        const first = pushRefusal();
        git(mod, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'second');
        pin();

        expect([first, pushRefusal()]).toEqual([undefined, expect.stringMatching(REMOTE_LACKS)]);
      });

      it('is refused while the source mod\'s remote has dropped the pin since the source mod last fetched', async () => {
        const { adapter, mod, modRemote } = await pinnedSourceMod();
        await adapter.refuseUnpublishedPins();
        git(mod, 'push', '--quiet', 'origin', 'main');
        git(modRemote, 'update-ref', '-d', 'refs/heads/main');
        pin();

        expect(pushRefusal()).toMatch(REMOTE_LACKS);
      });

      it('is allowed while the source mod\'s remote holds the pin from a push the source mod never fetched', async () => {
        const { adapter, mod, modRemote } = await pinnedSourceMod();
        await adapter.refuseUnpublishedPins();
        git(mod, 'push', '--quiet', 'origin', 'main');
        git(mod, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'second');
        git(mod, 'push', '--quiet', modRemote, 'main');
        pin();

        expect(pushRefusal()).toBeUndefined();
      });

      it('is refused, saying so, while the pushed .gitmodules names no remote for the pin, whatever the working tree\'s names', async () => {
        const { adapter, mod } = await pinnedSourceMod();
        await adapter.refuseUnpublishedPins();
        git(mod, 'push', '--quiet', 'origin', 'main');
        const named = await readFile(join(root, '.gitmodules'), 'utf8');
        runGit('config', '-f', '.gitmodules', '--remove-section', 'submodule.Mod A');
        pin();
        await put('.gitmodules', named);

        expect(pushRefusal()).toMatch(/Push refused: source\/Mod A pins \w+, and \.gitmodules names no remote for it\./);
      });

      it('judges each pin by its own source mod\'s remote, though another source mod\'s remote holds it', async () => {
        const { adapter, pinned: [first, second] } = await pinnedSourceMods(['Mod A', 'Mod B']);
        await adapter.refuseUnpublishedPins();
        git(first?.mod ?? '', 'push', '--quiet', 'origin', 'main');
        git(second?.mod ?? '', 'push', '--quiet', first?.modRemote ?? '', 'main:refs/heads/second');
        pin();

        expect(pushRefusal()).toMatch(/Push refused: source\/Mod B pins \w+, which https:\/\/example\.test\/Mod%20B\.git lacks\./);
      });

      it('is refused, saying so, while the source mod\'s remote cannot be reached', async () => {
        const { adapter, mod, modRemote } = await pinnedSourceMod();
        await adapter.refuseUnpublishedPins();
        git(mod, 'push', '--quiet', 'origin', 'main');
        await rm(modRemote, { recursive: true, force: true });
        pin();

        expect(pushRefusal()).toMatch(/Push refused: source\/Mod A pins \w+, and https:\/\/example\.test\/Mod%20A\.git could not be reached to verify it\./);
      });

      it('writes no hook outside the repository, whatever core.hooksPath points at, and says so', async () => {
        const adapter = await instance();
        runGit('init', '--quiet');
        runGit('config', 'core.hooksPath', join(root, 'my-hooks'));

        await expect(adapter.refuseUnpublishedPins()).rejects.toThrow(/core\.hooksPath.*my-hooks/);

        expect(existsSync(join(root, 'my-hooks'))).toBe(false);
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

      it('takes a pre-push hook already in a clone as written when it is Modbench\'s own', async () => {
        const adapter = await instance();
        runGit('init', '--quiet');
        await put('.git/hooks/pre-push', PRE_PUSH_HOOK);

        await adapter.refuseUnpublishedPins();

        expect(await readFile(join(root, '.git', 'hooks', 'pre-push'), 'utf8')).toBe(PRE_PUSH_HOOK);
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

describe('the MO2 adapter\'s submodules', () => {
  const PIN = 'a'.repeat(40);

  async function holding(entry: readonly string[], staged: 'pin' | 'file' | 'nothing' = 'pin') {
    const adapter = await instance();
    runGit('init', '--quiet');
    for (const [key, value] of [['path', 'source/Mod Source'], ...entry.map((line) => line.split('='))]) {
      runGit('config', '-f', '.gitmodules', `submodule.Mod Source.${key}`, value ?? '');
    }
    if (staged !== 'nothing') runGit('update-index', '--add', '--cacheinfo', `${staged === 'pin' ? '160000' : '100644'},${PIN},source/Mod Source`);
    return adapter;
  }

  it('reads where git checks a submodule out, the commit the index pins and the branch it follows', async () => {
    const adapter = await holding(['branch=main']);

    expect(await adapter.submodule('Mod Source')).toEqual({ folder: join(root, 'source', 'Mod Source'), pin: PIN, branch: 'main' });
  });

  it('reads a submodule that follows no branch as following none', async () => {
    const adapter = await holding([]);

    expect(await adapter.submodule('Mod Source')).toEqual({ folder: join(root, 'source', 'Mod Source'), pin: PIN });
  });

  it.each(['nothing', 'file'] as const)('says the instance repository pins no commit for a submodule where its index holds %s', async (staged) => {
    const adapter = await holding([], staged);

    expect(await adapter.submodule('Mod Source')).toEqual({ lacks: 'the instance repository pins no commit at source/Mod Source' });
  });

  it('says .gitmodules names no submodule of a name it lacks', async () => {
    const adapter = await holding([]);

    expect(await adapter.submodule('Other')).toEqual({ lacks: `${join(root, '.gitmodules')} names no submodule 'Other'` });
  });

  it('names each submodule whose folder holds no repository as uncloned, with its pin or what the index lacks of it', async () => {
    const pinned = await holding(['branch=main']);
    expect(await pinned.unclonedSubmodules()).toEqual([{ name: 'Mod Source', folder: join(root, 'source', 'Mod Source'), pin: PIN, branch: 'main' }]);

    runGit('rm', '--cached', '--quiet', 'source/Mod Source');
    expect(await pinned.unclonedSubmodules()).toEqual([{ name: 'Mod Source', lacks: 'the instance repository pins no commit at source/Mod Source' }]);

    await mkdir(join(root, 'source', 'Mod Source', '.git'), { recursive: true });
    expect(await pinned.unclonedSubmodules()).toEqual([]);
  });
});

describe('the MO2 adapter\'s game files', () => {
  const HASH_OF_AAAA = 'Mr+EvxoNp0I=';
  const HASH_OF_BBBB = 'M5WSec/sW34=';
  const HASH_OF_CCCC = 'rYontyeqpd8=';

  it('hands the game file at each path of a mod\'s files, named as the game folder names it, and none for a path the game folder lacks', async () => {
    const adapter = await instance();
    await put('game/Data/Meshes/A.nif', 'aaaa');
    await put('game/Data/b.dds', 'bbbb');

    const found = await adapter.gameFiles(gamePlace(), ['Data/meshes/a.nif', 'Data/mine.nif', 'Data/MESHES']);

    expect(found).toEqual({ files: [{ path: 'Data/Meshes/A.nif', hash: HASH_OF_AAAA }], unreadable: {} });
  });

  it.skipIf(process.platform === 'win32')('(a link needs no privilege on POSIX) hands no game file for a path through or to a symlink in the Data folder', async () => {
    const adapter = await instance();
    await put('elsewhere/A.nif', 'aaaa');
    await put('elsewhere/b.dds', 'bbbb');
    await mkdir(join(root, 'game', 'Data'), { recursive: true });
    await symlink(join(root, 'elsewhere'), join(root, 'game', 'Data', 'Meshes'));
    await symlink(join(root, 'elsewhere', 'b.dds'), join(root, 'game', 'Data', 'b.dds'));

    expect(await adapter.gameFiles(gamePlace(), ['Data/meshes/a.nif', 'Data/b.dds'])).toEqual({ files: [], unreadable: {} });
  });

  it('hands no game file for a path that is a hard link in the Data folder, a link being a deployed file', async () => {
    const adapter = await instance();
    await put('elsewhere/own.dds', 'cccc');
    await put('game/Data/Textures/c.dds', 'cccc');
    await link(join(root, 'elsewhere', 'own.dds'), join(root, 'game', 'Data', 'Textures', 'own.dds'));

    const found = await adapter.gameFiles(gamePlace(), ['Data/textures/own.dds', 'Data/textures/c.dds']);

    expect(found).toEqual({ files: [{ path: 'Data/Textures/c.dds', hash: HASH_OF_CCCC }], unreadable: {} });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('(Windows has no POSIX mode bits, and root reads every folder) answers unreadable, with why, only the paths whose folder cannot be listed, not that they are absent', async () => {
    const adapter = await instance();
    await put('game/Data/Meshes/a.nif', 'aaaa');
    await put('game/Data/b.dds', 'aaaa');
    const meshes = join(root, 'game', 'Data', 'Meshes');
    await chmod(meshes, 0o000);

    try {
      expect(await adapter.gameFiles(gamePlace(), ['Data/meshes/a.nif', 'Data/NotInGame.txt', 'Data/B.dds', 'Data/Textures/c.dds']))
        .toEqual({ files: [{ path: 'Data/b.dds', hash: HASH_OF_AAAA }], unreadable: { 'Data/meshes/a.nif': expect.stringMatching(/EACCES/) as unknown } });
    } finally {
      await chmod(meshes, 0o755);
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('(Windows has no POSIX mode bits, and root reads every folder) refuses the game files a mod takes only when one of its own folders cannot be listed', async () => {
    const adapter = await instance();
    await put('game/Data/Meshes/a.nif', 'aaaa');
    await put('game/Data/b.dds', 'bbbb');
    await put('mods/Mod/b.dds', 'bbbb');
    await put('mods/Other/meshes/a.nif', 'aaaa');
    const meshes = join(root, 'game', 'Data', 'Meshes');
    await chmod(meshes, 0o000);

    try {
      expect(await adapter.gameFilesTakenBy(gamePlace(), join(root, 'mods', 'Mod'))).toMatchObject({ kind: 'read', answer: { gameFiles: [{ path: 'Data/b.dds' }] } });
      expect(await adapter.gameFilesTakenBy(gamePlace(), join(root, 'mods', 'Other'))).toMatchObject({ kind: 'unreadable', reason: expect.stringMatching(/EACCES/) as unknown });
    } finally {
      await chmod(meshes, 0o755);
    }
  });

  it('hands the game file where deploy puts each of a mod\'s own files, whichever profile holds the mod', async () => {
    const adapter = await instance();
    await put('game/Data/a.nif', 'aaaa');
    await put('game/Fallout4.exe', 'bbbb');
    await put('game/steam_api64.dll', 'cccc');
    await put('mods/Mod/A.nif', 'zzzz');
    await put('mods/Mod/mine.nif', 'mine');
    await put('mods/Mod/Root/Fallout4.exe', 'exe');
    await put('mods/Mod/steam_api64.dll', 'patched');

    const taken = await adapter.gameFilesTakenBy(gamePlace(), join(root, 'mods', 'Mod'));

    expect(taken).toEqual({
      kind: 'read',
      answer: { notes: [], gameFiles: [{ path: 'Data/a.nif', hash: HASH_OF_AAAA, pathInFolder: 'A.nif' }, { path: 'Fallout4.exe', hash: HASH_OF_BBBB, pathInFolder: 'Root/Fallout4.exe' }] },
    });
  });

  it('hands the game file at each file\'s own path for a folder outside the mod folders, as a copy of the game folder holds it', async () => {
    const adapter = await instance();
    await put('game/Data/Textures/a.dds', 'aaaa');
    await put('game/Data/b.esm', 'bbbb');
    await put('game/Fallout4.exe', 'cccc');
    await put('Stock Game/Data/Textures/a.dds', 'aaaa');
    await put('Stock Game/Data/b.esm', 'zzzz');
    await put('Stock Game/Fallout4.exe', 'exe');

    const taken = await adapter.gameFilesTakenBy(gamePlace(), join(root, 'Stock Game'));

    const gameFiles = [
      { path: 'Data/Textures/a.dds', hash: HASH_OF_AAAA, pathInFolder: 'Data/Textures/a.dds' },
      { path: 'Data/b.esm', hash: HASH_OF_BBBB, pathInFolder: 'Data/b.esm' },
      { path: 'Fallout4.exe', hash: HASH_OF_CCCC, pathInFolder: 'Fallout4.exe' },
    ];
    expect(taken).toEqual({ kind: 'read', answer: { notes: [], gameFiles: expect.arrayContaining(gameFiles) as unknown } });
    expect(taken).toHaveProperty('answer.gameFiles.length', gameFiles.length);
  });

  it.skipIf(process.platform === 'win32')('(a link needs no privilege on POSIX) hands the game files below a Data folder that is a link, as a game folder with its Data on another drive has', async () => {
    const adapter = await instance();
    await put('drive/Data/a.nif', 'aaaa');
    await mkdir(join(root, 'game'), { recursive: true });
    await symlink(join(root, 'drive', 'Data'), join(root, 'game', 'Data'));
    await put('mods/Mod/a.nif', 'aaaa');

    const taken = await adapter.gameFilesTakenBy(gamePlace(), join(root, 'mods', 'Mod'));

    expect(taken).toEqual({ kind: 'read', answer: { gameFiles: [{ path: 'Data/a.nif', hash: HASH_OF_AAAA, pathInFolder: 'a.nif' }], notes: [] } });
  });

  it.skipIf(process.platform === 'win32')('(a link needs no privilege on POSIX) looks a mod folder up as a mod\'s however its path spells the instance', async () => {
    const adapter = await instance();
    await put('game/Data/a.nif', 'aaaa');
    await put('mods/Mod/a.nif', 'aaaa');
    const linked = `${root}-link`;
    await symlink(root, linked);

    try {
      const taken = await adapter.gameFilesTakenBy(gamePlace(), join(linked, 'mods', 'Mod'));

      expect(taken).toEqual({ kind: 'read', answer: { gameFiles: [{ path: 'Data/a.nif', hash: HASH_OF_AAAA, pathInFolder: 'a.nif' }], notes: [] } });
    } finally {
      await rm(linked, { force: true });
    }
  });

  it('hands no game file below the Data folder of a place whose Data folder is another place\'s', async () => {
    const adapter = await instance();
    await put('game/Data/a.nif', 'aaaa');
    await put('game/Fallout4.exe', 'bbbb');
    await put('mods/Mod/a.nif', 'aaaa');
    await put('mods/Mod/Root/Fallout4.exe', 'bbbb');

    const taken = await adapter.gameFilesTakenBy({ ...gamePlace(), holdsDataFiles: false }, join(root, 'mods', 'Mod'));

    expect(taken).toEqual({ kind: 'read', answer: { gameFiles: [{ path: 'Fallout4.exe', hash: HASH_OF_BBBB, pathInFolder: 'Root/Fallout4.exe' }], notes: [] } });
  });
});

it('answers the game files the files below any folder of the instance may be, not its manifest, named for the folder', async () => {
  const adapter = await instance();
  await put('game/Data/a.nif', 'aaaa');
  await put('game/Data/Stock Game.manifest.json', 'manifest');
  await put('Stock Game/Data/a.nif', 'aaaa');
  await put('Stock Game/Stock Game.manifest.json', 'manifest');

  const taken = await adapter.gameFilesTakenBy(gamePlace(), join(root, 'Stock Game'));

  expect(taken).toEqual({ kind: 'read', answer: { gameFiles: [{ path: 'Data/a.nif', hash: 'Mr+EvxoNp0I=', pathInFolder: 'Data/a.nif' }], notes: [] } });
});
