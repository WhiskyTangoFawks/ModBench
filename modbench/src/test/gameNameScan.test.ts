import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { GAME_RELEASES, gamePathInfoForRelease } from '../tables/gamePaths';
import { isTestSupport, plantedTree, sourceFiles, SOURCE_ROOTS, WEBVIEW_SRC } from './scanSource';
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
      literals.add(info.programs.game);
      literals.add(info.programs.extenderLoader);
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

describe('no extension file names a game outside the table, in a literal a static scan reads', () => {
  it('covers the whole extension source tree', () => {
    expect(sourceFiles(SOURCE_ROOTS).filter((path) => !path.endsWith(THIS_FILE_QUOTING_THE_LITERALS)).length).toBeGreaterThan(100);
  });

  it('reaches the webview tree too, not only the extension host’s', () => {
    expect(sourceFiles(SOURCE_ROOTS)).toContain(join(WEBVIEW_SRC, 'presentation.ts'));
  });

  it('scans clean outside the table', () => {
    expect(findOffenders(SOURCE_ROOTS, TABLE_FILES)).toEqual({});
  });

  it('the tree walk itself catches a planted game name, not just the matcher', () => {
    const dir = plantedTree({ 'topLevel.ts': "export const label = 'not a game';\n", 'nested/plantedGame.ts': "export const label = 'Starfield';\n" });
    const offenders = findOffenders([dir], []);
    expect(Object.keys(offenders)).toEqual([join('nested', 'plantedGame.ts')]);
    expect(offenders[join('nested', 'plantedGame.ts')]).toEqual(expect.arrayContaining(['Starfield']));
  });

  it('flags a game name planted in production source', () => {
    expect(gameNameLiteralsIn("export const label = 'Starfield';\n")).toContain('Starfield');
  });

  it('does not flag ordinary generic-folder vocabulary', () => {
    expect(gameNameLiteralsIn("const DIRS = ['meshes', 'textures', 'sound', 'scripts'];\n")).toEqual([]);
  });
});
