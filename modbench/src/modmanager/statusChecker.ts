// Turns a FileConflictIndex into per-mod status badges: conflict/override
// counts, missing masters, missing mod folders. Pure over ModlistEntry[] +
// instanceRoot + a precomputed FileConflictIndex; no vscode import.

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModlistEntry } from './model';
import type { FileConflictIndex } from './fileConflictIndex';
import { readMasters, isPluginFile } from './masterReader';

export type ModStatus =
  | { kind: 'ok' }
  | { kind: 'conflicts'; count: number }
  | { kind: 'overrides'; count: number }
  | { kind: 'missingMaster'; masters: string[] }
  | { kind: 'missingMod' };

export interface ModStatusResult {
  status: ModStatus;
  /** Hover tooltip lines: conflicting relative paths and their winner. */
  conflictLines: string[];
}

function isPlugin(relativePath: string): boolean {
  return isPluginFile(relativePath);
}

function providedPluginBasenames(filesByMod: FileConflictIndex['filesByMod']): Set<string> {
  const basenames = new Set<string>();
  for (const files of filesByMod.values()) {
    for (const file of files) {
      if (isPlugin(file.relativePath)) basenames.add(file.relativePath.split('/').pop()!.toLowerCase());
    }
  }
  return basenames;
}

type ModFile = { relativePath: string; absolutePath: string };

export async function computeModStatuses(
  entries: ModlistEntry[],
  instanceRoot: string,
  index: FileConflictIndex,
  vanillaMasters: Set<string>,
  log: (msg: string) => void,
): Promise<Map<string, ModStatusResult>> {
  const results = new Map<string, ModStatusResult>();
  const providedPlugins = providedPluginBasenames(index.filesByMod);

  for (const entry of entries) {
    if (entry.kind !== 'mod') continue;
    results.set(entry.name, await computeEntryStatus(entry, instanceRoot, index, vanillaMasters, providedPlugins, log));
  }

  return results;
}

async function computeEntryStatus(
  entry: ModlistEntry,
  instanceRoot: string,
  index: FileConflictIndex,
  vanillaMasters: Set<string>,
  providedPlugins: Set<string>,
  log: (msg: string) => void,
): Promise<ModStatusResult> {
  if (!(await modFolderExists(instanceRoot, entry.name))) {
    return { status: { kind: 'missingMod' }, conflictLines: [] };
  }
  if (!entry.enabled) return { status: { kind: 'ok' }, conflictLines: [] };

  const modFiles = index.filesByMod.get(entry.name) ?? [];
  const { conflictLines, conflicts, overrides } = countConflicts(modFiles, index, entry.name);
  const missingMasters = await findMissingMasters(modFiles, vanillaMasters, providedPlugins, log);
  return { status: classifyStatus(missingMasters, conflicts, overrides), conflictLines };
}

// ENOENT reads as absent; any other stat error propagates.
async function modFolderExists(instanceRoot: string, modName: string): Promise<boolean> {
  try {
    await stat(join(instanceRoot, 'mods', modName));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

// A contested file this mod wins is an override; one it loses is a conflict.
function countConflicts(
  modFiles: ModFile[],
  index: FileConflictIndex,
  modName: string,
): { conflictLines: string[]; conflicts: number; overrides: number } {
  const conflictLines: string[] = [];
  let conflicts = 0;
  let overrides = 0;
  for (const file of modFiles) {
    const conflict = index.files.get(file.relativePath);
    if (!conflict || conflict.providers.length < 2) continue;
    conflictLines.push(`${file.relativePath} → winner: ${conflict.winnerMod}`);
    if (conflict.winnerMod === modName) overrides++;
    else conflicts++;
  }
  return { conflictLines, conflicts, overrides };
}

async function findMissingMasters(
  modFiles: ModFile[],
  vanillaMasters: Set<string>,
  providedPlugins: Set<string>,
  log: (msg: string) => void,
): Promise<Set<string>> {
  const pluginFiles = modFiles.filter((f) => isPlugin(f.relativePath));
  const mastersPerPlugin = await Promise.all(
    pluginFiles.map(async (f) => {
      try {
        return await readMasters(f.absolutePath);
      } catch (e) {
        // A malformed/unreadable plugin must not blank the whole tree — skip
        // its masters (can't determine them) rather than throwing.
        log(`[statusChecker] could not read masters from ${f.absolutePath}: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      }
    }),
  );
  const missingMasters = new Set<string>();
  for (const master of mastersPerPlugin.flat()) {
    const lower = master.toLowerCase();
    if (!vanillaMasters.has(lower) && !providedPlugins.has(lower)) missingMasters.add(master);
  }
  return missingMasters;
}

function classifyStatus(missingMasters: Set<string>, conflicts: number, overrides: number): ModStatus {
  if (missingMasters.size > 0) return { kind: 'missingMaster', masters: [...missingMasters] };
  if (conflicts > 0) return { kind: 'conflicts', count: conflicts };
  if (overrides > 0) return { kind: 'overrides', count: overrides };
  return { kind: 'ok' };
}

// --- Order-aware missing-master check (Plugin List surface, docs/specs/plugins.md) ---
//
// Stronger than the per-mod presence check: a master present but loaded too late is a CTD
// condition too, not just an absent one.

export type PluginOrderStatus =
  | { kind: 'ok' }
  | { kind: 'masterNotLoadedBefore'; masters: string[] };

/** Flags every declared master not positioned strictly before `pluginIndex` — absent from the
 *  order entirely, or present at or after this plugin's line. No vanilla special-casing. */
export function checkMasterOrder(
  declaredMasters: string[],
  orderedPluginNames: string[],
  pluginIndex: number,
): PluginOrderStatus {
  const positionByName = new Map<string, number>();
  orderedPluginNames.forEach((name, i) => positionByName.set(name.toLowerCase(), i));

  const offenders = declaredMasters.filter((master) => {
    const pos = positionByName.get(master.toLowerCase());
    return pos === undefined || pos >= pluginIndex;
  });
  return offenders.length > 0 ? { kind: 'masterNotLoadedBefore', masters: offenders } : { kind: 'ok' };
}

/** Only offending plugins get a map entry. An unreadable or unresolvable plugin is logged and
 *  treated as having no masters, so one bad file never blanks the rest. `winnerByName` is
 *  handed in because building it costs a full index scan. */
export async function computePluginOrderStatuses(
  order: string[],
  winnerByName: Map<string, string>,
  dataFolder: string | undefined,
  log: (msg: string) => void,
): Promise<Map<string, PluginOrderStatus>> {
  // Mod-provided plugins always resolve via the index; a vanilla/DLC/CC plugin
  // no mod ships falls back to the game Data folder — only when it's known, so
  // an unresolved game path degrades vanilla lookups without failing the rest.
  const pathFor = (name: string): string | undefined =>
    winnerByName.get(name.toLowerCase()) ?? (dataFolder ? join(dataFolder, name) : undefined);

  const results = new Map<string, PluginOrderStatus>();
  const verdicts = await Promise.all(
    order.map(async (name, i) => {
      const path = pathFor(name);
      if (!path) {
        log(`[statusChecker] could not resolve a path for "${name}" — skipping its master-order check`);
        return { name, status: { kind: 'ok' } as PluginOrderStatus };
      }
      let masters: string[];
      try {
        masters = await readMasters(path);
      } catch (e) {
        log(`[statusChecker] could not read masters from ${path}: ${e instanceof Error ? e.message : String(e)}`);
        masters = [];
      }
      return { name, status: checkMasterOrder(masters, order, i) };
    }),
  );
  for (const { name, status } of verdicts) {
    if (status.kind !== 'ok') results.set(name, status);
  }
  return results;
}
