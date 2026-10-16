import type { InstanceValue } from './instance';

/** The listed mod an origin names, as the mod order spells it, matched as the mod manager matches names.
 *  Overwrite and the game's Data folder name none. */
export function modOfOrigin(value: Pick<InstanceValue, 'mods' | 'entryKey'>, origin: string): string | undefined {
  const named = value.entryKey({ kind: 'mod', name: origin });
  return value.mods.find((entry) => entry.kind === 'mod' && value.entryKey(entry) === named)?.name;
}
