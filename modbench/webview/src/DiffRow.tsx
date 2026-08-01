import React, { useState } from 'react';
import { FlagCell } from './FlagCell';
import { ScalarCell } from './ScalarCell';
import { FormKeyCell } from './FormKeyCell';
import { CheckErrorIcon } from './CheckErrorIcon';
import { baseCell, toggleBtnStyle, getCellStyle } from './gridStyles';
import { pendingIfChanged, extractPendingElementValue } from './recordUtils';
import type { Column } from './recordUtils';
import type { CompareOverride, ConflictAll, FieldDiff, FieldMetadata, FormKeyResolution, PendingChange } from './types';
import type { RecordSessionClient } from './RecordSessionClient';

// Issue #142: per-element move-up/move-down/remove controls for unsorted array rows. Only
// created by the caller (RecordPanel) when the element's metadata reports `isSortable !== true`
// — DiffRow itself does no sortedness branching, so "sorted arrays get no controls" stays
// enforced in exactly one place. `currentArray` mirrors the pending-aware merge RecordPanel
// already performs for element value edits (pending overrides disk) so move/remove build off
// the same array a concurrent value edit would.
export interface ArrayEditControls {
  currentArray: (plugin: string) => unknown[];
  index: number;
  onArrayEdit: (plugin: string, value: unknown[]) => void;
}

const arrayCtrlBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', fontSize: '12px', padding: 0, lineHeight: 1,
};

// Swap-based move (matches VmadSection's ArrayElementCell) — no free drag, no auto-sort.
function ArrayElementControls({ plugin, controls }: Readonly<{ plugin: string; controls: ArrayEditControls }>) {
  const { currentArray, index, onArrayEdit } = controls;
  const arr = currentArray(plugin);
  const swap = (j: number) => {
    const next = [...arr];
    [next[index], next[j]] = [next[j], next[index]];
    onArrayEdit(plugin, next);
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <button title="Move up" disabled={index === 0} onClick={() => swap(index - 1)} style={arrayCtrlBtnStyle}>▲</button>
      <button title="Move down" disabled={index === arr.length - 1} onClick={() => swap(index + 1)} style={arrayCtrlBtnStyle}>▼</button>
      <button
        title="Remove element"
        onClick={() => onArrayEdit(plugin, arr.filter((_, j) => j !== index))}
        style={{ ...arrayCtrlBtnStyle, color: 'var(--vscode-errorForeground, #f88)' }}
      >×</button>
    </span>
  );
}

// Issue #142: "＋" control on an unsorted array's parent row — appends a default-valued element
// (RecordPanel supplies the default, derived from the element's own FieldMetadata via
// `defaultElementValue`). Matches VmadSection's `ArrayAddButton`: visible only while the array is
// expanded, occupying the same slot the collapsed "[n]" summary would otherwise show.
function ArrayAddButton({ onClick }: Readonly<{ onClick: () => void }>) {
  return (
    <button title="Add element" onClick={onClick} style={{ ...arrayCtrlBtnStyle, fontSize: '14px' }}>+</button>
  );
}

const ROW_BG: Partial<Record<ConflictAll, string>> = {
  Override:        'rgba(76,175,80,0.20)',
  Conflict:        'rgba(255,152,0,0.20)',
  ConflictCritical: 'rgba(244,67,54,0.20)',
};

const getRowBg = (c: ConflictAll): string | undefined => ROW_BG[c];

// Issue #159: maps a row's context + field name to the sub-path key PendingChangeResolver used
// when building `change.resolutions` (FormRefPathBuilder convention: "" for the change's own
// scalar value, a bare member name for a struct child, "[idx]" for a positional array element,
// "[idx].member" for a grandchild). A positional (non-sortable) array element's `diff.fieldName`
// is already "[idx]" (ConflictClassifier.BuildPositional) — the same format FormRefPathBuilder
// produces — so it's used directly. A sortable (pure FormLink) array is keyed by element value,
// not position (ConflictClassifier.BuildSorted, wbArrayS), which FormRefPathBuilder does not
// know about — its position within the *pending* array (rawPending) is looked up instead.
// Returns undefined when no path can be determined (e.g. a sortable element not present in the
// pending array) — callers treat that the same as "no resolution available".
function pendingResolutionPath(context: RowContext, fieldName: string, rawPending: unknown): string | undefined {
  switch (context.kind) {
    case 'top-level': return '';
    case 'struct-child': return fieldName;
    case 'grandchild': return `[${context.parentFieldIndex}].${fieldName}`;
    case 'array-element': {
      if (!context.overrideMeta.isSortable) return fieldName; // already "[idx]"
      // indexOf takes the first match on a duplicate FormKey value — harmless here since
      // duplicate values in the pending array would carry identical resolutions anyway.
      const idx = Array.isArray(rawPending) ? (rawPending as unknown[]).indexOf(fieldName) : -1;
      return idx >= 0 ? `[${idx}]` : undefined;
    }
  }
}

// ── Cell renderer ─────────────────────────────────────────────────────────────

function renderCell(
  value: unknown,
  meta: FieldMetadata,
  editable: boolean,
  client: RecordSessionClient,
  onOpen: (fk: string) => void,
  onCommit: (v: unknown) => void,
  checkError?: string | null,
  resolution?: FormKeyResolution,
): React.ReactNode {
  if (meta.type === 'formKey') {
    return (
      <FormKeyCell
        value={value} meta={meta} editable={editable} client={client}
        onOpen={onOpen} onCommit={fk => onCommit(fk)} checkError={checkError} resolution={resolution}
      />
    );
  }
  if (meta.type === 'array') {
    return (
      <span style={{ opacity: 0.5 }}>
        {Array.isArray(value) ? `[${(value as unknown[]).length}]` : '[…]'}
      </span>
    );
  }
  // struct fields in the diff table are handled via sub-rows
  if (meta.type === 'struct') {
    return (
      <span style={{ opacity: 0.5, display: 'inline-flex', alignItems: 'center' }}>
        {'{…}'}<CheckErrorIcon checkError={checkError} />
      </span>
    );
  }
  if (meta.type === 'enum' && meta.isBitmask) {
    return <FlagCell value={value} meta={meta} editable={editable} onCommit={onCommit} />;
  }
  return <ScalarCell value={value} meta={meta} editable={editable} onCommit={onCommit} />;
}

export type RowContext =
  | { kind: 'top-level' }
  | { kind: 'array-element'; overrideMeta: FieldMetadata; parentFieldName: string }
  | { kind: 'struct-child';  overrideMeta: FieldMetadata; parentFieldName: string }
  | { kind: 'grandchild';    overrideMeta: FieldMetadata; parentFieldName: string; parentFieldIndex: number };

// A disk column's value cell. Issue #111: drag-to-copy is always on, but a draggable ancestor
// swallows text selection inside an input — the browser starts a drag instead of selecting — so
// the cell stops being draggable exactly while its own input is active.
//
// The cell learns that from focus events bubbling out of its own subtree rather than from the
// leaf renderers reporting it: which control a value renders as is the leaf's business (and
// there are several — text, number, select, checkbox, flag multi-select), while "does this cell
// currently contain an active input" is the cell's own. Watching its subtree keeps that
// knowledge on the right side of the boundary and costs the leaves no prop.
function DiskCell({ style, onDragStart, onDrop, children }: Readonly<{
  style: React.CSSProperties;
  onDragStart: () => void;
  onDrop: () => void;
  children: React.ReactNode;
}>) {
  const [editing, setEditing] = useState(false);
  // A focused FormKey link is not an editor — only a form control suppresses the drag.
  const isFormControl = (t: EventTarget | null) =>
    t instanceof HTMLElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName);

  return (
    <td
      style={{ ...style, cursor: editing ? undefined : 'grab' }}
      draggable={!editing}
      onFocus={e => { if (isFormControl(e.target)) setEditing(true); }}
      onBlur={e => { if (isFormControl(e.target)) setEditing(false); }}
      onDragStart={onDragStart}
      onDragOver={e => e.preventDefault()}
      onDrop={onDrop}
    >
      {children}
    </td>
  );
}

interface DiffRowProps {
  diff: FieldDiff;
  conflictAll: ConflictAll;
  columns: Column[];
  overrideMap: Record<string, CompareOverride>;
  fieldMetaMap: Record<string, FieldMetadata>;
  // Issue #111: the set of plugins whose columns are read-only. Replaces the old `editMode`
  // flag: editability is per-column, so an immutable column never renders an input even
  // though the panel as a whole is always editable.
  immutableSet: Set<string>;
  client: RecordSessionClient;
  pendingChangeMap: Record<string, PendingChange>;
  collapsedColumns: Set<string>;
  onOpen: (fk: string) => void;
  onEdit: (plugin: string, fieldName: string, value: unknown) => void;
  // Issue #203: right-click a pending value → Save Group / Revert Group / Reveal in Pending
  // Changes Tree, all from the shared PendingCellMenu (RecordPanel owns the reveal wiring) —
  // this row only ever needs to open that menu, never call reveal itself.
  onPendingContextMenu: (changeId: string, x: number, y: number) => void;
  onCellDragStart: (fieldName: string, value: unknown, sourcePlugin: string) => void;
  onCellDrop: (fieldName: string, targetPlugin: string, applyValue: (value: unknown) => void) => void;
  context: RowContext;
  hasChildren?: boolean;
  isExpanded?: boolean;
  onToggle?: () => void;
  // Issue #142: present only for an unsorted array-element row (RecordPanel omits it for
  // sortable elements) — renders move-up/move-down/remove on non-immutable disk columns.
  arrayEdit?: ArrayEditControls;
  // Issue #142: present only for an unsorted array's parent (top-level) row — appends a
  // default-valued element to that plugin's array. Absent (not disabled) for sortable arrays,
  // same rule as arrayEdit above.
  onArrayAdd?: (plugin: string) => void;
}

export function DiffRow({
  diff, conflictAll, columns, overrideMap, fieldMetaMap, immutableSet, client,
  pendingChangeMap, collapsedColumns, onOpen, onEdit, onPendingContextMenu,
  onCellDragStart, onCellDrop,
  context, hasChildren, isExpanded, onToggle, arrayEdit, onArrayAdd,
}: DiffRowProps) {
  const meta = context.kind === 'top-level' ? fieldMetaMap[diff.fieldName] : context.overrideMeta;
  if (!meta) return null;

  const pendingLookupField = context.kind === 'top-level' ? diff.fieldName : context.parentFieldName;
  const showActions = context.kind === 'top-level' || context.kind === 'struct-child';

  return (
    <tr style={{ backgroundColor: getRowBg(conflictAll) }}>
      <td style={{ ...baseCell, opacity: 0.75, userSelect: 'text', paddingLeft: context.kind !== 'top-level' ? 24 : undefined }}>
        {hasChildren && (
          <button style={toggleBtnStyle} onClick={onToggle}>{isExpanded ? '▼' : '▶'}</button>
        )}
        {diff.fieldName}
      </td>
      {columns.map(col => {
        if (col.kind === 'disk') {
          const { override: o } = col;
          const cellStyle = { ...baseCell, ...getCellStyle(diff.cellStates?.[o.plugin]), userSelect: 'text' as const };
          if (collapsedColumns.has(o.plugin)) {
            return <td key={`disk:${o.plugin}`} style={cellStyle} />;
          }
          const checkError = showActions
            ? overrideMap[o.plugin]?.fields.find(f => f.metadata.name === pendingLookupField)?.checkError
            : undefined;
          if (hasChildren) {
            const len = meta.type === 'array' && Array.isArray(diff.values[o.plugin])
              ? (diff.values[o.plugin] as unknown[]).length
              : '…';
            const collapsedLabel = meta.type === 'array' ? `[${len}]` : '{…}';
            const showAdd = isExpanded && onArrayAdd && !immutableSet.has(o.plugin);
            // Issue #204 / ADR-0033: a compound (struct/array) field's summary row is a drag
            // source for its whole value, exactly like a scalar leaf — every value-bearing cell,
            // expanded or collapsed, wired uniformly rather than branching on isExpanded.
            return (
              <DiskCell
                key={`disk:${o.plugin}`}
                style={cellStyle}
                onDragStart={() => onCellDragStart(diff.fieldName, diff.values[o.plugin], o.plugin)}
                onDrop={() => onCellDrop(diff.fieldName, o.plugin, v => onEdit(o.plugin, diff.fieldName, v))}
              >
                {!isExpanded && (
                  <span style={{ opacity: 0.5, display: 'inline-flex', alignItems: 'center' }}>
                    {collapsedLabel}<CheckErrorIcon checkError={checkError} />
                  </span>
                )}
                {showAdd && <ArrayAddButton onClick={() => onArrayAdd(o.plugin)} />}
                {arrayEdit && !immutableSet.has(o.plugin) && <ArrayElementControls plugin={o.plugin} controls={arrayEdit} />}
              </DiskCell>
            );
          }
          // Issue #3: a leaf field-value cell can be dragged into another plugin's column to
          // stage its value there as a pending change (source may be a read-only column —
          // dragging is a copy, only the drop target's mutability matters, enforced by
          // onCellDrop). onDrop's applyValue re-uses this row's own onEdit closure, which
          // already carries the right merge semantics for this row's context (top-level/
          // array-element/struct-child/grandchild).
          return (
            <DiskCell
              key={`disk:${o.plugin}`}
              style={cellStyle}
              onDragStart={() => onCellDragStart(diff.fieldName, diff.values[o.plugin], o.plugin)}
              onDrop={() => onCellDrop(diff.fieldName, o.plugin, v => onEdit(o.plugin, diff.fieldName, v))}
            >
              {renderCell(diff.values[o.plugin], meta, !immutableSet.has(o.plugin), client, onOpen,
                v => onEdit(o.plugin, diff.fieldName, v), checkError, diff.resolutions?.[o.plugin])}
              {arrayEdit && !immutableSet.has(o.plugin) && <ArrayElementControls plugin={o.plugin} controls={arrayEdit} />}
            </DiskCell>
          );
        }

        // pending companion column
        const override = overrideMap[col.plugin];
        const rawPending = override?.pendingFields?.[pendingLookupField];
        let pendingValue: unknown;
        switch (context.kind) {
          case 'top-level':
            pendingValue = pendingIfChanged(rawPending, diff.values[col.plugin]);
            break;
          case 'array-element':
            pendingValue = extractPendingElementValue(rawPending, diff.fieldName, context.overrideMeta.isSortable ?? false, diff.values[col.plugin]);
            break;
          case 'struct-child': {
            const sub = (rawPending as Record<string, unknown> | undefined)?.[diff.fieldName];
            pendingValue = pendingIfChanged(sub, diff.values[col.plugin]);
            break;
          }
          case 'grandchild': {
            const elem = Array.isArray(rawPending) ? (rawPending as unknown[])[context.parentFieldIndex] : undefined;
            const sub = (elem as Record<string, unknown> | undefined)?.[diff.fieldName];
            pendingValue = pendingIfChanged(sub, diff.values[col.plugin]);
            break;
          }
        }
        const change = pendingChangeMap[`${col.plugin}:${pendingLookupField}`];
        const hasPending = pendingValue !== undefined;
        const resolutionPath = pendingResolutionPath(context, diff.fieldName, rawPending);
        const pendingResolution = resolutionPath !== undefined ? change?.resolutions?.[resolutionPath] : undefined;
        return (
          <td
            key={`pending:${col.plugin}`}
            // Issue #139: right-click a pending value → group-scoped Save/Revert/Reveal (#203
            // adds Reveal to this menu; ADR-0033 makes right-click the only place Revert Group
            // lives). Gated on showActions — top-level and struct-child rows carry a change id.
            onContextMenu={change && showActions ? e => { e.preventDefault(); onPendingContextMenu(change.id, e.clientX, e.clientY); } : undefined}
            style={{
              ...baseCell,
              backgroundColor: hasPending ? 'rgba(255,200,50,0.10)' : undefined,
              fontStyle: 'italic',
              opacity: hasPending ? 1 : 0.3,
            }}
          >
            {/* Issue #203: a pending value is directly editable, on the same terms as a disk
                cell — same renderCell the disk columns use, same onEdit call shape
                (plugin, diff.fieldName, value). Editable is unconditional here rather than
                re-checking immutableSet: buildColumns (recordUtils.ts) only ever creates a
                'pending' column for a plugin that isn't immutable, so a pending column's own
                plugin is always mutable — plain click now edits instead of revealing (#140's
                reveal moved to the right-click menu above). Issue #159: the FormKey
                resolution comes from the staged change's own `resolutions`, keyed by this
                row's sub-path within the change's NewValue (pendingResolutionPath) — the
                same tri-state signal disk columns use, not a stand-in. */}
            {hasPending && renderCell(pendingValue, meta, true, client, onOpen,
              v => onEdit(col.plugin, diff.fieldName, v), undefined,
              meta.type === 'formKey' ? pendingResolution : undefined)}
          </td>
        );
      })}
    </tr>
  );
}
