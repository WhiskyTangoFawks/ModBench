import { modOfOrigin } from '../drivingLib/modOfOrigin';
import type { ModRepository } from '../wire/messages';

export interface ModFacts {
  trackedMods: () => ReadonlySet<string>;
  modDirs: () => ReadonlyMap<string, string>;
}

/** An origin in no mod, as the game's and Overwrite's are, is left out. */
export function modsByOrigin(origins: Iterable<string>, facts: ModFacts): Record<string, ModRepository> {
  const trackedMods = facts.trackedMods();
  const modDirs = facts.modDirs();
  return Object.fromEntries([...new Set(origins)].flatMap((origin) => {
    const mod = modOfOrigin(modDirs, origin);
    return mod === undefined ? [] : [[origin, trackedMods.has(mod) ? 'tracked' : 'untracked'] as const];
  }));
}
