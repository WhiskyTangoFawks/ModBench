import type { Instance } from '../instance/instance';

/** Install's refusal when a new mod's folder is already there, shared with the name prompt so
 *  both readings of the same collision say the same thing. */
export function modNameCollisionRefusal(name: string): string {
  return `A mod named "${name}" already exists — install its next release from the Downloads view instead.`;
}

export function collidingModName(instance: Pick<Instance, 'value'>, name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  const collides = instance.value.mods.some((e) => e.kind === 'mod' && e.name === trimmed);
  return collides ? modNameCollisionRefusal(trimmed) : undefined;
}
