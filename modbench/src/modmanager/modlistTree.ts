// Pure grouping of the flat ModlistEntry[] read-model into the shape the Mod List
// tree renders: ungrouped mods (before the first separator) as root items, then
// each separator with the mods that follow it. vscode-free so it stays unit-testable.

import type { Mod, ModlistEntry, Separator } from './model';

export interface ModlistGroup {
  separator: Separator;
  mods: Mod[];
}

export interface ModlistTree {
  /** Mods before the first separator — rendered as direct root items. */
  ungrouped: Mod[];
  /** Each separator and the mods that follow it until the next separator. */
  groups: ModlistGroup[];
  /** Enabled mods. */
  activeCount: number;
  /** Total mods (separators excluded). */
  installedCount: number;
}

export function groupModlist(entries: ModlistEntry[]): ModlistTree {
  const ungrouped: Mod[] = [];
  const groups: ModlistGroup[] = [];
  let activeCount = 0;
  let installedCount = 0;

  for (const entry of entries) {
    if (entry.kind === 'separator') {
      groups.push({ separator: entry, mods: [] });
      continue;
    }
    installedCount++;
    if (entry.enabled) activeCount++;
    if (groups.length === 0) ungrouped.push(entry);
    else groups[groups.length - 1].mods.push(entry);
  }

  return { ungrouped, groups, activeCount, installedCount };
}
