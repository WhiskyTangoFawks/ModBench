import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { GAME_RELEASES, gamePathInfoForRelease, SCRIPT_EXTENDER_FOLDERS } from '../tables/gamePaths';
import { isTestSupport, SOURCE_ROOTS, SRC, WEBVIEW_SRC } from './scanSource';
import { tsFiles } from './tsFiles';

const THIS_FILE_QUOTING_THE_LITERALS = 'gameNameScan.test.ts';

const TABLE_FILES = [join('tables', 'gamePaths.ts')];

function knownGameNameLiterals(): string[] {
  const literals = new Set<string>();
  for (const release of GAME_RELEASES) {
    literals.add(release);
    const info = gamePathInfoForRelease(release);
    if (info) {
      literals.add(info.gameName);
      literals.add(info.nexusSlug);
      literals.add(info.scriptExtenderFolder);
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

function findOffenders(roots: readonly string[], tableFiles: string[]): Record<string, string[]> {
  const offenders: Record<string, string[]> = {};
  for (const root of roots) {
    for (const path of tsFiles(root, { exclude: ['generated'] }).filter((p) => !p.endsWith(THIS_FILE_QUOTING_THE_LITERALS))) {
      const relPath = relative(root, path);
      if (tableFiles.includes(relPath) || isTestSupport(relPath)) continue;
      const hits = gameNameLiteralsIn(readFileSync(path, 'utf8'));
      if (hits.length > 0) offenders[relPath] = hits;
    }
  }
  return offenders;
}

const allFiles = (roots: readonly string[]): string[] =>
  roots.flatMap((root) => tsFiles(root, { exclude: ['generated'] }));

describe('no extension file names a game outside the table, in a literal a static scan reads', () => {
  it('enumerates the releases from the table', () => {
    expect(GAME_RELEASES.length).toBeGreaterThan(0);
  });

  it('covers the whole extension source tree', () => {
    expect(allFiles(SOURCE_ROOTS).filter((path) => !path.endsWith(THIS_FILE_QUOTING_THE_LITERALS)).length).toBeGreaterThan(100);
  });

  it('reaches the webview tree too, not only the extension host’s', () => {
    expect(allFiles(SOURCE_ROOTS)).toContain(join(WEBVIEW_SRC, 'presentation.ts'));
  });

  it('scans clean outside the table', () => {
    expect(findOffenders(SOURCE_ROOTS, TABLE_FILES)).toEqual({});
  });

  it('the tree walk itself catches a planted game name, not just the matcher', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-game-name-scan-'));
    try {
      await mkdir(join(dir, 'nested'));
      await writeFile(join(dir, 'topLevel.ts'), "export const label = 'not a game';\n");
      await writeFile(join(dir, 'nested', 'plantedGame.ts'), "export const label = 'Skyrim';\n");
      const offenders = findOffenders([dir], []);
      expect(Object.keys(offenders)).toEqual([join('nested', 'plantedGame.ts')]);
      expect(offenders[join('nested', 'plantedGame.ts')]).toEqual(expect.arrayContaining(['Skyrim']));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('flags a game name planted in production source', () => {
    expect(gameNameLiteralsIn("export const label = 'Skyrim';\n")).toContain('Skyrim');
  });

  it('forbids every script-extender folder the table names', () => {
    for (const folder of SCRIPT_EXTENDER_FOLDERS) {
      expect(gameNameLiteralsIn(`const dir = '${folder}';\n`)).toContain(folder);
    }
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
