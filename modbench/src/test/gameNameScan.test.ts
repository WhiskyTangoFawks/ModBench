import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { gamePathInfoForRelease } from '../tables/gamePaths';
import { present } from '../ports/present';
import { tsFiles } from './tsFiles';

const SRC = join(__dirname, '..');
const WEBVIEW_SRC = join(__dirname, '..', '..', 'webview', 'src');
const SRC_ROOTS = [SRC, WEBVIEW_SRC];
const THIS_FILE_QUOTING_THE_LITERALS = 'gameNameScan.test.ts';

const TABLE_FILES = [join('tables', 'gamePaths.ts')];

const ALLOWLIST = [join('install', 'detectRoot.ts')];

const SCRIPT_EXTENDER_TOKENS = ['f4se', 'skse', 'obse', 'fnvse', 'nvse'];

const releasesOfTable = (): string[] => {
  const table = /const GAME_PATHS[^=]*= \{\n([\s\S]*?)\n\};/.exec(readFileSync(join(SRC, 'tables', 'gamePaths.ts'), 'utf8'));
  const body = present(table?.[1], 'the GAME_PATHS table in gamePaths.ts');
  return [...body.matchAll(/^ {2}(\w+): \{/gm)].map((m) => present(m[1], 'a release key'));
};
const KNOWN_RELEASES = releasesOfTable();

function knownGameNameLiterals(): string[] {
  const literals = new Set<string>(SCRIPT_EXTENDER_TOKENS);
  for (const release of KNOWN_RELEASES) {
    literals.add(release);
    const info = gamePathInfoForRelease(release);
    if (info) {
      literals.add(info.gameName);
      literals.add(info.nexusSlug);
      if (info.steamAppId) literals.add(info.steamAppId);
      if (info.steamFolderName) literals.add(info.steamFolderName);
      for (const master of info.masters) literals.add(master);
      if (info.creationClubList) literals.add(info.creationClubList);
    }
  }
  return [...literals];
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function gameNameLiteralsIn(text: string): string[] {
  const found = new Set<string>();
  for (const literal of knownGameNameLiterals()) {
    if (new RegExp(`\\b${escapeRegex(literal)}\\b`, 'i').test(text)) found.add(literal);
  }
  return [...found];
}

function isTestSupport(path: string): boolean {
  return path.split(sep).some((seg) => seg === 'test' || seg === 'integration') || path.includes('.test.');
}

function findOffenders(roots: readonly string[], tableFiles: string[], allowlist: string[]): Record<string, string[]> {
  const offenders: Record<string, string[]> = {};
  for (const root of roots) {
    for (const path of tsFiles(root, { exclude: ['generated'] }).filter((p) => !p.endsWith(THIS_FILE_QUOTING_THE_LITERALS))) {
      const relPath = relative(root, path);
      if (tableFiles.includes(relPath) || allowlist.includes(relPath) || isTestSupport(relPath)) continue;
      const hits = gameNameLiteralsIn(readFileSync(path, 'utf8'));
      if (hits.length > 0) offenders[relPath] = hits;
    }
  }
  return offenders;
}

const allFiles = (roots: readonly string[]): string[] =>
  roots.flatMap((root) => tsFiles(root, { exclude: ['generated'] }));

describe('no extension file names a game outside the table, in a literal a static scan reads', () => {
  it('knows every release the table holds', () => {
    expect(KNOWN_RELEASES.length).toBeGreaterThan(8);
    expect(KNOWN_RELEASES.filter((release) => gamePathInfoForRelease(release) === undefined)).toEqual([]);
  });

  it('covers the whole extension source tree', () => {
    expect(allFiles(SRC_ROOTS).filter((path) => !path.endsWith(THIS_FILE_QUOTING_THE_LITERALS)).length).toBeGreaterThan(100);
  });

  it('reaches the webview tree too, not only the extension host’s', () => {
    expect(allFiles(SRC_ROOTS)).toContain(join(WEBVIEW_SRC, 'presentation.ts'));
  });

  it('scans clean outside the table and the allowlist', () => {
    expect(findOffenders(SRC_ROOTS, TABLE_FILES, ALLOWLIST)).toEqual({});
  });

  it('the tree walk itself catches a planted game name, not just the matcher', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-game-name-scan-'));
    try {
      await mkdir(join(dir, 'nested'));
      await writeFile(join(dir, 'topLevel.ts'), "export const label = 'not a game';\n");
      await writeFile(join(dir, 'nested', 'plantedGame.ts'), "export const label = 'Skyrim';\n");
      const offenders = findOffenders([dir], [], []);
      expect(Object.keys(offenders)).toEqual([join('nested', 'plantedGame.ts')]);
      expect(offenders[join('nested', 'plantedGame.ts')]).toEqual(expect.arrayContaining(['Skyrim']));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the allowlist is exactly the one stated exemption', () => {
    expect(ALLOWLIST).toEqual([join('install', 'detectRoot.ts')]);
  });

  it('fails a hard-coded expectation of more than one allowlist entry', () => {
    expect(ALLOWLIST).not.toHaveLength(2);
  });

  it('flags a game name planted in production source', () => {
    expect(gameNameLiteralsIn("export const label = 'Skyrim';\n")).toContain('Skyrim');
  });

  it('the allowlisted file would fail the scan without its exemption', () => {
    const text = readFileSync(join(SRC, present(ALLOWLIST[0], 'the allowlist\'s sole exemption')), 'utf8');
    expect(gameNameLiteralsIn(text)).toEqual(expect.arrayContaining(['f4se', 'skse']));
  });

  it('does not flag ordinary generic-folder vocabulary', () => {
    expect(gameNameLiteralsIn("const DIRS = ['meshes', 'textures', 'sound', 'scripts'];\n")).toEqual([]);
  });

  it('the Nexus slug and the release translation stay columns of gamePaths.ts', () => {
    expect(existsSync(join(SRC, 'tables', 'nexusSlug.ts'))).toBe(false);
    expect(existsSync(join(SRC, 'tables', 'gameRelease.ts'))).toBe(false);
    expect(gamePathInfoForRelease('Fallout4')?.nexusSlug).toBe('fallout4');
  });
});
