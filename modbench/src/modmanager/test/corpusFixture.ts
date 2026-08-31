// Shared harness for the MO2 instance-fidelity corpus: every composition-level
// test in *Corpus.test.ts clones fixtures/mo2-instance-corpus/ into a fresh mkdtemp
// copy, snapshots the whole tree before and after a real mutating operation, and
// asserts that nothing outside the operation's own declared touch-set changed by so
// much as a byte. This is deliberately independent of the per-format round-trip
// tests (modlistText.test.ts etc.) — those prove a single writer is byte-faithful in
// isolation; this proves the writers compose without one clobbering another's state.

import { cp, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { expect } from 'vitest';

// Deliberately a NEW sibling fixture, not an in-place extension of the existing
// fixtures/mo2-instance/. mo2-instance/ is read directly (not copied) by ~6
// existing tests (Mo2ModlistSource.test.ts, modlistText.test.ts, etc.) that hard-
// assert its exact contents (exact readModlist()/listSeparators()/readPluginOrder()
// arrays, exact listProfiles()); any addition to it — a new mod, a new profile line —
// breaks one of those. This fixture starts as a copy of it and layers the corpus'
// adversarial quirks on top, isolated from those tests.
export const CORPUS_FIXTURE = join(__dirname, 'fixtures', 'mo2-instance-corpus');

/** profiles/Default/modlist.txt and plugins.txt — the active-profile paths every
 *  corpus test starts from (the fixture's active profile is "Default"; only the
 *  setActiveProfile test switches it). Shared here so the three test files that
 *  reference them don't each redefine the same literal path. */
export const DEFAULT_MODLIST = 'profiles/Default/modlist.txt';
export const DEFAULT_PLUGINS = 'profiles/Default/plugins.txt';

/** Fresh mkdtemp copy of the committed corpus fixture. Caller owns cleanup
 *  (`rm(root, { recursive: true, force: true })` in `afterEach`). */
export async function cloneCorpusFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'medit-corpus-'));
  await cp(CORPUS_FIXTURE, root, { recursive: true });
  return root;
}

/** Every file under `root`, content included, keyed by forward-slash relative path
 *  (so the snapshot is stable across platforms). Absent `root` snapshots as empty —
 *  callers that snapshot a not-yet-created directory (e.g. `overwrite/` before a
 *  first purge) get a legitimate "nothing here yet" rather than a thrown error. */
export async function snapshotTree(root: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  async function walk(dir: string): Promise<void> {
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      const abs = join(dir, dirent.name);
      if (dirent.isDirectory()) await walk(abs);
      else if (dirent.isFile()) out.set(relative(root, abs).split(sep).join('/'), await readFile(abs));
    }
  }
  await walk(root);
  return out;
}

/** Assert every path present in `before` and/or `after`, other than the paths named
 *  in `touchedPaths`, is byte-identical and identically present/absent. Reports every
 *  divergence found (via `expect.soft`), not just the first, and names the offending
 *  path plus a readable reason — a byte offset for binary content, a full string diff
 *  (Vitest's own) for text — so a failing corpus test identifies which file diverged
 *  and how. The intended change itself is NOT verified
 *  here: each test asserts that independently, through the production read API, so
 *  this function's only job is "nothing else moved". */
export function assertOnlyChanged(
  before: Map<string, Buffer>,
  after: Map<string, Buffer>,
  touchedPaths: ReadonlySet<string>,
): void {
  const allPaths = new Set([...before.keys(), ...after.keys()]);
  for (const path of allPaths) {
    if (touchedPaths.has(path)) continue;
    const b = before.get(path);
    const a = after.get(path);
    if (b === undefined) {
      expect.soft(true, `${path}: unexpectedly created (absent before this operation)`).toBe(false);
      continue;
    }
    if (a === undefined) {
      expect.soft(true, `${path}: unexpectedly deleted (present before this operation)`).toBe(false);
      continue;
    }
    if (b.equals(a)) continue;
    if (isProbablyText(b) && isProbablyText(a)) {
      expect.soft(a.toString('utf8'), `${path}: changed unexpectedly`).toBe(b.toString('utf8'));
    } else {
      const offset = firstDivergingByte(b, a);
      expect
        .soft(true, `${path}: changed unexpectedly — byte ${offset} differs (length ${b.length} -> ${a.length})`)
        .toBe(false);
    }
  }
}

function isProbablyText(buf: Buffer): boolean {
  return !buf.subarray(0, 512).includes(0);
}

function firstDivergingByte(a: Buffer, b: Buffer): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) return i;
  return len;
}
