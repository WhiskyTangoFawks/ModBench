import type { InstanceValue } from './instance';
import { isDisabledOrInDisabledMod } from './disabledPlugin';
import { foldPath, OVERWRITE_LABEL } from './fileConflictIndex';
import { DATA_DIRECTORY_ORIGIN, OVERWRITE_ORIGIN } from './loadOrderSnapshot';
import { samePluginAddress, type PluginAddress } from '../wire/pluginAddress';

export type PluginStanding = { kind: 'enabled' } | { kind: 'disabled' } | { kind: 'overridden'; by: string };

type StandingFacts = Pick<InstanceValue, 'mods' | 'plugins' | 'pluginsLoadedWithNoLine'>;

const GAME_FOLDER_LABEL = 'the game folder';

export function pluginStanding(value: StandingFacts, plugin: PluginAddress): PluginStanding {
  if (isDisabledOrInDisabledMod(value, plugin)) return { kind: 'disabled' };
  const winner = value.plugins.find((row) => row.winning && row.enabled && foldPath(row.name) === foldPath(plugin.name));
  if (winner === undefined || samePluginAddress(winner, plugin)) return { kind: 'enabled' };
  return { kind: 'overridden', by: originName(winner.origin) };
}

// A winning enabled file's origin is the exact name of its mod, Overwrite or the Data folder (plugins.md, A row, Tooltip).
function originName(origin: string): string {
  if (origin === OVERWRITE_ORIGIN) return OVERWRITE_LABEL;
  return origin === DATA_DIRECTORY_ORIGIN ? GAME_FOLDER_LABEL : origin;
}
