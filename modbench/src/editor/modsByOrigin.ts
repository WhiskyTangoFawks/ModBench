import type * as vscode from 'vscode';
import type { ModRepository } from '../wire/messages';
import type { PluginAddress } from '../wire/pluginAddress';
import type { PluginStanding } from '../instanceLoader/pluginStanding';

export interface ModFacts {
  listedSourceMods: () => ReadonlySet<string>;
  modOfOrigin: (origin: string) => string | undefined;
  standingOf: (plugin: PluginAddress) => PluginStanding;
  onChange: (listener: () => void) => vscode.Disposable;
}

/** An origin in no mod, as the game's and Overwrite's are, is left out. */
export function modsByOrigin(origins: Iterable<string>, facts: ModFacts): Record<string, ModRepository> {
  const listedSourceMods = facts.listedSourceMods();
  return Object.fromEntries([...new Set(origins)].flatMap((origin) => {
    const mod = facts.modOfOrigin(origin);
    return mod === undefined ? [] : [[origin, listedSourceMods.has(mod) ? 'sourceMod' : 'nonSourceMod'] as const];
  }));
}
