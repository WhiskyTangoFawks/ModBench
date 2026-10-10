import { variantFor } from './recordUtils';
import type { FieldMetadata } from './types';

// FieldMetadata.siblingsInUse: an enum member whose value decides which sibling members carry
// data. Answers which rows to show, over metadata alone so no game is named here (ADR-0005).

// Every sibling this member speaks for at all — a member it never names under any value is not
// governed by it and is always shown.
function governed(meta: FieldMetadata): Set<string> {
  return new Set(Object.values(meta.siblingsInUse ?? {}).flat());
}

export function siblingsInUseFor(meta: FieldMetadata, value: unknown): readonly string[] {
  return meta.siblingsInUse?.[String(value)] ?? [];
}

function inUse(meta: FieldMetadata, structValue: unknown): readonly string[] {
  return siblingsInUseFor(meta, (structValue as Record<string, unknown> | null | undefined)?.[meta.name]);
}

/** A member in use in *any* column, by the governing member its own leaf declares, stays: hiding
 *  one because the winner idles it would hide a losing override's own data. */
export function idleMembers(structMeta: FieldMetadata, structValues: readonly unknown[]): Set<string> {
  const idle = new Set<string>();
  for (const member of structMeta.fields ?? []) {
    const shapes = structValues.map(v => ({ value: v, meta: variantFor(member, v, structMeta) }));
    const live = new Set(shapes.flatMap(s => [...inUse(s.meta, s.value)]));
    for (const name of new Set(shapes.flatMap(s => [...governed(s.meta)]))) if (!live.has(name)) idle.add(name);
  }
  return idle;
}
