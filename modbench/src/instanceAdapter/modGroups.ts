import type { Mod, ModGroup, ModGroups, ModlistEntry } from './instanceAdapter';

/** Mod order arrives winning-first, so a separator holds the mods before it. */
export function groupModOrder(order: readonly ModlistEntry[]): ModGroups {
  const groups: ModGroup[] = [];
  let held: Mod[] = [];
  for (const entry of order) {
    if (entry.kind === 'separator') {
      groups.push({ separator: entry, mods: held });
      held = [];
    } else {
      held.push(entry);
    }
  }
  return { ungrouped: held, groups };
}
