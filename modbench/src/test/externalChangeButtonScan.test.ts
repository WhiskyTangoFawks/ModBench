// The external-change dialog's two current strings are the only ones the extension may name —
// a retired string never survives under a new name or a stray test fixture.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

describe('the two new external-change button strings are the only ones in the extension', () => {
  it('no source or test file names a retired button string', () => {
    const root = join(__dirname, '..'); // src/
    const offenders: Record<string, string[]> = {};
    for (const path of tsFiles(root).filter((p) => !p.endsWith(SELF))) {
      const hits = retiredStringsIn(readFileSync(path, 'utf8'));
      if (hits.length > 0) offenders[path] = hits;
    }
    expect(offenders).toEqual({});
  });

  // Proves the matcher alone; the walk over src/ is exercised by the test above.
  it('finds a retired string in a comment, a fixture, or a doc-in-code string', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'medit-external-change-button-scan-'));
    try {
      const planted = join(dir, 'someFixture.ts');
      await writeFile(planted, "export const oldButton = 'Absorb Upstream Update';\n");
      expect(retiredStringsIn(readFileSync(planted, 'utf8'))).toEqual(['Absorb Upstream Update']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
