// An unresolved or unreachable Data folder degrades to an empty set rather than failing the
// whole tree load.

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readMasters, isPluginFile } from './masterReader';

export async function readVanillaMasters(
  dataFolder: string | undefined,
  log: (msg: string) => void,
): Promise<Set<string>> {
  if (!dataFolder) return new Set();
  try {
    const dataFiles = await readdir(dataFolder);
    return new Set(
      dataFiles.filter(isPluginFile).map((f) => f.toLowerCase()),
    );
  } catch (e) {
    log(`[vanillaMasters] could not resolve vanilla masters: ${e instanceof Error ? e.message : String(e)}`);
    return new Set();
  }
}

/** The plugins the game loads whether or not a mod declares them. MO2 hardlinks deployed mod
 *  files into `Data`, so `nlink === 1` marks a file vanilla — discovered, never a hardcoded
 *  table. */
export async function discoverImplicitMasters(
  dataFolder: string | undefined,
  log: (msg: string) => void,
): Promise<string[]> {
  if (!dataFolder) return [];

  let dataFiles: string[];
  try {
    dataFiles = await readdir(dataFolder);
  } catch (e) {
    log(`[vanillaMasters] could not resolve implicit masters: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
  const candidates = dataFiles.filter(isPluginFile);
  const vanilla = await filterNonHardlinked(dataFolder, candidates, log);
  const { readable, edges } = await buildMasterDependencyGraph(dataFolder, vanilla, log);
  return topoSortImplicitMasters(readable, edges, log);
}

// A per-file stat failure excludes that file rather than blanking the set.
async function filterNonHardlinked(
  dataFolder: string,
  candidates: string[],
  log: (msg: string) => void,
): Promise<string[]> {
  const vanilla: string[] = [];
  for (const name of candidates) {
    try {
      const stats = await stat(join(dataFolder, name));
      if (stats.nlink === 1) vanilla.push(name);
    } catch (e) {
      log(`[vanillaMasters] could not stat "${name}" — excluding it: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return vanilla;
}

// An edge to a name outside the discovered set is dropped: a vanilla file mastering a
// mod-provided plugin is not a discovery-order edge.
async function buildMasterDependencyGraph(
  dataFolder: string,
  vanilla: string[],
  log: (msg: string) => void,
): Promise<{ readable: string[]; edges: Map<string, string[]> }> {
  const entries: { name: string; masters: string[] }[] = [];
  for (const name of vanilla) {
    try {
      entries.push({ name, masters: await readMasters(join(dataFolder, name)) });
    } catch (e) {
      log(`[vanillaMasters] could not read masters from "${name}" — excluding it: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const readable = entries.map((e) => e.name);
  const byLower = new Map(readable.map((n) => [n.toLowerCase(), n]));
  const edges = new Map<string, string[]>();
  for (const { name, masters } of entries) {
    edges.set(
      name,
      masters.map((m) => byLower.get(m.toLowerCase())).filter((m): m is string => m !== undefined),
    );
  }
  return { readable, edges };
}

// On a detected cycle, falls back to the pre-sort discovery order rather than the partial DFS
// result: deterministic, and never a hang.
function topoSortImplicitMasters(
  candidates: string[],
  edges: Map<string, string[]>,
  log: (msg: string) => void,
): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  let cyclic = false;

  function visit(name: string): void {
    if (cyclic || visited.has(name)) return;
    if (inStack.has(name)) {
      cyclic = true;
      return;
    }
    inStack.add(name);
    // `?? []` guards a lookup unreachable by construction: every `dep` comes from `byLower`'s
    // values, which are exactly `edges`'s key set. Traced, not asserted away with `!`.
    for (const dep of edges.get(name) ?? []) {
      visit(dep);
      if (cyclic) break;
    }
    inStack.delete(name);
    visited.add(name);
    result.push(name);
  }

  for (const name of candidates) {
    visit(name);
    if (cyclic) break;
  }

  if (cyclic) {
    log('[vanillaMasters] cycle detected among implicit masters — falling back to discovery order');
    return candidates;
  }
  return result;
}
