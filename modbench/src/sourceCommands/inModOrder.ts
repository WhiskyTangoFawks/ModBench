import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';

/** `mods` from the losing end of mod order to the winning end; a mod mod order does not list comes first. */
export async function inModOrder(adapter: Pick<InstanceAdapter, 'modOrder' | 'entryKey'>, mods: readonly string[]): Promise<string[]> {
  const { mods: winningFirst } = await adapter.modOrder();
  const listed = winningFirst.filter(({ kind }) => kind === 'mod');
  const place = new Map(listed.map((entry, at) => [adapter.entryKey(entry), at]));
  const placeOf = (mod: string): number => place.get(adapter.entryKey({ kind: 'mod', name: mod })) ?? listed.length;
  return [...mods].sort((a, b) => placeOf(b) - placeOf(a));
}
