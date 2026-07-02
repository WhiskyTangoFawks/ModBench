// Turns a FileConflictIndex into per-mod status badges: conflict/override
// counts, missing masters, missing mod folders. Pure over ModlistEntry[] +
// instanceRoot + a precomputed FileConflictIndex; no vscode import.

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModlistEntry } from './model';
import type { FileConflictIndex } from './fileConflictIndex';
import { readMasters } from './masterReader';

const PLUGIN_EXTENSIONS = new Set(['.esp', '.esm', '.esl']);

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
  const dot = relativePath.lastIndexOf('.');
  return dot !== -1 && PLUGIN_EXTENSIONS.has(relativePath.slice(dot).toLowerCase());
}

/** Lowercased basenames of every plugin any enabled mod provides. */
function providedPluginBasenames(filesByMod: FileConflictIndex['filesByMod']): Set<string> {
  const basenames = new Set<string>();
  for (const files of filesByMod.values()) {
    for (const file of files) {
      if (isPlugin(file.relativePath)) basenames.add(file.relativePath.split('/').pop()!.toLowerCase());
    }
  }
  return basenames;
}

export async function computeModStatuses(
  entries: ModlistEntry[],
  instanceRoot: string,
  index: FileConflictIndex,
  vanillaMasters: Set<string>,
  log?: (msg: string) => void,
): Promise<Map<string, ModStatusResult>> {
  const results = new Map<string, ModStatusResult>();
  const providedPlugins = providedPluginBasenames(index.filesByMod);

  for (const entry of entries) {
    if (entry.kind !== 'mod') continue;

    try {
      await stat(join(instanceRoot, 'mods', entry.name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        results.set(entry.name, { status: { kind: 'missingMod' }, conflictLines: [] });
        continue;
      }
      throw err;
    }

    if (!entry.enabled) {
      results.set(entry.name, { status: { kind: 'ok' }, conflictLines: [] });
      continue;
    }

    const modFiles = index.filesByMod.get(entry.name) ?? [];

    const conflictLines: string[] = [];
    let conflicts = 0;
    let overrides = 0;
    for (const file of modFiles) {
      const conflict = index.files.get(file.relativePath);
      if (!conflict || conflict.providers.length < 2) continue;
      conflictLines.push(`${file.relativePath} → winner: ${conflict.winnerMod}`);
      if (conflict.winnerMod === entry.name) overrides++;
      else conflicts++;
    }

    const pluginFiles = modFiles.filter((f) => isPlugin(f.relativePath));
    const mastersPerPlugin = await Promise.all(
      pluginFiles.map(async (f) => {
        try {
          return await readMasters(f.absolutePath);
        } catch (e) {
          // A malformed/unreadable plugin must not blank the whole tree — skip
          // its masters (can't determine them) rather than throwing.
          log?.(`[statusChecker] could not read masters from ${f.absolutePath}: ${e instanceof Error ? e.message : String(e)}`);
          return [];
        }
      }),
    );
    const missingMasters = new Set<string>();
    for (const master of mastersPerPlugin.flat()) {
      const lower = master.toLowerCase();
      if (!vanillaMasters.has(lower) && !providedPlugins.has(lower)) missingMasters.add(master);
    }

    let status: ModStatus;
    if (missingMasters.size > 0) status = { kind: 'missingMaster', masters: [...missingMasters] };
    else if (conflicts > 0) status = { kind: 'conflicts', count: conflicts };
    else if (overrides > 0) status = { kind: 'overrides', count: overrides };
    else status = { kind: 'ok' };

    results.set(entry.name, { status, conflictLines });
  }

  return results;
}
