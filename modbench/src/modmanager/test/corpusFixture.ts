// Snapshots a whole cloned MO2 instance either side of a real mutation and
// asserts nothing outside the declared touch-set moved by a byte. The per-format
// round-trip tests prove one writer faithful; this proves writers compose.

import { cp, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { expect } from 'vitest';
import { parseModlist } from '../../mo2Codecs/modlistText';
import { parsePlugins } from '../../mo2Codecs/pluginsText';
import { readSelectedProfile } from '../../mo2Codecs/modOrganizerIni';
import { buildLoadOrderRows, providedPluginsOf } from '../../instance/loadOrderSnapshot';
import type { ModlistEntry, PluginEntry } from '../model';

// A sibling of fixtures/mo2-instance/, never an extension of it: that one is read
// in place by tests asserting its exact contents, so any addition breaks them.
export const CORPUS_FIXTURE = join(__dirname, 'fixtures', 'mo2-instance-corpus');

// The fixture's active profile is "Default"; only the setActiveProfile test
// switches away from it.
export const DEFAULT_MODLIST = 'profiles/Default/modlist.txt';
export const DEFAULT_PLUGINS = 'profiles/Default/plugins.txt';

/** What a corpus test reads back after a command wrote: the same parsers the Instance uses,
 *  so a test never re-derives an MO2 file format of its own. */
export const readModlistEntries = async (root: string, profile = 'Default'): Promise<ModlistEntry[]> =>
  parseModlist(await readFile(join(root, 'profiles', profile, 'modlist.txt'), 'utf8'));

export const readPluginLines = async (root: string, profile = 'Default'): Promise<PluginEntry[]> =>
  parsePlugins(await readFile(join(root, 'profiles', profile, 'plugins.txt'), 'utf8'));

export const readActiveProfile = async (root: string): Promise<string> =>
  readSelectedProfile(await readFile(join(root, 'ModOrganizer.ini'), 'utf8'));

/** The winners the Instance's value carries for a tree on disk, built through the value's own
 *  builder: a test handing the plugins reconcile its argument fakes no walk of its own. */
export async function providedPluginsIn(
  root: string, profile = 'Default', dataFolder?: string,
): Promise<ReadonlyMap<string, string>> {
  const entries = await readModlistEntries(root, profile);
  const lines = await readPluginLines(root, profile);
  return providedPluginsOf(await buildLoadOrderRows({
    readModlist: () => Promise.resolve(entries),
    readPluginOrder: () => Promise.resolve(lines.map((e) => e.name)),
    readEnabledPlugins: () => Promise.resolve(lines.filter((e) => e.enabled).map((e) => e.name)),
  }, root, dataFolder));
}

/** Caller owns cleanup of the returned temp root. */
export async function cloneCorpusFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'medit-corpus-'));
  await cp(CORPUS_FIXTURE, root, { recursive: true });
  return root;
}

/** Keys are forward-slash relative paths, so a snapshot is stable across
 *  platforms. An absent `root` snapshots as empty rather than throwing: a
 *  not-yet-created directory is a legitimate "nothing here yet". */
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

/** Soft assertions, so one run names every diverging path rather than the first.
 *  The intended change is not verified here — each test asserts that through the
 *  production read API — so this function's only job is "nothing else moved". */
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
