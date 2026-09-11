// Turns a FileConflictIndex into per-mod status badges: conflict/override counts and missing mod
// folders. Pure over ModlistEntry[] + instanceRoot + a precomputed FileConflictIndex; no vscode
// import, and no plugin file is opened — master facts are the backend's (ADR-0016).

import { stat } from 'node:fs/promises';
import { modDir } from './mo2/layout';
import type { ModlistEntry } from './model';
import type { FileConflictIndex } from './fileConflictIndex';

export type ModStatus =
  | { kind: 'ok' }
  | { kind: 'conflicts'; count: number }
  | { kind: 'overrides'; count: number }
  | { kind: 'missingMod' };

export interface ModStatusResult {
  status: ModStatus;
  /** Hover tooltip lines: conflicting relative paths and their winner. */
  conflictLines: string[];
}

type ModFile = { relativePath: string; absolutePath: string };

export async function computeModStatuses(
  entries: ModlistEntry[],
  instanceRoot: string,
  index: FileConflictIndex,
): Promise<Map<string, ModStatusResult>> {
  const mods = entries.filter((e): e is Extract<ModlistEntry, { kind: 'mod' }> => e.kind === 'mod');
  // Each entry's own stat is independent, so run them concurrently — a mod count in the hundreds
  // made the old sequential loop the dominant cost of a recompute.
  const statuses = await Promise.all(mods.map((entry) => computeEntryStatus(entry, instanceRoot, index)));
  return new Map(mods.map((entry, i) => [entry.name, statuses[i]]));
}

async function computeEntryStatus(
  entry: ModlistEntry,
  instanceRoot: string,
  index: FileConflictIndex,
): Promise<ModStatusResult> {
  if (!(await modFolderExists(instanceRoot, entry.name))) {
    return { status: { kind: 'missingMod' }, conflictLines: [] };
  }
  if (!entry.enabled) return { status: { kind: 'ok' }, conflictLines: [] };

  const modFiles = index.filesByMod.get(entry.name) ?? [];
  const { conflictLines, conflicts, overrides } = countConflicts(modFiles, index, entry.name);
  return { status: classifyStatus(conflicts, overrides), conflictLines };
}

// ENOENT reads as absent; any other stat error propagates.
async function modFolderExists(instanceRoot: string, modName: string): Promise<boolean> {
  try {
    await stat(modDir(instanceRoot, modName));
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

function classifyStatus(conflicts: number, overrides: number): ModStatus {
  if (conflicts > 0) return { kind: 'conflicts', count: conflicts };
  if (overrides > 0) return { kind: 'overrides', count: overrides };
  return { kind: 'ok' };
}
