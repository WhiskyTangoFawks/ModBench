import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fakeVscodeModule } from '../../../test/mo2/fakeVscodeWatcher';
import { NO_DETECTORS } from '../../../test/noDetectors';
import type { GameDetectors } from '../../gameFolder/gameFolderResolver';
import type { ConfigurationFile } from '../../publisher';
import { sedSubstitution } from '../../pathTokens';
import { managerOver } from '../../../test/mo2/adapterOver';

vi.mock('vscode', () => fakeVscodeModule());


const made: string[] = [];

afterEach(async () => {
  await Promise.all(made.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function folder(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `modbench-path-tokens-${name}-`));
  made.push(path);
  return path;
}

async function gameFolder(): Promise<string> {
  const game = await folder('game');
  await mkdir(join(game, 'Data'));
  return game;
}

const PUBLISHER: ConfigurationFile = {
  name: 'publisher.json',
  spelling: { separators: [{ first: '\\\\', rest: '\\\\' }], ends: '"', nativeStarts: ['"'] },
  blanked: { clean: [sedSubstitution('"Output":"[^"]*"', '"Output":""')], smudge: [] },
};
const PUBLISHER_FILE = PUBLISHER.name;

const steamAt = (game: string): GameDetectors => ({ ...NO_DETECTORS, paths: () => Promise.resolve({ dataFolder: join(game, 'Data') }) });

async function put(root: string, path: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

const onWineDrive = (path: string, separator: string): string =>
  (process.platform === 'win32' ? path : `Z:${path}`).split(/[\\/]/).join(separator);

const SETTINGS = (lines: readonly string[]): string => ['[General]\r\ngameName=Fallout 4\r\nselected_profile=Default', ...lines, ''].join('\r\n');

async function instanceRepository(lines: readonly string[], game?: string, name = 'instance') {
  const root = await folder(name);
  await put(root, 'ModOrganizer.ini', SETTINGS(lines));
  await put(root, 'profiles/Default/modlist.txt', '');
  await mkdir(join(root, 'mods'));
  git(root, 'init', '--quiet');
  git(root, 'config', 'core.autocrlf', 'false');
  return { root, adapter: managerOver(root, { gameFolderSettingValue: game }, PUBLISHER) };
}

const objectsIn = async (root: string): Promise<string[]> => (await readdir(join(root, '.git', 'objects'), { recursive: true })).sort();

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

const programsIn = async (root: string): Promise<[string, string][]> => {
  const folder = join(root, '.git', 'modbench');
  return Promise.all((await readdir(folder)).sort().map(async (name): Promise<[string, string]> => [name, await readFile(join(folder, name), 'utf8')]));
};

const held = (root: string, path: string): string => {
  git(root, 'add', '--', path);
  return git(root, 'cat-file', 'blob', `:${path}`);
};

describe('the MO2 adapter\'s path tokens', () => {
  it.each([
    ['spelt with forward slashes', (root: string) => `path=${onWineDrive(root, '/')}/tools/xEdit.exe`, 'path={instance folder:/}/tools/xEdit.exe'],
    ['spelt with backslashes', (root: string) => `path=${onWineDrive(root, '\\')}\\tools`, 'path={instance folder:\\}\\tools'],
    ['spelt with escaped backslashes', (root: string) => `path=\\"${onWineDrive(root, '\\\\')}\\\\\\"`, 'path=\\"{instance folder:\\\\}\\\\\\"'],
    ['spelt as the folder itself', (root: string) => `path=${onWineDrive(root, '\\\\')}`, 'path={instance folder:\\\\}'],
    ['spelt with its drive\'s separator doubled', (root: string) => `path=@ByteArray(${onWineDrive(root, '\\\\').replace('\\\\', '\\\\\\\\')}\\\\Stock Game)`, 'path=@ByteArray({instance folder:\\\\\\\\}\\\\Stock Game)'],
    ['after a comma', (root: string) => `paths=${onWineDrive(root, '/')}/a,${onWineDrive(root, '/')}/b`, 'paths={instance folder:/}/a,{instance folder:/}/b'],
  ])('holds the instance folder by a token, %s', async (_spelling, written, token) => {
    const { root, adapter } = await instanceRepository([]);
    await put(root, 'ModOrganizer.ini', SETTINGS([written(root)]));

    await adapter.writePathTokens();

    expect(held(root, 'ModOrganizer.ini')).toBe(SETTINGS([token]));
  });

  it('holds the game folder by its own token', async () => {
    const game = await gameFolder();
    const { root, adapter } = await instanceRepository([], game);
    await put(root, 'ModOrganizer.ini', SETTINGS([`gamePath=@ByteArray(${onWineDrive(game, '\\\\')})`]));

    await adapter.writePathTokens();

    expect(held(root, 'ModOrganizer.ini')).toBe(SETTINGS(['gamePath=@ByteArray({game folder:\\\\})']));
  });

  it('holds a game folder inside the instance folder by the instance folder\'s token', async () => {
    const { root } = await instanceRepository([]);
    await mkdir(join(root, 'Stock Game', 'Data'), { recursive: true });
    await put(root, 'profiles/Default/Fallout4Custom.INI', `sPath=${onWineDrive(join(root, 'Stock Game'), '\\')}\r\n`);

    await managerOver(root, { gameFolderSettingValue: join(root, 'Stock Game') }, PUBLISHER).writePathTokens();

    expect(held(root, 'profiles/Default/Fallout4Custom.INI')).toBe('sPath={instance folder:\\}\\Stock Game\r\n');
  });

  it('keeps the game folder\'s own token once the repository holds it, though the game folder then moves into the instance folder', async () => {
    const game = await gameFolder();
    const { root, adapter } = await instanceRepository([], game);
    await put(root, 'ModOrganizer.ini', SETTINGS([`gamePath=@ByteArray(${onWineDrive(game, '\\\\')})`]));
    await adapter.writePathTokens();
    held(root, 'ModOrganizer.ini');
    await mkdir(join(root, 'Stock Game', 'Data'), { recursive: true });
    await put(root, 'ModOrganizer.ini', SETTINGS([`gamePath=@ByteArray(${onWineDrive(join(root, 'Stock Game'), '\\\\')})`]));

    await managerOver(root, { gameFolderSettingValue: join(root, 'Stock Game') }, PUBLISHER).writePathTokens();

    expect(held(root, 'ModOrganizer.ini')).toBe(SETTINGS(['gamePath=@ByteArray({game folder:\\\\})']));
  });

  it('shows each committed file to a diff with this machine\'s paths', async () => {
    const { root, adapter } = await instanceRepository([]);
    const written = SETTINGS([`path=${onWineDrive(root, '/')}/x.exe`]);
    await put(root, 'ModOrganizer.ini', written);
    await adapter.writePathTokens();
    git(root, 'add', '--', 'ModOrganizer.ini');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'paths');

    expect([git(root, 'show', '--textconv', 'HEAD:ModOrganizer.ini'), git(root, 'status', '--porcelain', '--', 'ModOrganizer.ini')]).toEqual([written, '']);
  });

  it('takes a file committed before the game folder was found as changed once the game folder is found', async () => {
    const game = await gameFolder();
    const { root } = await instanceRepository([`1\\binary=${onWineDrive(game, '/')}/Fallout4.exe`]);
    await managerOver(root, {}, PUBLISHER).writePathTokens();
    const anHourAgo = new Date(Date.now() - 3_600_000);
    await utimes(join(root, 'ModOrganizer.ini'), anHourAgo, anHourAgo);
    git(root, 'add', '--', 'ModOrganizer.ini');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'paths');

    await managerOver(root, { gameFolderSettingValue: game }, PUBLISHER).writePathTokens();

    expect(git(root, 'status', '--porcelain', '--', 'ModOrganizer.ini')).toBe(' M ModOrganizer.ini\n');
  });

  it.each(['username', 'password', 'steam_username', 'steam_password', 'nexus_username', 'nexus_password', 'nexus_login', 'nexus_api_key'])(
    'holds the account MO2 writes as %s by a token', async (key) => {
      const { root, adapter } = await instanceRepository([]);
      await put(root, 'ModOrganizer.ini', SETTINGS(['[Settings]', `${key}=Wayne`]));

      await adapter.writePathTokens();

      expect(held(root, 'ModOrganizer.ini')).toBe(SETTINGS(['[Settings]', `${key}={account}`]));
    },
  );

  it('holds a downloads folder outside the instance folder by its own token', async () => {
    const outside = await folder('downloads');
    const { root, adapter } = await instanceRepository([]);
    await put(root, 'ModOrganizer.ini', SETTINGS(['[Settings]', `download_directory=${onWineDrive(outside, '/')}`]));

    await adapter.writePathTokens();

    expect(held(root, 'ModOrganizer.ini')).toBe(SETTINGS(['[Settings]', 'download_directory={downloads folder:/}']));
  });

  it('holds a downloads folder inside the instance folder by the instance folder\'s token, though a file no filter covers holds a downloads token', async () => {
    const { root, adapter } = await instanceRepository([]);
    await put(root, 'README.md', 'Set download_directory to {downloads folder}\n');
    git(root, 'add', '--', 'README.md');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'readme');
    await put(root, 'ModOrganizer.ini', SETTINGS(['[Settings]', `download_directory=${onWineDrive(root, '/')}/dl`]));

    await adapter.writePathTokens();

    expect(held(root, 'ModOrganizer.ini')).toBe(SETTINGS(['[Settings]', 'download_directory={instance folder:/}/dl']));
  });

  it('holds the default downloads folder, which the settings do not name, by the instance folder\'s token', async () => {
    const { root, adapter } = await instanceRepository([]);
    await put(root, 'ModOrganizer.ini', SETTINGS([`path=${onWineDrive(join(root, 'downloads'), '/')}/a.7z`]));

    await adapter.writePathTokens();

    expect(held(root, 'ModOrganizer.ini')).toBe(SETTINGS(['path={instance folder:/}/downloads/a.7z']));
  });

  it('puts a clone\'s own downloads folder in place of the downloads token', async () => {
    const outside = await folder('downloads');
    const { clone, adapter } = await cloned((origin) => ['[Settings]', `download_directory=${onWineDrive(outside, '/')}`, `path=${onWineDrive(origin, '/')}/x`]);

    const left = await adapter.writePathTokens();

    expect([left, await readFile(join(clone, 'ModOrganizer.ini'), 'utf8'), git(clone, 'status', '--porcelain')])
      .toEqual([undefined, SETTINGS(['[Settings]', `download_directory=${onWineDrive(join(clone, 'downloads'), '/')}`, `path=${onWineDrive(clone, '/')}/x`]), '']);
  });

  it('answers no path in a downloads folder outside the instance folder', async () => {
    const outside = await folder('downloads');
    const { root, adapter } = await instanceRepository([]);
    await put(root, 'ModOrganizer.ini', SETTINGS(['[Settings]', `download_directory=${onWineDrive(outside, '/')}`]));
    await adapter.writePathTokens();

    expect(await adapter.pathsOutsideFolders()).toEqual([]);
  });

  it('drops the folders MO2\'s file dialogs last browsed', async () => {
    const { root, adapter } = await instanceRepository([]);
    await put(root, 'ModOrganizer.ini', SETTINGS(['[recentDirectories]', '1\\name=Mod', '1\\directory=D:/Elsewhere', '[Settings]', 'style=dark']));

    await adapter.writePathTokens();

    expect([held(root, 'ModOrganizer.ini'), await adapter.pathsOutsideFolders()]).toEqual([SETTINGS(['[Settings]', 'style=dark']), []]);
  });

  it.each([
    ['a profile\'s INI', 'profiles/Default/Fallout4Custom.ini', '[Settings]\r\nusername=x\r\n'],
    ['another section of ModOrganizer.ini', 'ModOrganizer.ini', SETTINGS(['username=x', '[Settings]', 'style=dark'])],
  ])('holds a username= line in %s as it is', async (_place, file, written) => {
    const { root, adapter } = await instanceRepository([]);
    await put(root, file, written);

    await adapter.writePathTokens();

    expect(held(root, file)).toBe(written);
  });

  it('holds the instance folder by a token when its name holds letters outside ASCII', async () => {
    const { root, adapter } = await instanceRepository([], undefined, 'Jörg');
    await put(root, 'ModOrganizer.ini', SETTINGS([`path=${onWineDrive(root, '/')}/tools`]));

    await adapter.writePathTokens();

    expect(held(root, 'ModOrganizer.ini')).toBe(SETTINGS(['path={instance folder:/}/tools']));
  });

  it('keeps its filter programs where every worktree of the repository finds them', async () => {
    const { root } = await instanceRepository([]);
    git(root, 'add', '--', 'profiles');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'start');
    const linked = join(await folder('worktrees'), 'linked');
    git(root, 'worktree', 'add', '--quiet', linked);
    await put(linked, 'ModOrganizer.ini', SETTINGS(['gamePath=C:/Games']));

    await managerOver(linked, {}, PUBLISHER).writePathTokens();
    git(root, 'worktree', 'remove', '--force', linked);
    await put(root, 'ModOrganizer.ini', SETTINGS([`path=${onWineDrive(linked, '/')}/x.exe`]));

    expect(held(root, 'ModOrganizer.ini')).toBe(SETTINGS(['path={instance folder:/}/x.exe']));
  });

  it('refuses to stage a file the token filter fails on, rather than hold it as it is', async () => {
    const { root, adapter } = await instanceRepository([]);
    await adapter.writePathTokens();
    git(root, 'config', 'filter.modbench-settings-tokens.clean', 'exit 1');

    expect(() => execFileSync('git', ['add', '--', 'ModOrganizer.ini'], { cwd: root, stdio: 'pipe' })).toThrow(/ModOrganizer\.ini/);
  });

  async function cloned(lines: (origin: string, game: string) => readonly string[], detectors?: GameDetectors, publisherSettings?: (origin: string, game: string) => string) {
    const game = await gameFolder();
    const { root, adapter } = await instanceRepository([], game);
    await put(root, 'ModOrganizer.ini', SETTINGS(lines(root, game)));
    if (publisherSettings !== undefined) await put(root, PUBLISHER_FILE, publisherSettings(root, game));
    await adapter.writePathTokens();
    git(root, 'add', '--', 'ModOrganizer.ini', ...(publisherSettings === undefined ? [] : [PUBLISHER_FILE]));
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'paths');
    const clone = join(await folder('clone'), 'modlist');
    git(dirname(clone), 'clone', '--quiet', '--config', 'core.autocrlf=false', root, clone);
    await mkdir(join(clone, 'mods'));
    return { clone, adapter: managerOver(clone, { detectors }, PUBLISHER), game };
  }

  describe('in the publisher\'s configuration', () => {
    const publisherSettings = (instance: string, game: string): string =>
      JSON.stringify({ Source: instance, Downloads: `${instance}${sep}downloads`, GamePath: game }, null, 2);

    it('holds each folder by its native token, and the working tree by this machine\'s paths', async () => {
      const game = await gameFolder();
      const { root, adapter } = await instanceRepository([], game);
      await put(root, PUBLISHER_FILE, publisherSettings(root, game));

      await adapter.writePathTokens();

      expect([held(root, PUBLISHER_FILE), await readFile(join(root, PUBLISHER_FILE), 'utf8')])
        .toEqual([publisherSettings('{instance folder}', '{game folder}'), publisherSettings(root, game)]);
    });

    it.each([
      ['natively', (folder: string) => folder],
      ['by a Windows program on Wine', (folder: string) => onWineDrive(folder, '\\')],
    ])('puts a clone\'s own folders in place of their tokens, spelt %s, and git holds the clone as committed', async (_spelt, spelt) => {
      const steam = await gameFolder();
      const { clone, adapter } = await cloned(() => [], steamAt(steam), (origin, game) => publisherSettings(spelt(origin), spelt(game)));

      await adapter.writePathTokens();

      expect([await readFile(join(clone, PUBLISHER_FILE), 'utf8'), git(clone, 'status', '--porcelain')])
        .toEqual([publisherSettings(spelt(clone), spelt(steam)), '']);
    });

    it('blanks what it holds of this machine alone', async () => {
      const { root, adapter } = await instanceRepository([]);
      await put(root, PUBLISHER_FILE, JSON.stringify({ Source: root, Output: join(root, 'list.out') }));

      await adapter.writePathTokens();

      expect([held(root, PUBLISHER_FILE), await adapter.pathsOutsideFolders()]).toEqual([JSON.stringify({ Source: '{instance folder}', Output: '' }), []]);
    });

    it('answers each path outside the two folders as a commit would hold it', async () => {
      const game = await gameFolder();
      const { root, adapter } = await instanceRepository([], game);
      const outside = join(tmpdir(), 'Life in the Ruins.wabbajack');
      await put(root, PUBLISHER_FILE, JSON.stringify({ Source: root, GamePath: game, Image: outside }));
      await adapter.writePathTokens();

      expect(await adapter.pathsOutsideFolders()).toEqual([{ file: PUBLISHER_FILE, line: 1, path: JSON.stringify(outside).slice(1, -1) }]);
    });
  });

  describe('on a clone', () => {
    it('puts the clone\'s own instance folder in place of its path token, and git holds the clone as committed', async () => {
      const { clone, adapter } = await cloned((origin) => [`1\\binary=${onWineDrive(origin, '/')}/tools/xEdit.exe`]);

      const left = await adapter.writePathTokens();

      expect([left, await readFile(join(clone, 'ModOrganizer.ini'), 'utf8'), git(clone, 'status', '--porcelain')])
        .toEqual([undefined, SETTINGS([`1\\binary=${onWineDrive(clone, '/')}/tools/xEdit.exe`]), '']);
    });

    it('holds no account, and git holds the clone as committed', async () => {
      const { clone, adapter } = await cloned(() => ['[Settings]', 'steam_username=Wayne']);

      await adapter.writePathTokens();

      expect([await readFile(join(clone, 'ModOrganizer.ini'), 'utf8'), git(clone, 'status', '--porcelain')])
        .toEqual([SETTINGS(['[Settings]', 'steam_username=']), '']);
    });

    it('writes no object into the repository, neither writing the path tokens nor reading what a commit would hold', async () => {
      const { clone, adapter } = await cloned((origin) => [`1\\binary=${onWineDrive(origin, '/')}/tools/xEdit.exe`]);
      await put(clone, 'ModOrganizer.ini', SETTINGS(['1\\binary={instance folder:/}/tools/SSEEdit.exe']));
      const before = await objectsIn(clone);

      await adapter.writePathTokens();
      await adapter.pathsOutsideFolders();

      expect(await objectsIn(clone)).toEqual(before);
    });

    it('finds the game folder where the game path is a path token, and puts it in place of the token', async () => {
      const steam = await gameFolder();
      const { clone, adapter } = await cloned((_origin, game) => [`gamePath=@ByteArray(${onWineDrive(game, '\\\\')})`], steamAt(steam));

      await adapter.writePathTokens();

      expect(await readFile(join(clone, 'ModOrganizer.ini'), 'utf8')).toBe(SETTINGS([`gamePath=@ByteArray(${onWineDrive(steam, '\\\\')})`]));
    });

    it('answers the files that still hold a path token while the game folder is not found', async () => {
      const { adapter } = await cloned((_origin, game) => [`gamePath=@ByteArray(${onWineDrive(game, '\\\\')})`]);

      expect(await adapter.writePathTokens())
        .toBe('ModOrganizer.ini still holds a path token in place of this machine\'s path, because the game folder was not found');
    });
  });

  it('answers each path no path token names in each file git holds or would commit, once, and a file no path token covers with its folders\' paths', async () => {
    const game = await gameFolder();
    const { root, adapter } = await instanceRepository([], game);
    await adapter.writeIgnoreList();
    await put(root, 'ModOrganizer.ini', SETTINGS([
      `1\\binary=${onWineDrive(root, '/')}/tools/xEdit.exe`, `2\\binary=${onWineDrive(game, '/')}/Fallout4.exe`,
      '3\\binary=C:/Modding/Tools/CLASSIC.exe', '3\\workingDirectory=C:\\\\Modding\\\\Tools',
      '4\\arguments=-o:\\"C:\\\\Modding\\\\Out\\" -D:\\"C:\\\\Modding\\\\Out\\"', 'url=https://www.nexusmods.com/fallout4',
      '5\\binary=\\\\\\\\nas\\\\share\\\\x.exe', '6\\binary=//nas/share/y.exe', '7\\arguments=-o:\\\\\\\\nas\\\\share\\\\Inst\\\\out',
    ]));
    await put(root, 'profiles/Default/Fallout4Custom.ini', 'sScreenShotBaseName=/home/me/Pictures/shot\r\n');
    await put(root, 'mods/Mod A/Mod A.manifest.json', `{"path": "C:/Modding/x", "folder": "${onWineDrive(root, '/')}/mods"}`);
    await put(root, '.gitmodules', '[submodule "A"]\n\tpath = source/A\n\turl = https://example.test/a.git\n');
    await adapter.writePathTokens();

    expect(await adapter.pathsOutsideFolders()).toEqual([
      { file: 'ModOrganizer.ini', line: 6, path: 'C:/Modding/Tools/CLASSIC.exe' },
      { file: 'ModOrganizer.ini', line: 7, path: 'C:\\\\Modding\\\\Tools' },
      { file: 'ModOrganizer.ini', line: 8, path: 'C:\\\\Modding\\\\Out' },
      { file: 'ModOrganizer.ini', line: 10, path: '\\\\\\\\nas\\\\share\\\\x.exe' },
      { file: 'ModOrganizer.ini', line: 11, path: '//nas/share/y.exe' },
      { file: 'ModOrganizer.ini', line: 12, path: 'o:\\\\\\\\nas\\\\share\\\\Inst\\\\out' },
      { file: 'mods/Mod A/Mod A.manifest.json', line: 1, path: 'C:/Modding/x' },
      { file: 'mods/Mod A/Mod A.manifest.json', line: 1, path: `${onWineDrive(root, '/')}/mods` },
      { file: 'profiles/Default/Fallout4Custom.ini', line: 1, path: '/home/me/Pictures/shot' },
    ]);
  });

  it('finds no path in a hash a manifest holds, though it starts with a slash, and finds the path beside it', async () => {
    const { root, adapter } = await instanceRepository([]);
    await put(root, 'mods/Plain/Plain.manifest.json',
      '{"installationFile": {"path": "C:/Modding/x.zip", "hash": "/emUNYLj+Fc=", "entries": [{"path": "a.txt", "hash": "/AAECAwQFBgc="}]}}');

    expect(await adapter.pathsOutsideFolders()).toEqual([{ file: 'mods/Plain/Plain.manifest.json', line: 1, path: 'C:/Modding/x.zip' }]);
  });

  it('answers a path once for each line that holds it, and once for a line that holds it twice', async () => {
    const { root, adapter } = await instanceRepository([]);
    await put(root, 'mods/Plain/Plain.manifest.json', '{"a": "C:/Modding/x", "b": "C:/Modding/x"}\n{"c": "C:/Modding/x"}');

    expect(await adapter.pathsOutsideFolders()).toEqual([
      { file: 'mods/Plain/Plain.manifest.json', line: 1, path: 'C:/Modding/x' },
      { file: 'mods/Plain/Plain.manifest.json', line: 2, path: 'C:/Modding/x' },
    ]);
  });

  it('writes nothing in an instance folder that holds no repository, and finds no path in it', async () => {
    const root = await folder('instance');
    await put(root, 'ModOrganizer.ini', SETTINGS(['1\\binary=C:/Modding/x.exe']));
    const adapter = managerOver(root, {}, PUBLISHER);

    expect([await adapter.writePathTokens(), await adapter.pathsOutsideFolders(), await readFile(join(root, 'ModOrganizer.ini'), 'utf8')])
      .toEqual([undefined, [], SETTINGS(['1\\binary=C:/Modding/x.exe'])]);
  });

  it('leaves the config of a repository that already holds its filters as it is', async () => {
    const { root, adapter } = await instanceRepository([]);
    await adapter.writePathTokens();
    const configFile = async (): Promise<bigint[]> => {
      const { ino, mtimeNs } = await stat(join(root, '.git', 'config'), { bigint: true });
      return [ino, mtimeNs];
    };
    const before = await configFile();

    await adapter.writePathTokens();

    expect(await configFile()).toEqual(before);
  });

  it('holds a file by its tokens though the repository held its filter with another program', async () => {
    const { root, adapter } = await instanceRepository([]);
    git(root, 'config', 'filter.modbench-tokens.clean', 'cat');
    await put(root, 'profiles/Default/Fallout4Custom.ini', `sPath=${onWineDrive(root, '\\')}\\Stock Game\r\n`);

    await adapter.writePathTokens();

    expect(held(root, 'profiles/Default/Fallout4Custom.ini')).toBe('sPath={instance folder:\\}\\Stock Game\r\n');
  });

  it('takes back each filter key to the value the repository held when a write fails', async () => {
    const { root } = await instanceRepository([]);
    git(root, 'config', 'filter.modbench-tokens.clean', 'cat');
    const failing = managerOver(root, { gameFolder: () => Promise.reject(new Error('the game folder could not be read')) }, PUBLISHER);

    await expect(failing.writePathTokens()).rejects.toThrow('the game folder could not be read');

    expect(git(root, 'config', '--local', '--list').split('\n').filter((line) => line.includes('modbench-'))).toEqual(['filter.modbench-tokens.clean=cat']);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('(Windows has no POSIX mode bits, and root reads every file) leaves the repository with no filter, no attributes and no config when a first write fails', async () => {
    const { root, adapter } = await instanceRepository([]);
    await put(root, 'profiles/Default/Fallout4Prefs.ini', 'x=1\r\n');
    await chmod(join(root, 'profiles/Default/Fallout4Prefs.ini'), 0o000);

    await expect(adapter.writePathTokens()).rejects.toThrow();

    const config = git(root, 'config', '--local', '--list').split('\n').filter((line) => line.includes('modbench-'));
    expect([config, await readFile(join(root, '.git', 'info', 'attributes'), 'utf8').catch(() => '')]).toEqual([[], '']);
    expect(await exists(join(root, '.git', 'modbench'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('(Windows has no POSIX mode bits, and root reads every file) takes back only the filter a failed write added, and keeps each the repository held', async () => {
    const { root } = await instanceRepository([]);
    await put(root, 'profiles/Default/Fallout4Prefs.ini', 'x=1\r\n');
    const withoutPublisher = managerOver(root);
    await withoutPublisher.writePathTokens();
    const written = async () => [
      git(root, 'config', '--local', '--list').split('\n').filter((line) => line.includes('modbench-')),
      await readFile(join(root, '.git', 'info', 'attributes'), 'utf8'),
      await programsIn(root),
    ];
    const before = await written();
    await chmod(join(root, 'profiles/Default/Fallout4Prefs.ini'), 0o000);

    await expect(managerOver(root, {}, PUBLISHER).writePathTokens()).rejects.toThrow();

    expect(await written()).toEqual(before);
  });
});
