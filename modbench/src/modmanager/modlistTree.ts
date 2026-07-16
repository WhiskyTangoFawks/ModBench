// Pure grouping of the flat ModlistEntry[] read-model into the shape the Mod List
// tree renders: each separator wraps the mods that PRECEDE it in file order, back
// to the previous separator (see #107 — modlist.txt is winning-first while MO2's
// authoring view is losing-at-top, so a separator is written after the mods it
// heads). Mods after the last separator are ungrouped root items. vscode-free so
// it stays unit-testable.

import type { Mod, ModlistEntry, Separator } from './model';

export interface ModlistGroup {
  separator: Separator;
  mods: Mod[];
}

export interface ModlistTree {
  /** Mods after the last separator — rendered as direct root items. */
  ungrouped: Mod[];
  /** Each separator and the mods that precede it, back to the previous separator. */
  groups: ModlistGroup[];
  /** Enabled mods. */
  activeCount: number;
  /** Total mods (separators excluded). */
  installedCount: number;
}

export function groupModlist(entries: ModlistEntry[]): ModlistTree {
  const groups: ModlistGroup[] = [];
  let pending: Mod[] = [];
  let activeCount = 0;
  let installedCount = 0;

  for (const entry of entries) {
    if (entry.kind === 'separator') {
      groups.push({ separator: entry, mods: pending });
      pending = [];
      continue;
    }
    installedCount++;
    if (entry.enabled) activeCount++;
    pending.push(entry);
  }

  return { ungrouped: pending, groups, activeCount, installedCount };
}
