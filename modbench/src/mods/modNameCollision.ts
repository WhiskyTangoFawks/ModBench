import type { Instance } from '../instanceLoader/instance';
import { modNameCollisionRefusal } from '../install/install';
import type { ModlistAccess } from '../modlist/modlist';

export function collidingModName(
  access: ModlistAccess, instance: Pick<Instance, 'value'>, name: string,
): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  const key = (entryName: string): string => access.adapter.nameKey(entryName);
  const collides = instance.value.mods.some((e) => e.kind === 'mod' && key(e.name) === key(trimmed));
  return collides ? modNameCollisionRefusal(trimmed) : undefined;
}
