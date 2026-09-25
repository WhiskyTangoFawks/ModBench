// Where a new plugin can live, read off the Instance's own value: no vscode import, no backend
// call, and no path joined here.

import type { InstanceValue } from '../instanceLoader/instance';
import { OVERWRITE_ORIGIN } from '../instanceLoader/loadOrderSnapshot';

export interface PluginPlace {
  readonly label: string;
  readonly origin: string;
}

const enabledModNames = (value: Pick<InstanceValue, 'mods'>): string[] =>
  value.mods.filter((entry) => entry.kind === 'mod' && entry.enabled).map((entry) => entry.name);

/** Overwrite first, then the enabled mods, each left out when it already holds a plugin named
 *  `name`. The same name elsewhere in the load order is not checked. */
export function pluginPlaces(value: Pick<InstanceValue, 'mods' | 'plugins'>, name: string): PluginPlace[] {
  const folded = name.toLowerCase();
  const holds = (origin: string): boolean =>
    value.plugins.some((p) => p.path !== undefined && p.origin === origin && p.name.toLowerCase() === folded);
  return [
    { label: 'Overwrite', origin: OVERWRITE_ORIGIN },
    ...enabledModNames(value).map((mod) => ({ label: mod, origin: mod })),
  ].filter((place) => !holds(place.origin));
}

/** `undefined` for a mod the value does not list as enabled, or names no folder for: one that
 *  vanished between the pick and the answer. */
export function placeFolder(value: Pick<InstanceValue, 'mods' | 'paths'>, origin: string): string | undefined {
  if (origin === OVERWRITE_ORIGIN) return value.paths.overwriteDir;
  return enabledModNames(value).includes(origin) ? value.paths.modDirs.get(origin) : undefined;
}
