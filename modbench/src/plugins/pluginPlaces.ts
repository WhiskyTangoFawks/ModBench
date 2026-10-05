// Where a new plugin can live, read off the Instance's own value: no vscode import, no backend
// call, and no path joined here.

import type { InstanceValue } from '../instanceLoader/instance';
import { samePluginAddress, type PluginAddress } from '../wire/pluginAddress';
import { OVERWRITE_ORIGIN } from '../instanceLoader/loadOrderSnapshot';

export interface PluginPlace {
  readonly label: string;
  readonly origin: string;
}

const enabledModNames = (value: Pick<InstanceValue, 'mods'>): string[] =>
  value.mods.filter((entry) => entry.kind === 'mod' && entry.enabled).map((entry) => entry.name);

/** Whether the origin holds a plugin of that name, compared without case. The same name
 *  elsewhere in the load order is not checked. */
export function holdsPlugin(value: Pick<InstanceValue, 'plugins'>, plugin: PluginAddress): boolean {
  return value.plugins.some((p) => p.path !== undefined && samePluginAddress(p, plugin));
}

/** The enabled mods first, then Overwrite, each left out when it already holds a plugin named
 *  `name`. */
export function pluginPlaces(value: Pick<InstanceValue, 'mods' | 'plugins'>, name: string): PluginPlace[] {
  return [
    ...enabledModNames(value).map((mod) => ({ label: mod, origin: mod })),
    { label: 'Overwrite', origin: OVERWRITE_ORIGIN },
  ].filter((place) => !holdsPlugin(value, { name, origin: place.origin }));
}

/** The place's folder; or what became of a mod between the pick and the answer, or that the
 *  value names no folder for Overwrite yet. */
export type PlaceFolder = { readonly folder: string } | { readonly lost: 'gone' | 'disabled' | 'unread' };

export function placeFolder(value: Pick<InstanceValue, 'mods' | 'paths'>, origin: string): PlaceFolder {
  if (origin === OVERWRITE_ORIGIN) {
    const folder = value.paths.overwriteDir;
    return folder === undefined ? { lost: 'unread' } : { folder };
  }
  const mod = value.mods.find((entry) => entry.kind === 'mod' && entry.name === origin);
  const folder = value.paths.modDirs.get(origin);
  if (mod === undefined || folder === undefined) return { lost: 'gone' };
  return mod.enabled ? { folder } : { lost: 'disabled' };
}
