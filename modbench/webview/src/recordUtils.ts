import type { CompareOverride, FieldMetadata, RecordDetail } from './types';
import type { ColumnHeaderContext, PendingCellContext } from './messages';

export function toStr(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v) ?? '';
}

// Issue #208: the pending cell's right-click menu (Reveal in Pending Changes Tree / Save Group /
// Revert Group) is VS Code's own `contributes.menus["webview/context"]` now, not a hand-drawn
// `<ul role="menu">`. `webviewSection` is the gating key every menu entry's `when` clause checks
// (alongside VS Code's own `webviewId`, which equals the view type passed to
// `createWebviewPanel` — 'modbench'); `changeId` is forwarded to the invoked command as part of
// the merged context object. `preventDefaultContextMenuItems` suppresses the built-in Cut/Copy/
// Paste entries. Shared by every render site that owns a pending cell (DiffRow, VmadSection x3,
// ConditionSection) so the shape can't drift between them — the cell must NOT also call
// `e.preventDefault()` on the contextmenu event, or VS Code's webview preload bails and the
// native menu never opens (that omission is the actual migration switch, site by site).
export function pendingCellContext(changeId: string): string {
  return JSON.stringify({
    webviewSection: 'pendingCell', changeId, preventDefaultContextMenuItems: true,
  } satisfies PendingCellContext);
}

// Issue #86: the header record's "masters" field, pending-aware (a still-unsaved Add Master
// already counts as current — matches the backend's CheckMasterEdit baseline convention).
// Moved here from PluginHeader.tsx in #209: RecordPanel now needs it too, to build the column
// header's data-vscode-context (below) and to compute the appended list when the native Add
// Master command's broadcast comes back in.
export function currentMasters(o: RecordDetail): string[] {
  const disk = o.fields.find(f => f.metadata.name === 'masters')?.value;
  const pending = o.pendingFields?.masters;
  const value = Array.isArray(pending) ? pending : disk;
  return Array.isArray(value) ? value as string[] : [];
}

// Issue #209: the column-header right-click menu (Copy All to Pending / Copy as New Record /
// Copy as Override… / Remove / Add Master) is native now too — same mechanism as
// pendingCellContext above, carried by the header `<th>` instead of a pending cell. `plugin` is
// this column's own plugin (the copy actions' exclude-from-target-picker source; Remove's
// direct target); `masters` backs the Add Master command's candidate list without a round trip
// back into the webview to ask (see ColumnHeaderContext's own doc comment for why that list is
// NOT filtered to mutable plugins the way the copy actions' picker is).
export function columnHeaderContext(
  formKey: string, plugin: string, immutable: boolean, isHeaderRecord: boolean, masters: string[],
): string {
  return JSON.stringify({
    webviewSection: 'columnHeader', formKey, plugin, immutable, isHeaderRecord, masters,
    preventDefaultContextMenuItems: true,
  } satisfies ColumnHeaderContext);
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
