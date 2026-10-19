import type { InstanceValue } from './instance';
import { isDisabledOrInDisabledMod } from './disabledPlugin';
import { foldPath, OVERWRITE_LABEL } from './fileConflictIndex';
import { DATA_DIRECTORY_ORIGIN } from './loadOrderSnapshot';
import { OVERWRITE_ORIGIN } from '../wire/pluginAddress';
import { samePluginAddress, type PluginAddress } from '../wire/pluginAddress';

export type PluginStanding = { kind: 'enabled' } | { kind: 'disabled' } | { kind: 'overridden'; by: string };

type StandingFacts = Pick<InstanceValue, 'mods' | 'entryKey' | 'plugins' | 'pluginsLoadedWithNoLine'>;

const GAME_FOLDER_LABEL = 'the game folder';

export function pluginStanding(value: StandingFacts, plugin: PluginAddress): PluginStanding {
  if (isDisabledOrInDisabledMod(value, plugin)) return { kind: 'disabled' };
  const winner = value.plugins.find((row) => row.winning && row.enabled && foldPath(row.name) === foldPath(plugin.name));
  if (winner === undefined || samePluginAddress(winner, plugin)) return { kind: 'enabled' };
  return { kind: 'overridden', by: pluginOriginName(winner.origin) };
}

/** A plugin's origin as the user reads it: its mod's name, Overwrite or the game folder (plugins.md, A row, Tooltip). */
export function pluginOriginName(origin: string): string {
  if (origin === OVERWRITE_ORIGIN) return OVERWRITE_LABEL;
  return origin === DATA_DIRECTORY_ORIGIN ? GAME_FOLDER_LABEL : origin;
}
