import type { Instance } from '../instance/instance';
import { modNameCollisionRefusal } from '../install/install';

export function collidingModName(instance: Pick<Instance, 'value'>, name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  const collides = instance.value.mods.some((e) => e.kind === 'mod' && e.name === trimmed);
  return collides ? modNameCollisionRefusal(trimmed) : undefined;
}
