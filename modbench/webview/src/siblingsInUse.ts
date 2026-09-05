import type { FieldMetadata } from './types';

// FieldMetadata.siblingsInUse: an enum member whose value decides which sibling members carry
// data. Answers which rows to show, over metadata alone so no game is named here; what a change
// idles is the writer's to clear (ADR-0032).

function governing(structMeta: FieldMetadata): FieldMetadata[] {
  return (structMeta.fields ?? []).filter(f => f.siblingsInUse != null);
}

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

/** A member in use in *any* column stays — a row is shared by every column, and hiding one
 *  because the winner idles it would hide a losing override's own data. */
export function idleMembers(structMeta: FieldMetadata, structValues: readonly unknown[]): Set<string> {
  const idle = new Set<string>();
  for (const member of governing(structMeta)) {
    const live = new Set(structValues.flatMap(v => [...inUse(member, v)]));
    for (const name of governed(member)) if (!live.has(name)) idle.add(name);
  }
  return idle;
}
