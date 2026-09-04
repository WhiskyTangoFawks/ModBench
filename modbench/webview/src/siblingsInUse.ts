import type { FieldMetadata } from './types';

// FieldMetadata.siblingsInUse (Models.cs): an enum member whose own value decides which of its
// sibling members carry data, keyed by value. Fallout 4's condition function and Run On are the
// members that have one — a function moves which of Mutagen's six aliased parameter members holds
// the value, and Run On's reference target is read under one value only.
//
// The same map answers both halves of that: which rows to show (a member no column's value puts in
// use holds nothing to show), and what an edit to the governing member has to clear (a member the
// new value idles would otherwise be written from a stale slot — Condition's own string exports
// write CIS1/CIS2 for any non-null value without consulting the function). Both are stated once
// here, over metadata, so no game is named on this side of the wire.

function governing(structMeta: FieldMetadata): FieldMetadata[] {
  return (structMeta.fields ?? []).filter(f => f.siblingsInUse != null);
}

// Every sibling this member speaks for at all — a member it never names under any value is not
// governed by it and is always shown.
function governed(meta: FieldMetadata): Set<string> {
  return new Set(Object.values(meta.siblingsInUse ?? {}).flat());
}

/** The siblings this member keeps in use under one of its own values. The single reader of the
 *  map — the row filter, the cascade and the presentation table all come through here. */
export function siblingsInUseFor(meta: FieldMetadata, value: unknown): readonly string[] {
  return meta.siblingsInUse?.[String(value)] ?? [];
}

function inUse(meta: FieldMetadata, structValue: unknown): readonly string[] {
  return siblingsInUseFor(meta, (structValue as Record<string, unknown> | null | undefined)?.[meta.name]);
}

/**
 * The members of this struct that hold no data under any of the given columns' values, and so have
 * no row. A member in use in *any* column stays — a row is shared by every column, and hiding one
 * because the winner idles it would hide a losing override's own data.
 */
export function idleMembers(structMeta: FieldMetadata, structValues: readonly unknown[]): Set<string> {
  const idle = new Set<string>();
  for (const member of governing(structMeta)) {
    const live = new Set(structValues.flatMap(v => [...inUse(member, v)]));
    for (const name of governed(member)) if (!live.has(name)) idle.add(name);
  }
  return idle;
}

/**
 * What a member with no data holds. A nullable member (a string, a form link) says so with null;
 * a member the format always writes says so with its type's own zero — Mutagen models a condition's
 * numeric parameter as a plain `Int32`, and the write path rejects a JSON null into a non-nullable
 * column, which fails the *whole* array write, not just that member.
 *
 * Deliberately not `recordUtils.defaultAdapterElementValue`, which answers a different question —
 * what a VMAD adapter's synthesized element starts as (#710 keeps every reflected default on the
 * backend). This is what an existing reflected member reads as once it carries nothing.
 */
function emptied(meta: FieldMetadata | undefined): unknown {
  switch (meta?.type) {
    case 'int': case 'float': case 'hex': return 0;
    case 'bool': return false;
    default: return null;
  }
}

/**
 * This struct value with every sibling the governing member's own current value idles emptied —
 * applied where the element is assembled for commit, so a function or Run On change never leaves a
 * stale slot behind for the writer to find.
 *
 * `siblings` is the struct's own schema, which is where the emptied members' types are read from.
 */
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
