import type { InstanceValue, Mod } from './instance';
import { sameEntry } from '../instanceAdapter/instanceAdapter';

/** The listed mod an origin names, matched as the mod manager matches names.
 *  Overwrite and the game's Data folder name none. */
export function modOfOrigin(value: Pick<InstanceValue, 'mods' | 'entryKey'>, origin: string): Mod | undefined {
  const named = { kind: 'mod' as const, name: origin };
  return value.mods.find((entry): entry is Mod => sameEntry(value, entry, named));
}
