import type { Instance } from '../instanceLoader/instance';
import { modNameCollisionRefusal } from '../install/install';
import { modNameKey } from '../modlist/modlist';

export function collidingModName(instance: Pick<Instance, 'value'>, name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  const collides = instance.value.mods.some((e) => e.kind === 'mod' && modNameKey(e.name) === modNameKey(trimmed));
  return collides ? modNameCollisionRefusal(trimmed) : undefined;
}
