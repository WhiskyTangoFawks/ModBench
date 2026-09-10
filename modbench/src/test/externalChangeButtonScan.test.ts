// The external-change dialog's two current strings are the only ones the extension may name —
// a retired string never survives under a new name or a stray test fixture.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';

const RETIRED_STRINGS = ['Absorb Upstream Update', 'Keep as My Edit'];

const SELF = 'externalChangeButtonScan.test.ts';

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'generated') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(path));
    else if (extname(entry.name) === '.ts' || extname(entry.name) === '.tsx') out.push(path);
  }
  return out;
}

function retiredStringsIn(text: string): string[] {
  return RETIRED_STRINGS.filter((s) => text.includes(s));
}

// Shared by the production assertion and the rival test below, so a broken walk — a wrong root, a
// silently-excluded directory — fails both the same way, not just the matcher.
function findOffenders(root: string): Record<string, string[]> {
  const offenders: Record<string, string[]> = {};
  for (const path of tsFiles(root).filter((p) => !p.endsWith(SELF))) {
    const hits = retiredStringsIn(readFileSync(path, 'utf8'));
    if (hits.length > 0) offenders[path] = hits;
  }
  return offenders;
}

describe('the two new external-change button strings are the only ones in the extension', () => {
  it('covers the whole extension source tree', () => {
    const root = join(__dirname, '..'); // src/
    expect(tsFiles(root).filter((p) => !p.endsWith(SELF)).length).toBeGreaterThan(100);
  });

  it('no source or test file names a retired button string', () => {
    const root = join(__dirname, '..'); // src/
    expect(findOffenders(root)).toEqual({});
  });

  // Rival: the traversal itself breaks (wrong root, an excluded directory) rather than the
  // matcher — this runs the real walk over a real file, not a hand-built string.
  it('the tree walk itself catches a retired string planted in a comment, a fixture, or a doc-in-code string', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-external-change-button-scan-'));
    try {
      await mkdir(join(dir, 'nested'));
      await writeFile(join(dir, 'topLevel.ts'), "export const label = 'unrelated';\n");
      await writeFile(join(dir, 'nested', 'someFixture.ts'), "export const oldButton = 'Absorb Upstream Update';\n");
      const offenders = findOffenders(dir);
      expect(Object.keys(offenders)).toEqual([join(dir, 'nested', 'someFixture.ts')]);
      expect(offenders[join(dir, 'nested', 'someFixture.ts')]).toEqual(['Absorb Upstream Update']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
