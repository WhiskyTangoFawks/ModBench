/** The mod a Mods row stands for. A row is recognised by its shape, so a gesture reads it without
 *  importing the box that builds it (ADR-0014). */
export function modOfRow(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('kind' in value) || value.kind !== 'mod') return undefined;
  if (!('mod' in value) || typeof value.mod !== 'object' || value.mod === null) return undefined;
  return 'name' in value.mod && typeof value.mod.name === 'string' ? value.mod.name : undefined;
}
