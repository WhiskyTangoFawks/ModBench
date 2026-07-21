import type { CompareOverride } from './types';

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
