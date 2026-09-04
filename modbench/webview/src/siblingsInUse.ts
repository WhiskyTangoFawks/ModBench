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

function inUse(meta: FieldMetadata, structValue: unknown): readonly string[] {
  const value = (structValue as Record<string, unknown> | null | undefined)?.[meta.name];
  return meta.siblingsInUse?.[String(value)] ?? [];
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
 * This struct value with every sibling the governing member's own current value idles set to null
 * — applied where the element is assembled for commit, so a function or Run On change never leaves
 * a stale slot behind for the writer to find.
 */
export function clearIdleSiblings(governingMeta: FieldMetadata, structValue: unknown): unknown {
  if (governingMeta.siblingsInUse == null || structValue == null || typeof structValue !== 'object') {
    return structValue;
  }
  const live = new Set(inUse(governingMeta, structValue));
  const next = { ...(structValue as Record<string, unknown>) };
  for (const name of governed(governingMeta)) if (!live.has(name) && name in next) next[name] = null;
  return next;
}
