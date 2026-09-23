// Turns a FileConflictIndex into per-mod status badges: conflict and override counts. Pure over
// ModlistEntry[] + a precomputed FileConflictIndex; no vscode import, and no plugin file is
// opened — master facts are the backend's (ADR-0016).

import type { ModlistEntry } from '../mo2Codecs/modlistText';
import type { FileConflictIndex } from './fileConflictIndex';

export type ModStatus =
  | { kind: 'ok' }
  | { kind: 'conflicts'; count: number }
  | { kind: 'overrides'; count: number };

export interface ModStatusResult {
  status: ModStatus;
  /** Hover tooltip lines: conflicting relative paths and their winner. */
  conflictLines: string[];
}

type ModFile = { relativePath: string; absolutePath: string };

export function computeModStatuses(entries: ModlistEntry[], index: FileConflictIndex): Map<string, ModStatusResult> {
  const mods = entries.filter((e): e is Extract<ModlistEntry, { kind: 'mod' }> => e.kind === 'mod');
  return new Map(mods.map((entry): [string, ModStatusResult] => [entry.name, computeEntryStatus(entry, index)]));
}

function computeEntryStatus(entry: ModlistEntry, index: FileConflictIndex): ModStatusResult {
  if (!entry.enabled) return { status: { kind: 'ok' }, conflictLines: [] };

  const modFiles = index.filesByMod.get(entry.name) ?? [];
  const { conflictLines, conflicts, overrides } = countConflicts(modFiles, index, entry.name);
  return { status: classifyStatus(conflicts, overrides), conflictLines };
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
