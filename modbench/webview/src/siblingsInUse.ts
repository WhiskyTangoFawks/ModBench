import type { FieldMetadata } from './types';

// FieldMetadata.siblingsInUse: an enum member whose value decides which sibling members carry
// data. Answers which rows to show and what an edit must clear, stated once over metadata so no
// game is named on this side of the wire.

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

// A member the format always writes empties to its type's zero, not null — Mutagen models a
// condition's numeric parameter as a plain `Int32`, and the write path rejects a JSON null into a
// non-nullable column.
function emptied(meta: FieldMetadata | undefined): unknown {
  switch (meta?.type) {
    case 'int': case 'float': case 'hex': return 0;
    case 'bool': return false;
    default: return null;
  }
}

/** Applied where the element is assembled for commit, so a function or Run On change never leaves
 *  a stale slot behind for the writer to find. */
export function clearIdleSiblings(
  governingMeta: FieldMetadata, siblings: readonly FieldMetadata[], structValue: unknown,
): unknown {
  if (governingMeta.siblingsInUse == null || structValue == null || typeof structValue !== 'object') {
    return structValue;
  }
  const live = new Set(inUse(governingMeta, structValue));
  const next = { ...(structValue as Record<string, unknown>) };
  for (const name of governed(governingMeta)) {
    if (!live.has(name) && name in next) next[name] = emptied(siblings.find(f => f.name === name));
  }
  return next;
}
