import type { CompareOverride, FieldMetadata } from './types';

export function toStr(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v) ?? '';
}

export type Column =
  | { kind: 'disk'; override: CompareOverride }
  | { kind: 'pending'; plugin: string };

export function buildColumns(overrides: CompareOverride[], immutableSet?: Set<string>): Column[] {
  const cols: Column[] = [];
  for (const o of overrides) {
    cols.push({ kind: 'disk', override: o });
    if (o.pendingFields && Object.keys(o.pendingFields).length > 0 && !immutableSet?.has(o.plugin)) {
      cols.push({ kind: 'pending', plugin: o.plugin });
    }
  }
  return cols;
}

// ── Array child helpers ───────────────────────────────────────────────────────

export function parseElementIndex(fieldName: string): number {
  return Number.parseInt(fieldName.slice(1, -1), 10);
}

export function pendingIfChanged(pending: unknown, disk: unknown): unknown {
  if (pending === undefined) return undefined;
  if (pending === disk) return undefined;
  if (JSON.stringify(pending) === JSON.stringify(disk)) return undefined;
  return pending;
}

export function extractPendingElementValue(
  rawPending: unknown,
  fieldName: string,
  isSortable: boolean,
  diskValue: unknown,
): unknown {
  if (!Array.isArray(rawPending)) return undefined;
  let pending: unknown;
  if (isSortable) {
    if (!(rawPending as unknown[]).includes(fieldName)) return undefined;
    pending = fieldName;
  } else {
    const idx = parseElementIndex(fieldName);
    if (idx >= (rawPending as unknown[]).length) return undefined;
    pending = (rawPending as unknown[])[idx];
  }
  return pendingIfChanged(pending, diskValue);
}

export function updateArrayAtKey(
  array: unknown[],
  elementKey: string,
  newValue: unknown,
  isSortable: boolean,
): unknown[] {
  if (isSortable) {
    return array.map(e => (e === elementKey ? newValue : e));
  }
  const idx = parseElementIndex(elementKey);
  return array.map((e, i) => (i === idx ? newValue : e));
}

// Issue #142: the value a freshly-appended array element starts with, derived from the
// element's own FieldMetadata (RecordPanel's "＋" control on an unsorted array's parent row).
// Struct elements (e.g. Factions: { Faction: FormKey, Rank: int }) recurse field-by-field —
// mirrors VmadSection's defaultElementValue/defaultNode pair, but keyed off the compare grid's
// own FieldMetadata shape rather than VMAD's raw node JSON, which the two do not share.
// The `default` arm is deliberate, not lazy: an unrecognized/future `type` returns '' rather than
// falling through to `undefined`, which would silently append a hole into a saved array.
export function defaultElementValue(meta: FieldMetadata): unknown {
  switch (meta.type) {
    case 'string': case 'formKey': return '';
    case 'int': case 'float': return 0;
    case 'bool': return false;
    case 'enum': return meta.enumValues[0] ?? '';
    case 'struct': return Object.fromEntries((meta.fields ?? []).map(f => [f.name, defaultElementValue(f)]));
    case 'array': return [];
    default: return '';
  }
}
