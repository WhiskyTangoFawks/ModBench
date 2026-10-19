// Where a new plugin can live, read off the Instance's own value: no vscode import, no backend
// call, and no path joined here.

import type { InstanceValue } from '../instanceLoader/instance';
import { modOfOrigin } from '../instanceLoader/modOfOrigin';
import { pluginPlacesOf } from '../instanceLoader/pluginPlacesOf';
import { OVERWRITE_ORIGIN, samePluginAddress, type PluginAddress, type PluginPlace } from '../wire/pluginAddress';

function holdsPlugin(value: Pick<InstanceValue, 'plugins'>, plugin: PluginAddress): boolean {
  return value.plugins.some((p) => p.path !== undefined && samePluginAddress(p, plugin));
}

/** The places the snapshot offers, each left out when it already holds a plugin named `name`. */
export function pluginPlaces(value: Pick<InstanceValue, 'mods' | 'paths' | 'plugins'>, name: string): PluginPlace[] {
  return pluginPlacesOf(value).filter((place) => !holdsPlugin(value, { name, origin: place.name }));
}

/** The place, with a source mod's source folder; or what became of a mod between the pick and the answer, or that the
 *  value names no folder for Overwrite yet. */
export type PlaceFolder = PluginPlace | { readonly lost: 'gone' | 'disabled' | 'unread' };

export function placeFolder(value: Pick<InstanceValue, 'mods' | 'paths' | 'entryKey'>, origin: string): PlaceFolder {
  const mod = modOfOrigin(value, origin)?.name ?? origin;
  const place = pluginPlacesOf(value).find((held) => held.name === mod);
  if (place !== undefined) return place;
  if (origin === OVERWRITE_ORIGIN) return { lost: 'unread' };
  return { lost: value.paths.modDirs.has(mod) ? 'disabled' : 'gone' };
}
