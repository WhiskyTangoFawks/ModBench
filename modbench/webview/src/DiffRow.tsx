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
  onRevert: (changeId: string) => void;
  onPendingContextMenu: (changeId: string, x: number, y: number) => void;
  // Issue #140: plain click on a pending value reveals its change in the Pending Changes tree.
  // Free gesture — pending cells are never editable — and kept off Ctrl+click, which still
  // means "follow the reference" uniformly across every cell in the grid.
  onRevealPendingChange: (changeId: string) => void;
  onCellDragStart: (fieldName: string, value: unknown) => void;
  onCellDrop: (fieldName: string, targetPlugin: string, applyValue: (value: unknown) => void) => void;
  context: RowContext;
  hasChildren?: boolean;
  isExpanded?: boolean;
  onToggle?: () => void;
}

export function DiffRow({
  diff, conflictAll, columns, overrideMap, fieldMetaMap, immutableSet, client,
  pendingChangeMap, collapsedColumns, onOpen, onEdit, onRevert, onPendingContextMenu,
  onRevealPendingChange, onCellDragStart, onCellDrop,
  context, hasChildren, isExpanded, onToggle,
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
            return (
              <td key={`disk:${o.plugin}`} style={cellStyle}>
                {isExpanded ? null : (
                  <span style={{ opacity: 0.5, display: 'inline-flex', alignItems: 'center' }}>
                    {collapsedLabel}<CheckErrorIcon checkError={checkError} />
                  </span>
                )}
              </td>
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
              onDragStart={() => onCellDragStart(diff.fieldName, diff.values[o.plugin])}
              onDrop={() => onCellDrop(diff.fieldName, o.plugin, v => onEdit(o.plugin, diff.fieldName, v))}
            >
              {renderCell(diff.values[o.plugin], meta, !immutableSet.has(o.plugin), client, onOpen,
                v => onEdit(o.plugin, diff.fieldName, v), checkError, diff.resolutions?.[o.plugin])}
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
            // Issue #139: right-click a pending value → group-scoped Save/Revert. Gated on the
            // same showActions as the inline ↩ (top-level and struct-child rows carry a change id).
            onContextMenu={change && showActions ? e => { e.preventDefault(); onPendingContextMenu(change.id, e.clientX, e.clientY); } : undefined}
            // Issue #140: plain click reveals the change in the Pending Changes tree. Ctrl/meta-
            // click is left alone so it falls through to the cell's own FormKeyLink, which follows
            // the reference — never both on the same click (the link doesn't stop propagation, so
            // without this guard a Ctrl+click here would fire the reveal too).
            onClick={change && showActions
              ? e => { if (!e.ctrlKey && !e.metaKey) onRevealPendingChange(change.id); }
              : undefined}
            style={{
              ...baseCell,
              backgroundColor: hasPending ? 'rgba(255,200,50,0.10)' : undefined,
              fontStyle: 'italic',
              opacity: hasPending ? 1 : 0.3,
            }}
          >
            {hasPending && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {/* Issue #137: the pending value renders through the same type-aware renderer the
                    disk columns use, in its read-only form (editable=false) — enums/flags resolve
                    to names, FormKeys become links — so the Pending column reads in the same
                    language as the row it is being compared against. Issue #159: the FormKey
                    resolution comes from the staged change's own `resolutions`, keyed by this
                    row's sub-path within the change's NewValue (pendingResolutionPath) — the
                    same tri-state signal disk columns use, not a stand-in. */}
                <span>{renderCell(pendingValue, meta, false, client, onOpen, () => {}, undefined,
                  meta.type === 'formKey' ? pendingResolution : undefined)}</span>
                {change && showActions && (
                  <button
                    // stopPropagation: the ↩ sits inside the cell that plain-click reveals
                    // (#140) — reverting must not also fire a reveal on the same click.
                    onClick={e => { e.stopPropagation(); onRevert(change.id); }}
                    title="Revert group"
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--vscode-errorForeground, #f88)',
                      fontSize: '11px',
                      padding: 0,
                      lineHeight: 1,
                    }}
                  >↩</button>
                )}
              </span>
            )}
          </td>
        );
      })}
    </tr>
  );
}
