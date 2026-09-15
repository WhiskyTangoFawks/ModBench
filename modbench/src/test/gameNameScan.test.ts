// The only per-game knowledge left in the extension is two tables keyed by release —
// modmanager/mo2/gamePaths.ts and modmanager/mo2/loadOrderDestination.ts. Scoped to src/:
// webview/src/presentation.ts's per-game schema is Editing's own concern.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, relative, sep } from 'node:path';
import { knownReleases, gamePathInfoForRelease } from '../modmanager/mo2/gamePaths';
import { loadOrderAppDataFolder } from '../modmanager/mo2/loadOrderDestination';
import { present } from '../present';

const SRC = join(__dirname, '..');
const SELF = 'gameNameScan.test.ts';

const TABLE_FILES = [
  join('modmanager', 'mo2', 'gamePaths.ts'),
  join('modmanager', 'mo2', 'loadOrderDestination.ts'),
];

// The generated client mirrors the backend's schema rather than carrying a decision.
const GENERATED_DIR = 'generated';

// detectRoot.ts's DATA_DIRS names the Bethesda Data folder layout, not a game — except f4se and
// skse, each a game-specific directory name, which is why it needs the exemption below.
const ALLOWLIST = [join('modmanager', 'install', 'detectRoot.ts')];

// Script-extender projects each name exactly one release, in their own alphabet — data the scan
// needs as much as the two tables' own literals, so it lives here rather than in a third table.
const SCRIPT_EXTENDER_TOKENS = ['f4se', 'skse', 'obse', 'fnvse', 'nvse'];

function knownGameNameLiterals(): string[] {
  const literals = new Set<string>(SCRIPT_EXTENDER_TOKENS);
  for (const release of knownReleases()) {
    literals.add(release);
    const info = gamePathInfoForRelease(release);
    if (info) {
      literals.add(info.mo2Name);
      literals.add(info.nexusSlug);
      if (info.steamAppId) literals.add(info.steamAppId);
      if (info.steamFolderName) literals.add(info.steamFolderName);
    }
    const appDataFolder = loadOrderAppDataFolder(release);
    if (appDataFolder) literals.add(appDataFolder);
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

// A test file or a fixture helper under a `test/` folder: real game names there are corpus and
// mock data, never a decision the extension makes (matches pluginBinaryScan.test.ts's rule).
function isTestSupport(path: string): boolean {
  return path.split(sep).some((seg) => seg === 'test' || seg === 'integration') || path.includes('.test.');
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === GENERATED_DIR) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(path));
    else if (extname(entry.name) === '.ts' || extname(entry.name) === '.tsx') out.push(path);
  }
  return out;
}

// Shared by the production assertion and the self-test below, so a broken walk — a wrong root, a
// silently-excluded directory — fails both the same way, not just the regex.
function findOffenders(root: string, tableFiles: string[], allowlist: string[]): Record<string, string[]> {
  const offenders: Record<string, string[]> = {};
  for (const path of tsFiles(root).filter((p) => !p.endsWith(SELF))) {
    const relPath = relative(root, path);
    if (tableFiles.includes(relPath) || allowlist.includes(relPath) || isTestSupport(relPath)) continue;
    const hits = gameNameLiteralsIn(readFileSync(path, 'utf8'));
    if (hits.length > 0) offenders[relPath] = hits;
  }
  return offenders;
}

// Covered: a table literal or a script-extender token, planted anywhere in production source,
// case-insensitively. Not covered: a name built at runtime, or a game the table does not yet
// know — pluginBinaryScan.test.ts's own limit.

describe('no extension file names a game outside the two tables', () => {
  it('covers the whole extension source tree', () => {
    expect(tsFiles(SRC).filter((path) => !path.endsWith(SELF)).length).toBeGreaterThan(100);
  });

  it('scans clean outside the two tables and the allowlist', () => {
    expect(findOffenders(SRC, TABLE_FILES, ALLOWLIST)).toEqual({});
  });

  // Rival: the traversal itself breaks (wrong root, an excluded directory) rather than the
  // regex — this runs the real walk over a real file, not a hand-built string.
  it('the tree walk itself catches a planted game name, not just the matcher', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-game-name-scan-'));
    try {
      await mkdir(join(dir, 'nested'));
      await writeFile(join(dir, 'topLevel.ts'), "export const label = 'not a game';\n");
      await writeFile(join(dir, 'nested', 'plantedGame.ts'), "export const label = 'Skyrim';\n");
      const offenders = findOffenders(dir, [], []);
      expect(Object.keys(offenders)).toEqual([join('nested', 'plantedGame.ts')]);
      expect(offenders[join('nested', 'plantedGame.ts')]).toEqual(expect.arrayContaining(['Skyrim']));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the allowlist is exactly the one stated exemption', () => {
    expect(ALLOWLIST).toEqual([join('modmanager', 'install', 'detectRoot.ts')]);
  });

  // Rival: a second exemption added beside it — an allowlist that can grow silently is how this
  // guard dies.
  it('fails a hard-coded expectation of more than one allowlist entry', () => {
    expect(ALLOWLIST).not.toHaveLength(2);
  });

  // Rival: 'Skyrim' hand-added to a real production file outside the tables.
  it('flags a game name planted in production source', () => {
    expect(gameNameLiteralsIn("export const label = 'Skyrim';\n")).toContain('Skyrim');
  });

  // Rival: the allowlisted file's own tokens — proof the exemption is load-bearing, not
  // decorative.
  it('the allowlisted file would fail the scan without its exemption', () => {
    const text = readFileSync(join(SRC, present(ALLOWLIST[0], 'the allowlist\'s sole exemption')), 'utf8');
    expect(gameNameLiteralsIn(text)).toEqual(expect.arrayContaining(['f4se', 'skse']));
  });

  it('does not flag ordinary generic-folder vocabulary', () => {
    expect(gameNameLiteralsIn("const DIRS = ['meshes', 'textures', 'sound', 'scripts'];\n")).toEqual([]);
  });

  // Rival: nexusSlug.ts (or gameRelease.ts) resurrected as a standalone table — the slug must
  // stay a column of gamePaths.ts, not split back into a table of its own.
  it('the Nexus slug and the release translation stay columns of gamePaths.ts', () => {
    expect(existsSync(join(SRC, 'modmanager', 'mo2', 'nexusSlug.ts'))).toBe(false);
    expect(existsSync(join(SRC, 'modmanager', 'mo2', 'gameRelease.ts'))).toBe(false);
    expect(gamePathInfoForRelease('Fallout4')?.nexusSlug).toBe('fallout4');
  });
});
