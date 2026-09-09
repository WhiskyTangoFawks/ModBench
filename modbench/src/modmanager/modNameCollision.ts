import type { Instance } from './instance';

// Install treats an existing target as an upgrade, so the name prompt is what keeps a
// collision out, pointing at where an upgrade belongs instead.
export function collidingModName(instance: Pick<Instance, 'value'>, name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  const collides = instance.value.mods.some((e) => e.kind === 'mod' && e.name === trimmed);
  return collides
    ? `A mod named "${trimmed}" already exists — install its next release from the Downloads view instead.`
    : undefined;
}
