import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { folderTokens, tokenFilter, type PathSpelling, type TokenFolders } from '../pathTokens';

const DRIVER = 'tokens';

const WINDOWS_PROGRAMS: PathSpelling = {
  separators: [{ first: '/', rest: '/' }, { first: '\\', rest: '\\' }, { first: '\\\\', rest: '\\\\' }, { first: '\\\\\\\\', rest: '\\\\' }],
  ends: '"',
};

const NATIVE_JSON: PathSpelling = { separators: [{ first: '\\\\', rest: '\\\\' }], ends: '"', nativeStarts: ['"'] };

const made: string[] = [];

afterEach(async () => {
  await Promise.all(made.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function repositoryFiltering(folders: TokenFolders, platform: NodeJS.Platform, spelling: PathSpelling): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'modbench-token-filter-'));
  made.push(root);
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '--quiet');
  git('config', 'core.autocrlf', 'false');
  const directory = join(root, '.git', 'modbench');
  const { config, programFiles } = tokenFilter(DRIVER, directory, folderTokens(folders, platform, spelling));
  await mkdir(directory);
  for (const [file, text] of Object.entries(programFiles)) await writeFile(file, text);
  for (const [key, value] of Object.entries(config)) git('config', key, value);
  await writeFile(join(root, '.git', 'info', 'attributes'), `* filter=${DRIVER}\n`);
  return root;
}

async function heldByGit(folders: TokenFolders, platform: NodeJS.Platform, text: string, spelling = WINDOWS_PROGRAMS): Promise<string> {
  const root = await repositoryFiltering(folders, platform, spelling);
  await writeFile(join(root, 'file.ini'), text);
  execFileSync('git', ['add', 'file.ini'], { cwd: root });
  return execFileSync('git', ['cat-file', 'blob', ':file.ini'], { cwd: root, encoding: 'utf8' });
}

async function checkedOutByGit(folders: TokenFolders, platform: NodeJS.Platform, held: string, spelling = WINDOWS_PROGRAMS): Promise<string> {
  const root = await repositoryFiltering(folders, platform, spelling);
  const blob = execFileSync('git', ['hash-object', '-w', '--no-filters', '--stdin'], { cwd: root, input: held, encoding: 'utf8' }).trim();
  return execFileSync('git', ['cat-file', '--filters', '--path=file.ini', blob], { cwd: root, encoding: 'utf8' });
}

const SHARE: TokenFolders = { instance: '\\\\nas\\share\\Modlists\\LitR', game: '//nas/share/Games/Fallout 4', downloads: '//nas/share/Downloads', committedOutsideInstance: [] };
const DRIVE: TokenFolders = { instance: 'C:\\Users\\me\\LitR', game: 'D:\\Games\\Fallout 4', downloads: 'E:\\Downloads', committedOutsideInstance: [] };
const PROTON: TokenFolders = { instance: '/home/me/LitR', game: '/home/me/.steam/compatdata/377160/pfx/drive_c/Games/Fallout 4', downloads: '/mnt/data/Downloads', committedOutsideInstance: [] };

describe('the token filter', () => {
  it('cleans and smudges folders whose paths no inline program could carry in a Windows command line', async () => {
    const long = (name: string): string => `C:\\${Array.from({ length: 12 }, (_, at) => `${name}${at}`.padEnd(40, 'x')).join('\\')}`;
    const folders: TokenFolders = { instance: long('instance'), game: long('game'), downloads: long('downloads'), committedOutsideInstance: [] };
    const root = await repositoryFiltering(folders, 'win32', WINDOWS_PROGRAMS);
    const configured = execFileSync('git', ['config', '--get-regexp', '^filter\\.'], { cwd: root, encoding: 'utf8' });

    expect(Math.max(...configured.split('\n').map((line) => line.length))).toBeLessThan(500);
    expect(await heldByGit(folders, 'win32', `x=${folders.downloads}\\a.7z`)).toBe('x={downloads folder:\\}\\a.7z');
    expect(await checkedOutByGit(folders, 'win32', 'x={game folder:/}/Data')).toBe(`x=${folders.game?.replaceAll('\\', '/')}/Data`);
  });

  it.each([
    ['a network share, with backslashes', SHARE, 'win32', 'x=\\\\nas\\share\\Modlists\\LitR\\tools', 'x={instance folder:\\}\\tools'],
    ['a network share, with forward slashes in another case', SHARE, 'win32', 'x=//NAS/share/modlists/LitR/x.exe', 'x={instance folder:/}/x.exe'],
    ['a network share, with escaped backslashes', SHARE, 'win32', 'x=\\"\\\\\\\\nas\\\\share\\\\Modlists\\\\LitR\\\\\\"', 'x=\\"{instance folder:\\\\}\\\\\\"'],
    ['a network share, for the game folder', SHARE, 'win32', 'x=\\\\nas\\share\\Games\\Fallout 4\\Data', 'x={game folder:\\}\\Data'],
    ['a network share, at a line\'s start', SHARE, 'win32', 'x\n\\\\nas\\share\\Modlists\\LitR\\tools', 'x\n{instance folder:\\}\\tools'],
    ['a Wine prefix\'s drive C', PROTON, 'linux', 'x=C:\\\\Games\\\\Fallout 4\\\\Data', 'x={game folder:\\\\}\\\\Data'],
    ['a Wine prefix through drive Z', PROTON, 'linux', 'x=Z:/home/me/.steam/compatdata/377160/pfx/drive_c/Games/Fallout 4/x.exe', 'x={game folder:/}/x.exe'],
    ['a network share, for the downloads folder', SHARE, 'win32', 'x=\\\\nas\\share\\Downloads\\a.7z', 'x={downloads folder:\\}\\a.7z'],
    ['a drive, for the downloads folder in another case', DRIVE, 'win32', 'x=e:/downloads/a.7z', 'x={downloads folder:/}/a.7z'],
    ['a Wine prefix through drive Z, for the downloads folder', PROTON, 'linux', 'x=Z:/mnt/data/Downloads', 'x={downloads folder:/}'],
  ] as const)('holds a folder on %s by its token', async (_place, folders, platform, written, held) => {
    expect(await heldByGit(folders, platform, written)).toBe(held);
  });

  it.each([
    ['the instance folder\'s token, the commit holding no token of its own', 'x=C:/Users/me/LitR/downloads/a.7z', 'x={instance folder:/}/downloads/a.7z', []],
    ['the downloads folder\'s own token, the commit holding it', 'x=C:/Users/me/LitR/downloads/a.7z', 'x={downloads folder:/}/a.7z', ['downloads folder']],
    ['the game folder\'s own token, the commit holding it', 'x=C:/Users/me/LitR/Stock Game/Data', 'x={game folder:/}/Data', ['game folder']],
  ] as const)('holds a game or downloads folder inside the instance folder by %s', async (_token, written, held, committedOutsideInstance) => {
    const inside: TokenFolders = { ...DRIVE, game: 'C:\\Users\\me\\LitR\\Stock Game', downloads: 'C:\\Users\\me\\LitR\\downloads', committedOutsideInstance };

    expect(await heldByGit(inside, 'win32', written)).toBe(held);
  });

  it.each([
    ['a network share, with forward slashes', SHARE, 'win32', 'x={instance folder:/}/tools', 'x=//nas/share/Modlists/LitR/tools'],
    ['a network share, with backslashes', SHARE, 'win32', 'x={instance folder:\\}\\tools', 'x=\\\\nas\\share\\Modlists\\LitR\\tools'],
    ['a network share, with escaped backslashes', SHARE, 'win32', 'x={instance folder:\\\\}\\\\tools', 'x=\\\\\\\\nas\\\\share\\\\Modlists\\\\LitR\\\\tools'],
    ['a network share, with the doubled separator\'s token', SHARE, 'win32', 'x={instance folder:\\\\\\\\}\\\\tools', 'x=\\\\\\\\nas\\\\share\\\\Modlists\\\\LitR\\\\tools'],
    ['a Wine prefix, on its drive C', PROTON, 'linux', 'x={game folder:\\\\}', 'x=C:\\\\Games\\\\Fallout 4'],
    ['a drive, for the downloads folder', DRIVE, 'win32', 'x={downloads folder:/}/a.7z', 'x=E:/Downloads/a.7z'],
  ] as const)('puts the path of a folder on %s in place of its token', async (_place, folders, platform, held, written) => {
    expect(await checkedOutByGit(folders, platform, held)).toBe(written);
  });

  it.each([
    ['Linux, from the root', PROTON, 'linux', '"x": "/home/me/LitR/downloads"', '"x": "{instance folder}/downloads"'],
    ['Linux, for the game folder in a Wine prefix', PROTON, 'linux', '"x": "/home/me/.steam/compatdata/377160/pfx/drive_c/Games/Fallout 4"', '"x": "{game folder}"'],
    ['Windows, on a drive with escaped backslashes', DRIVE, 'win32', '"x": "c:\\\\users\\\\me\\\\LitR\\\\downloads"', '"x": "{instance folder}\\\\downloads"'],
    ['Linux, by a Windows program on Wine', PROTON, 'linux', '"x": "Z:\\\\home\\\\me\\\\LitR\\\\downloads"', '"x": "{instance folder:\\\\}\\\\downloads"'],
  ] as const)('holds a folder in a native file, spelt on %s, by its token', async (_place, folders, platform, written, held) => {
    expect(await heldByGit(folders, platform, written, NATIVE_JSON)).toBe(held);
  });

  it.each([
    ['Linux, from a commit made on Windows', PROTON, 'linux', '"x": "{instance folder}\\\\downloads"', '"x": "/home/me/LitR\\\\downloads"'],
    ['Windows, from a commit made on Linux', DRIVE, 'win32', '"x": "{instance folder}/downloads"', '"x": "C:\\\\Users\\\\me\\\\LitR/downloads"'],
    ['Windows, for the game folder', DRIVE, 'win32', '"x": "{game folder}"', '"x": "D:\\\\Games\\\\Fallout 4"'],
    ['Windows, from a commit a Windows program made on Wine', DRIVE, 'win32', '"x": "{instance folder:\\\\}\\\\downloads"', '"x": "C:\\\\Users\\\\me\\\\LitR\\\\downloads"'],
  ] as const)('puts the folder\'s path in place of its token in a native file on %s', async (_place, folders, platform, held, written) => {
    expect(await checkedOutByGit(folders, platform, held, NATIVE_JSON)).toBe(written);
  });

  it.each([
    ['natively on Linux', PROTON, 'linux', NATIVE_JSON, '"x": "/mnt/x/home/me/LitR/downloads"'],
    ['natively on Linux, after a name that ends in a parenthesis', PROTON, 'linux', NATIVE_JSON, '"x": "/mnt/backup (old)/home/me/LitR/downloads"'],
    ['on Windows, a network share\'s path after a drive', SHARE, 'win32', WINDOWS_PROGRAMS, 'x=D:\\\\nas\\share\\Modlists\\LitR\\tools'],
  ] as const)('holds a path that only ends in a folder\'s path, spelt %s, as it is', async (_place, folders, platform, spelling, written) => {
    expect(await heldByGit(folders, platform, written, spelling)).toBe(written);
  });
});
