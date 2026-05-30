import type { RecordDetail } from './types';

export type Column =
  | { kind: 'disk'; override: RecordDetail }
  | { kind: 'pending'; plugin: string };

export function buildColumns(overrides: RecordDetail[], immutableSet?: Set<string>): Column[] {
  const cols: Column[] = [];
  for (const o of overrides) {
    cols.push({ kind: 'disk', override: o });
    if (o.pendingFields && Object.keys(o.pendingFields).length > 0 && !immutableSet?.has(o.plugin)) {
      cols.push({ kind: 'pending', plugin: o.plugin });
    }
  }
  return cols;
}
