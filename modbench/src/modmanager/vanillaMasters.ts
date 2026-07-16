// Vanilla/DLC master set for StatusChecker's missing-master check, read from the
// game's resolved Data folder (the single GameDirectory resolved once at the
// composition root; see gameDirectory.ts). Tolerates an unresolved/unreachable
// Data folder, degrading to an empty set rather than failing the whole tree load.

import { readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { readMasters } from './masterReader';

const PLUGIN_EXTENSIONS = new Set(['.esp', '.esm', '.esl']);

export async function readVanillaMasters(
  dataFolder: string | undefined,
  log?: (msg: string) => void,
): Promise<Set<string>> {
  if (!dataFolder) return new Set();
  try {
    const dataFiles = await readdir(dataFolder);
    return new Set(
      dataFiles.filter((f) => PLUGIN_EXTENSIONS.has(extname(f).toLowerCase())).map((f) => f.toLowerCase()),
    );
  } catch (e) {
    log?.(`[vanillaMasters] could not resolve vanilla masters: ${e instanceof Error ? e.message : String(e)}`);
    return new Set();
  }
}

/** Discovers the game's implicitly-loaded masters (issue #108) — vanilla/DLC
 *  plugins the game loads whether or not any mod declares them, so their
 *  absence from the Plugin List makes every mod plugin declaring one show a
 *  false "missing master". A plugin file in the resolved Data folder that is
 *  NOT a hardlink (`nlink === 1`) is vanilla; a hardlinked file (`nlink >= 2`)
 *  is a deployed mod plugin (MO2 hardlinks mod files into Data), not vanilla —
 *  discovered, never hardcoded. Ordering is derived by topologically sorting
 *  the discovered set on each file's own declared masters (read via the
 *  existing `readMasters` header reader) — never alphabetical, never a
 *  hardcoded per-game table. Degrades to `[]` (logged) on an unresolved/
 *  unreadable Data folder; a per-file stat/readMasters failure excludes only
 *  that file (logged) without blanking the rest; a master-dependency cycle
 *  cannot hang (DFS with `inStack` cycle detection) and falls back to the
 *  pre-sort discovery order (logged) rather than throwing. */
export async function discoverImplicitMasters(
  dataFolder: string | undefined,
  log?: (msg: string) => void,
): Promise<string[]> {
  if (!dataFolder) return [];

  let dataFiles: string[];
  try {
    dataFiles = await readdir(dataFolder);
  } catch (e) {
    log?.(`[vanillaMasters] could not resolve implicit masters: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
  const candidates = dataFiles.filter((f) => PLUGIN_EXTENSIONS.has(extname(f).toLowerCase()));
  const vanilla = await filterNonHardlinked(dataFolder, candidates, log);
  const { readable, edges } = await buildMasterDependencyGraph(dataFolder, vanilla, log);
  return topoSortImplicitMasters(readable, edges, log);
}

/** Hardlink seam: nlink === 1 → vanilla (not deployed by MO2); nlink >= 2 → a
 *  deployed mod plugin, excluded. A per-file stat failure excludes that file. */
async function filterNonHardlinked(
  dataFolder: string,
  candidates: string[],
  log?: (msg: string) => void,
): Promise<string[]> {
  const vanilla: string[] = [];
  for (const name of candidates) {
    try {
      const stats = await stat(join(dataFolder, name));
      if (stats.nlink === 1) vanilla.push(name);
    } catch (e) {
      log?.(`[vanillaMasters] could not stat "${name}" — excluding it: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return vanilla;
}

/** Reads each vanilla file's own declared masters to build the dependency
 *  graph for the topological sort. A per-file read failure excludes that one
 *  file (logged) rather than blanking the whole discovered set. An edge to a
 *  name outside the discovered set is ignored — e.g. a vanilla file mastering
 *  a mod-provided plugin isn't a discovery-order edge. */
async function buildMasterDependencyGraph(
  dataFolder: string,
  vanilla: string[],
  log?: (msg: string) => void,
): Promise<{ readable: string[]; edges: Map<string, string[]> }> {
  const mastersByName = new Map<string, string[]>();
  const readable: string[] = [];
  for (const name of vanilla) {
    try {
      mastersByName.set(name, await readMasters(join(dataFolder, name)));
      readable.push(name);
    } catch (e) {
      log?.(`[vanillaMasters] could not read masters from "${name}" — excluding it: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const byLower = new Map(readable.map((n) => [n.toLowerCase(), n]));
  const edges = new Map<string, string[]>();
  for (const name of readable) {
    const declared = mastersByName.get(name) ?? [];
    edges.set(
      name,
      declared.map((m) => byLower.get(m.toLowerCase())).filter((m): m is string => m !== undefined),
    );
  }
  return { readable, edges };
}

/** DFS-postorder topological sort: masters end up before their dependents.
 *  Cycle-safe by construction — `inStack` catches a revisit-in-progress and
 *  sets `cyclic` without recursing further, so the DFS is always finite. On a
 *  detected cycle, falls back to `candidates` (the pre-sort discovery order)
 *  rather than the partial DFS result — stable and deterministic, never a hang. */
function topoSortImplicitMasters(
  candidates: string[],
  edges: Map<string, string[]>,
  log?: (msg: string) => void,
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
    log?.('[vanillaMasters] cycle detected among implicit masters — falling back to discovery order');
    return candidates;
  }
  return result;
}
