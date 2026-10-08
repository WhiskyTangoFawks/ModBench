import type { InstanceValue } from './instance';
import { isDisabledOrInDisabledMod } from './disabledPlugin';
import { foldPath, OVERWRITE_LABEL } from './fileConflictIndex';
import { OVERWRITE_ORIGIN } from './loadOrderSnapshot';
import { samePluginAddress, type PluginAddress } from '../wire/pluginAddress';

export type PluginStanding = { kind: 'enabled' } | { kind: 'disabled' } | { kind: 'overridden'; by: string };

type StandingFacts = Pick<InstanceValue, 'mods' | 'plugins' | 'pluginsLoadedWithNoLine'>;

/** `by` names the winning file's mod as the Mods view does. */
export function pluginStanding(value: StandingFacts, plugin: PluginAddress): PluginStanding {
  if (isDisabledOrInDisabledMod(value, plugin)) return { kind: 'disabled' };
  const winner = value.plugins.find((row) => row.winning && row.enabled && foldPath(row.name) === foldPath(plugin.name));
  if (winner === undefined || samePluginAddress(winner, plugin)) return { kind: 'enabled' };
  return { kind: 'overridden', by: modName(value, winner.origin) };
}

function modName(value: StandingFacts, origin: string): string {
  if (origin === OVERWRITE_ORIGIN) return OVERWRITE_LABEL;
  return value.mods.find((entry) => entry.kind === 'mod' && foldPath(entry.name) === foldPath(origin))?.name ?? origin;
}
