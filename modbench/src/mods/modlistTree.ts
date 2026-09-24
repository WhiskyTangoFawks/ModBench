// `modlist.txt` is winning-first while MO2's authoring view is losing-at-top, so a separator is
// written after the mods it heads, and wraps the entries preceding it. vscode-free, so
// unit-testable.

import type { Mod, ModlistEntry, Separator } from '../instanceLoader/instance';

export interface ModlistGroup {
  separator: Separator;
  mods: Mod[];
}

export interface ModlistTree {
  ungrouped: Mod[];
  groups: ModlistGroup[];
  activeCount: number;
  /** Total mods (separators excluded). */
  installedCount: number;
}

export function groupModlist(entries: ModlistEntry[]): ModlistTree {
  const groups: ModlistGroup[] = [];
  let buffered: Mod[] = [];
  let activeCount = 0;
  let installedCount = 0;

  const read = new Set<string>();
  for (const entry of entries) {
    // MO2 skips a line whose name it has already read (profile.cpp), so the first line holds.
    const key = `${entry.kind}:${entry.name}`;
    if (read.has(key)) continue;
    read.add(key);
    if (entry.kind === 'separator') {
      groups.push({ separator: entry, mods: buffered });
      buffered = [];
      continue;
    }
    installedCount++;
    if (entry.enabled) activeCount++;
    buffered.push(entry);
  }

  return { ungrouped: buffered, groups, activeCount, installedCount };
}
