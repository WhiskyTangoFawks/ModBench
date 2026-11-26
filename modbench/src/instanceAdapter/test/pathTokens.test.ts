import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { present } from '../../ports/present';
import { folderTokens, tokenFilter, type PathSpelling, type TokenFolders } from '../pathTokens';

const DRIVER = 'tokens';

const WINDOWS_PROGRAMS: PathSpelling = {
  separators: [{ first: '/', rest: '/' }, { first: '\\', rest: '\\' }, { first: '\\\\', rest: '\\\\' }, { first: '\\\\\\\\', rest: '\\\\' }],
  ends: '"',
};

const made: string[] = [];

afterEach(async () => {
  await Promise.all(made.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

const filteredInGitsShellByAnAliasThatNeedsNoRepository = (command: string | undefined, text: string): string =>
  execFileSync('git', ['-c', `alias.filtered=!${present(command, 'the filter\'s command')}`, 'filtered'], { input: text, encoding: 'utf8' });

async function filterConfig(folders: TokenFolders, platform: NodeJS.Platform, spelling: PathSpelling): Promise<Readonly<Record<string, string>>> {
  const directory = await mkdtemp(join(tmpdir(), 'modbench-token-filter-'));
  made.push(directory);
  const { config, programFiles } = tokenFilter(DRIVER, directory, folderTokens(folders, platform, spelling));
  for (const [file, text] of Object.entries(programFiles)) await writeFile(file, text);
  return config;
}

async function heldByGit(folders: TokenFolders, platform: NodeJS.Platform, text: string, spelling = WINDOWS_PROGRAMS): Promise<string> {
  return filteredInGitsShellByAnAliasThatNeedsNoRepository((await filterConfig(folders, platform, spelling))[`filter.${DRIVER}.clean`], text);
}

async function checkedOutByGit(folders: TokenFolders, platform: NodeJS.Platform, held: string, spelling = WINDOWS_PROGRAMS): Promise<string> {
  return filteredInGitsShellByAnAliasThatNeedsNoRepository((await filterConfig(folders, platform, spelling))[`filter.${DRIVER}.smudge`], held);
}

const SHARE: TokenFolders = { instance: '\\\\nas\\share\\Modlists\\LitR', game: '//nas/share/Games/Fallout 4', downloads: '//nas/share/Downloads', committedOutsideInstance: [] };

describe('the token filter, over a network share no test machine holds', () => {
  it.each([
    ['a network share, with backslashes', SHARE, 'win32', 'x=\\\\nas\\share\\Modlists\\LitR\\tools', 'x={instance folder:\\}\\tools'],
    ['a network share, with forward slashes in another case', SHARE, 'win32', 'x=//NAS/share/modlists/LitR/x.exe', 'x={instance folder:/}/x.exe'],
    ['a network share, with escaped backslashes', SHARE, 'win32', 'x=\\"\\\\\\\\nas\\\\share\\\\Modlists\\\\LitR\\\\\\"', 'x=\\"{instance folder:\\\\}\\\\\\"'],
    ['a network share, for the game folder', SHARE, 'win32', 'x=\\\\nas\\share\\Games\\Fallout 4\\Data', 'x={game folder:\\}\\Data'],
    ['a network share, at a line\'s start', SHARE, 'win32', 'x\n\\\\nas\\share\\Modlists\\LitR\\tools', 'x\n{instance folder:\\}\\tools'],
    ['a network share, for the downloads folder', SHARE, 'win32', 'x=\\\\nas\\share\\Downloads\\a.7z', 'x={downloads folder:\\}\\a.7z'],
  ] as const)('holds a folder on %s by its token', async (_place, folders, platform, written, held) => {
    expect(await heldByGit(folders, platform, written)).toBe(held);
  });

  it.each([
    ['a network share, with forward slashes', SHARE, 'win32', 'x={instance folder:/}/tools', 'x=//nas/share/Modlists/LitR/tools'],
    ['a network share, with backslashes', SHARE, 'win32', 'x={instance folder:\\}\\tools', 'x=\\\\nas\\share\\Modlists\\LitR\\tools'],
    ['a network share, with escaped backslashes', SHARE, 'win32', 'x={instance folder:\\\\}\\\\tools', 'x=\\\\\\\\nas\\\\share\\\\Modlists\\\\LitR\\\\tools'],
    ['a network share, with the doubled separator\'s token', SHARE, 'win32', 'x={instance folder:\\\\\\\\}\\\\tools', 'x=\\\\\\\\nas\\\\share\\\\Modlists\\\\LitR\\\\tools'],
  ] as const)('puts the path of a folder on %s in place of its token', async (_place, folders, platform, held, written) => {
    expect(await checkedOutByGit(folders, platform, held)).toBe(written);
  });

  it.each([
    ['on Windows, a network share\'s path after a drive', SHARE, 'win32', WINDOWS_PROGRAMS, 'x=D:\\\\nas\\share\\Modlists\\LitR\\tools'],
  ] as const)('holds a path that only ends in a folder\'s path, spelt %s, as it is', async (_place, folders, platform, spelling, written) => {
    expect(await heldByGit(folders, platform, written, spelling)).toBe(written);
  });
});
