import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fixedGameFolderSetting } from '../../../test/gameFolderSetting';
import { fakeVscodeModule } from '../../../test/mo2/fakeVscodeWatcher';
import { NO_DETECTORS } from '../../../test/noDetectors';
import { fakeInstallationFileReader } from '../../../test/fakeInstallationFileReader';
import type { GameDetectors } from '../../gameFolder/gameFolderResolver';

vi.mock('vscode', () => fakeVscodeModule());

import { mo2InstanceAdapter } from '../mo2Instance';
import { wabbajackPublisher } from '../../wabbajack/wabbajackPublisher';
import { FOMOD_ENGINE } from '../../../test/fomodEngine';

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

const PUBLISHER = wabbajackPublisher('', { neverShipped: [], enabledMods: () => Promise.resolve([]) }).configurationFile;
const PUBLISHER_FILE = PUBLISHER.name;

const adapterOver = (root: string, { game, detectors = NO_DETECTORS }: { game?: string; detectors?: GameDetectors } = {}) => mo2InstanceAdapter({
  instanceRoot: root, gameFolderSetting: fixedGameFolderSetting(game), detectors, installationFileReader: fakeInstallationFileReader([]), fomodEngine: FOMOD_ENGINE,
}, PUBLISHER);

const steamAt = (game: string): GameDetectors => ({ ...NO_DETECTORS, paths: () => Promise.resolve({ dataFolder: join(game, 'Data') }) });

async function put(root: string, path: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

const onWineDrive = (path: string, separator: string): string =>
  (process.platform === 'win32' ? path : `Z:${path}`).split(/[\\/]/).join(separator);

const SETTINGS = (lines: readonly string[]): string => ['[General]\r\ngameName=Fallout 4\r\nselected_profile=Default', ...lines, ''].join('\r\n');

async function instanceRepository(lines: readonly string[], game?: string) {
  const root = await folder('instance');
  await put(root, 'ModOrganizer.ini', SETTINGS(lines));
  await put(root, 'profiles/Default/modlist.txt', '');
  await mkdir(join(root, 'mods'));
  git(root, 'init', '--quiet');
  git(root, 'config', 'core.autocrlf', 'false');
  return { root, adapter: adapterOver(root, { game }) };
}

const objectsIn = async (root: string): Promise<string[]> => (await readdir(join(root, '.git', 'objects'), { recursive: true })).sort();

const held = (root: string, path: string): string => {
  git(root, 'add', '--', path);
  return git(root, 'cat-file', 'blob', `:${path}`);
};

describe('the MO2 adapter\'s path tokens', () => {
  it.each([
    ['forward slashes', (root: string) => `${onWineDrive(root, '/')}/tools/xEdit.exe`, '{instance folder:/}/tools/xEdit.exe'],
    ['backslashes', (root: string) => `${onWineDrive(root, '\\')}\\tools`, '{instance folder:\\}\\tools'],
    ['escaped backslashes', (root: string) => `\\"${onWineDrive(root, '\\\\')}\\\\\\"`, '\\"{instance folder:\\\\}\\\\\\"'],
    ['the folder itself', (root: string) => onWineDrive(root, '\\\\'), '{instance folder:\\\\}'],
    ['its drive\'s separator doubled', (root: string) => `@ByteArray(${onWineDrive(root, '\\\\').replace('\\\\', '\\\\\\\\')}\\\\Stock Game)`, '@ByteArray({instance folder:\\\\\\\\}\\\\Stock Game)'],
  ])('holds the instance folder by a token, spelt with %s', async (_spelling, written, token) => {
    const { root, adapter } = await instanceRepository([]);
    await put(root, 'ModOrganizer.ini', SETTINGS([`path=${written(root)}`]));

    await adapter.writePathTokens();

    expect(held(root, 'ModOrganizer.ini')).toBe(SETTINGS([`path=${token}`]));
  });

  it.each([
    ['unquoted in a program\'s arguments', (root: string) => `4\\arguments=-o ${onWineDrive(root, '\\\\')}\\\\out`, '4\\arguments=-o {instance folder:\\\\}\\\\out'],
    ['in a list\'s second entry', (root: string) => `paths=${onWineDrive(root, '/')}/a, ${onWineDrive(root, '/')}/b`, 'paths={instance folder:/}/a, {instance folder:/}/b'],
    ['after an option\'s colon', (root: string) => `4\\arguments="-o:${onWineDrive(root, '\\\\')}\\\\out"`, '4\\arguments="-o:{instance folder:\\\\}\\\\out"'],
    ['after a semicolon', (root: string) => `paths=${onWineDrive(root, '/')}/a;${onWineDrive(root, '/')}/b`, 'paths={instance folder:/}/a;{instance folder:/}/b'],
    ['after a comma', (root: string) => `paths=${onWineDrive(root, '/')}/a,${onWineDrive(root, '/')}/b`, 'paths={instance folder:/}/a,{instance folder:/}/b'],
  ])('holds the instance folder by a token %s', async (_place, written, token) => {
    const { root, adapter } = await instanceRepository([]);
    await put(root, 'ModOrganizer.ini', SETTINGS([written(root)]));

    await adapter.writePathTokens();

    expect(held(root, 'ModOrganizer.ini')).toBe(SETTINGS([token]));
  });

  it.each([
    ['a longer name',(root: string) => `${onWineDrive(root, '/')}2/x.exe`],
    ['a space and more', (root: string) => `${onWineDrive(root, '/')} Backup/x.exe`],
    ['a plus', (root: string) => `${onWineDrive(root, '/')}+/x.exe`],
    ['a parenthesis', (root: string) => `${onWineDrive(root, '/')}(GOG)/x.exe`],
    ['a letter beyond ASCII', (root: string) => `${onWineDrive(root, '/')}é/x.exe`],
  ])('holds a path whose folder\'s name begins with the instance folder\'s and goes on with %s as it is', async (_name, written) => {
    const { root, adapter } = await instanceRepository([]);
    await put(root, 'ModOrganizer.ini', SETTINGS([`path=${written(root)}`]));

    await adapter.writePathTokens();

    expect(held(root, 'ModOrganizer.ini')).toBe(SETTINGS([`path=${written(root)}`]));
  });

  it('holds the game folder by its own token, and a game folder inside the instance folder by the instance folder\'s', async () => {
    const game = await gameFolder();
    const { root, adapter } = await instanceRepository([], game);
    await mkdir(join(root, 'Stock Game', 'Data'), { recursive: true });
    const stock = adapterOver(root, { game: join(root, 'Stock Game') });
    await put(root, 'ModOrganizer.ini', SETTINGS([`gamePath=@ByteArray(${onWineDrive(game, '\\\\')})`]));
    await put(root, 'profiles/Default/Fallout4Custom.INI', `sPath=${onWineDrive(join(root, 'Stock Game'), '\\')}\r\n`);

    await adapter.writePathTokens();
    const outside = held(root, 'ModOrganizer.ini');
    await stock.writePathTokens();

    expect([outside, held(root, 'profiles/Default/Fallout4Custom.INI')])
      .toEqual([SETTINGS(['gamePath=@ByteArray({game folder:\\\\})']), 'sPath={instance folder:\\}\\Stock Game\r\n']);
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
    await adapterOver(root).writePathTokens();
    const anHourAgo = new Date(Date.now() - 3_600_000);
    await utimes(join(root, 'ModOrganizer.ini'), anHourAgo, anHourAgo);
    git(root, 'add', '--', 'ModOrganizer.ini');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'paths');

    await adapterOver(root, { game }).writePathTokens();

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

  it('holds a downloads folder outside the instance folder by its own token, and one inside by the instance folder\'s', async () => {
    const outside = await folder('downloads');
    const { root, adapter } = await instanceRepository([]);
    await put(root, 'ModOrganizer.ini', SETTINGS(['[Settings]', `download_directory=${onWineDrive(outside, '/')}`]));
    await adapter.writePathTokens();
    const heldOutside = held(root, 'ModOrganizer.ini');
    await put(root, 'ModOrganizer.ini', SETTINGS(['[Settings]', `download_directory=${onWineDrive(root, '/')}/dl`]));
    await adapter.writePathTokens();

    expect([heldOutside, held(root, 'ModOrganizer.ini')])
      .toEqual([SETTINGS(['[Settings]', 'download_directory={downloads folder:/}']), SETTINGS(['[Settings]', 'download_directory={instance folder:/}/dl'])]);
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
    return { clone, adapter: adapterOver(clone, { detectors }), game };
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

    it('blanks the output file, which each compile chooses', async () => {
      const { root, adapter } = await instanceRepository([]);
      await put(root, PUBLISHER_FILE, JSON.stringify({ Source: root, OutputFile: join(root, 'LitR.wabbajack') }));

      await adapter.writePathTokens();

      expect([held(root, PUBLISHER_FILE), await adapter.pathsOutsideFolders()]).toEqual([JSON.stringify({ Source: '{instance folder}', OutputFile: '' }), []]);
    });

    it('answers each path outside the two folders as a commit would hold it', async () => {
      const game = await gameFolder();
      const { root, adapter } = await instanceRepository([], game);
      const outside = join(tmpdir(), 'Life in the Ruins.wabbajack');
      await put(root, PUBLISHER_FILE, JSON.stringify({ Source: root, GamePath: game, Image: outside }));
      await adapter.writePathTokens();

      expect(await adapter.pathsOutsideFolders()).toEqual([{ file: PUBLISHER_FILE, path: JSON.stringify(outside).slice(1, -1) }]);
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
      { file: 'ModOrganizer.ini', path: 'C:/Modding/Tools/CLASSIC.exe' },
      { file: 'ModOrganizer.ini', path: 'C:\\\\Modding\\\\Tools' },
      { file: 'ModOrganizer.ini', path: 'C:\\\\Modding\\\\Out' },
      { file: 'ModOrganizer.ini', path: '\\\\\\\\nas\\\\share\\\\x.exe' },
      { file: 'ModOrganizer.ini', path: '//nas/share/y.exe' },
      { file: 'ModOrganizer.ini', path: 'o:\\\\\\\\nas\\\\share\\\\Inst\\\\out' },
      { file: 'mods/Mod A/Mod A.manifest.json', path: 'C:/Modding/x' },
      { file: 'mods/Mod A/Mod A.manifest.json', path: `${onWineDrive(root, '/')}/mods` },
      { file: 'profiles/Default/Fallout4Custom.ini', path: '/home/me/Pictures/shot' },
    ]);
  });

  it('writes nothing in an instance folder that holds no repository, and finds no path in it', async () => {
    const root = await folder('instance');
    await put(root, 'ModOrganizer.ini', SETTINGS(['1\\binary=C:/Modding/x.exe']));
    const adapter = adapterOver(root);

    expect([await adapter.writePathTokens(), await adapter.pathsOutsideFolders(), await readFile(join(root, 'ModOrganizer.ini'), 'utf8')])
      .toEqual([undefined, [], SETTINGS(['1\\binary=C:/Modding/x.exe'])]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('(Windows has no POSIX mode bits, and root reads every file) leaves the repository with no filter, no attributes and no config when a first write fails', async () => {
    const { root, adapter } = await instanceRepository([]);
    await put(root, 'profiles/Default/Fallout4Prefs.ini', 'x=1\r\n');
    await chmod(join(root, 'profiles/Default/Fallout4Prefs.ini'), 0o000);

    await expect(adapter.writePathTokens()).rejects.toThrow();

    const config = git(root, 'config', '--local', '--list').split('\n').filter((line) => line.includes('modbench-'));
    expect([config, await readFile(join(root, '.git', 'info', 'attributes'), 'utf8').catch(() => '')]).toEqual([[], '']);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('(Windows has no POSIX mode bits, and root reads every file) takes back only the filter a failed write added, and keeps each the repository held', async () => {
    const { root } = await instanceRepository([]);
    await put(root, 'profiles/Default/Fallout4Prefs.ini', 'x=1\r\n');
    const withoutPublisher = mo2InstanceAdapter({
      instanceRoot: root, gameFolderSetting: fixedGameFolderSetting(), detectors: NO_DETECTORS, installationFileReader: fakeInstallationFileReader([]), fomodEngine: FOMOD_ENGINE,
    }, undefined);
    await withoutPublisher.writePathTokens();
    const written = async () => [
      git(root, 'config', '--local', '--list').split('\n').filter((line) => line.includes('modbench-')),
      await readFile(join(root, '.git', 'info', 'attributes'), 'utf8'),
    ];
    const before = await written();
    await chmod(join(root, 'profiles/Default/Fallout4Prefs.ini'), 0o000);

    await expect(adapterOver(root).writePathTokens()).rejects.toThrow();

    expect(await written()).toEqual(before);
  });
});
