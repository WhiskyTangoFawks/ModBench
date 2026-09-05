import React from 'react';
import { FlagCell } from './FlagCell';
import { ScalarCell } from './ScalarCell';
import { FormKeyCell } from './FormKeyCell';
import { CheckErrorIcon } from './CheckErrorIcon';
import { DiskCell } from './DiskCell';
import { displayValue, flagBits, modelValue } from './modelValue';
import { copyToClipboard } from './nativeBridge';
import { baseCell, toggleBtnStyle, getCellStyle, focusedRowStyle, DIMMED_OPACITY } from './gridStyles';
import {
  arrayElementContext, arrayParentContext, combineVscodeContexts, isArrayElementHop,
  isMovableElementHop, offersArrayAdd, stringValueContext, type Column, type PathSegment,
} from './recordUtils';
import type { ColumnKey, CompareOverride, ConflictAll, FieldDiff, FieldMetadata, FormKeyResolution } from './types';


const ROW_BG: Partial<Record<ConflictAll, string>> = {
  Override:        'rgba(76,175,80,0.20)',
  Conflict:        'rgba(255,152,0,0.20)',
  ConflictCritical: 'rgba(244,67,54,0.20)',
};

// Undefined (an adapter that hasn't populated FieldDiff.conflictAll yet) degrades to
// "no background" rather than throwing — the same safe default a genuinely NoConflict/OnlyOne
// node already gets, since ROW_BG has no entry for either.
const getRowBg = (c: ConflictAll | undefined): string | undefined => (c ? ROW_BG[c] : undefined);

interface RenderCellExtras {
  checkError?: string | null;
  resolution?: FormKeyResolution;
  // Where an edited value goes. Absent means this cell has nowhere to write — an immutable
  // or untracked column, or a caller outside the field grid — and the leaf renders read-only.
  onCommit?: (v: unknown) => void;
  // The row's own collapse state, threaded to the one leaf that renders differently for it
  // (FlagCell's compact summary) — a row collapses as a row, all columns together.
  rowCollapsed?: boolean;
  // This column's plugin has no element on this row at all (DiffRow's own `hasElement`). Only the
  // two container branches consult it — a scalar leaf already renders its own null as "—".
  absent?: boolean;
}

// ADR-0041: leaves render read-only unless the caller supplies `onCommit` — the presence of
// somewhere to write *is* the editability signal, so a call site that has no write path cannot
// accidentally ask for an editor.
function renderCell(
  value: unknown,
  meta: FieldMetadata,
  isFocused: boolean,
  onOpen: (fk: string) => void,
  { checkError, resolution, onCommit, rowCollapsed, absent }: RenderCellExtras = {},
): React.ReactNode {
  // "[3]"/"{…}" say a container is present and merely unexpanded, so nothing stands in for a
  // container this column's plugin doesn't have. Containers only: an absent scalar keeps
  // ScalarCell's own "—".
  if (absent && (meta.type === 'array' || meta.type === 'struct')) return null;
  if (meta.type === 'formKey') {
    return (
      <FormKeyCell
        value={value} meta={meta} isFocused={isFocused}
        onOpen={onOpen} checkError={checkError} resolution={resolution}
        // Same editability rule as the flags/scalar branches — presence of somewhere to
        // write, ORed with the per-row readOnly veto.
        editable={onCommit != null && !meta.readOnly}
        onCommit={onCommit}
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
  if (meta.type === 'enum' && flagBits(meta) != null) {
    return (
      <FlagCell
        value={value}
        meta={meta}
        // Same rule as ScalarCell's editable computation just below: presence of somewhere to
        // write is the editability signal, ORed with the per-row readOnly veto.
        editable={onCommit != null && !meta.readOnly}
        onCommit={onCommit}
        collapsed={rowCollapsed}
      />
    );
  }
  return (
    <ScalarCell
      value={value}
      meta={meta}
      isFocused={isFocused}
      // `meta.readOnly` is a per-row veto a synthesized row can set regardless of what the
      // column allows — ORed with "the caller gave us nowhere to write", so both have to say yes.
      editable={onCommit != null && !meta.readOnly}
      onCommit={onCommit}
    />
  );
}

// A row's coordinates at arbitrary nesting depth — a script property's own struct data needs more
// than any fixed set of levels. `rootField` is the wire path staged as one atomic change for every
// row in this subtree.
export interface RowContext {
  path: PathSegment[];
  overrideMeta?: FieldMetadata;
  rootField: string;
  // True ancestor-hop count, tracked independently of `path` so indentation stays a property of
  // where a row sits in the tree rather than of how far into a value it addresses.
  depth: number;
}

// ADR-0034: identifies one cell panel-wide, so one cell is focused at a time. ADR-0036: `plugin`
// is this column's compound identity, not the bare filename — two columns sharing a filename must
// not both read as focused.
export interface FocusedCell {
  rowKey: string;
  plugin: ColumnKey;
}

function isCellFocused(focusedCell: FocusedCell | null, rowKey: string, plugin: ColumnKey): boolean {
  return focusedCell?.rowKey === rowKey && focusedCell.plugin === plugin;
}

// One step of label indentation per ancestor hop, so a row's indent reads as its real depth.
const INDENT_PER_LEVEL = 24;

interface DiffRowProps {
  diff: FieldDiff;
  columns: Column[];
  // ADR-0036: keyed by ColumnKey, though a mapped type erases the brand — the protection is every
  // builder using columnKey(), not this declared type.
  overrideMap: Record<string, CompareOverride>;
  fieldMetaMap: Record<string, FieldMetadata>;
  // ADR-0035: a column for a copy the load order does not name. Dims every cell in the column so
  // the cue survives scrolling past the header (the grid's <thead> isn't sticky).
  notInLoadOrderSet: Set<ColumnKey>;
  collapsedColumns: Set<ColumnKey>;
  onOpen: (fk: string) => void;
  context: RowContext;
  hasChildren?: boolean;
  isExpanded?: boolean;
  onToggle?: () => void;
  // onFocusCell takes rowKey explicitly rather than closing over it here, so RecordPanel stays
  // the one place that knows how a click turns into a FocusedCell.
  rowKey: string;
  focusedCell: FocusedCell | null;
  onFocusCell: (rowKey: string, plugin: ColumnKey) => void;
  // The columns whose cells can be written — mutable plugin, in the load order, tracked. Computed
  // once for the whole grid so one definition of "writable" reaches every row.
  editableColumns: Set<ColumnKey>;
  // Takes the leaf value alone — no field path. A caller-supplied path invites pairing the
  // subtree's root wire path with one leaf's value, so the backend applier declines the shape
  // without saying so and the edit vanishes.
  onEditCell?: (plugin: ColumnKey, value: unknown) => void;
  // Add on this row — present only when this row is itself a mutable, unsorted array's own row.
  onArrayAdd?: (plugin: ColumnKey) => void;
  // Remove/Move Up/Move Down — present only when this row is itself a mutable, unsorted array's
  // element row.
  onArrayRemove?: (plugin: ColumnKey) => void;
  onArrayMoveUp?: (plugin: ColumnKey) => void;
  onArrayMoveDown?: (plugin: ColumnKey) => void;
  // What each column's cell reads while this row is collapsed, when the presentation table has an
  // entry for this row's own schema leaf — a condition reads as its xEdit prose rather than "{…}".
  collapsedSummary?: Record<string, string>;
}

export function DiffRow({
  diff, columns, overrideMap, fieldMetaMap, notInLoadOrderSet,
  collapsedColumns, onOpen,
  context, hasChildren, isExpanded, onToggle,
  rowKey, focusedCell, onFocusCell, editableColumns, onEditCell,
  onArrayAdd, onArrayRemove, onArrayMoveUp, onArrayMoveDown, collapsedSummary,
}: Readonly<DiffRowProps>) {
  // RecordPanel resolves every row's metadata itself; `fieldMetaMap` is the fallback for a caller
  // that supplies no `overrideMeta`.
  const meta = context.overrideMeta ?? fieldMetaMap[diff.fieldName];
  if (!meta) return null;

  // Every row in
  // one subtree (root, struct-child, array-element, and any deeper hop) shares the
  // same wire path/overlay-fields key, so RecordPanel hands it down unchanged at every depth rather
  // than DiffRow re-deriving "top-level or not."
  const rootField = context.rootField;
  // showActions (the checkError icon): every hop on this row's path is a struct member
  // (path.length === 0 is vacuously true; a single array-index or sortKey hop, or
  // one anywhere in a longer chain, turns it off).
  const showActions = context.path.every(seg => seg.kind === 'member');
  // Which array gestures this row offers — its own array's row (Add) or one of its element rows
  // (Remove, and Move where the element's position is the user's to choose).
  const isArrayParentRow = offersArrayAdd(meta);
  const lastPathSegment = context.path[context.path.length - 1];
  const isArrayElementRow = isArrayElementHop(lastPathSegment);
  const isMovableElementRow = isMovableElementHop(lastPathSegment);
  const isRowFocused = focusedCell?.rowKey === rowKey;
  // This row paints its own node's conflict state, not a record-wide value. An expanded row with
  // children defers to its children's tints — painting both would duplicate the signal — and
  // shows the subtree's aggregate only while collapsed.
  const rowConflictAll = hasChildren && isExpanded ? undefined : diff.conflictAll;

  // A flags row is collapsible like a struct row, though its
  // "children" are the checkbox lines inside the cell, not sub-rows. It starts collapsed, sharing
  // struct rows' default exactly.
  const isFlagsRow = meta.type === 'enum' && flagBits(meta) != null;
  const rowExpanded = !!isExpanded;
  // A row no column carries a value for holds nothing but its children, so it is present in every
  // column — nothing there is absent relative to anything, and `hasElement` below stays true
  // throughout.
  const rowIsStructural = Object.values(diff.values).every(v => v == null);

  return (
    <tr style={{ backgroundColor: getRowBg(rowConflictAll), ...(isRowFocused ? focusedRowStyle : undefined) }}>
      {/* ADR-0034: double-clicking the label column expands/collapses the node, the same action
          the toggle button performs. For a row with no children the flip lands in
          expandedStructs, an entry nothing reads. */}
      <td
        style={{ ...baseCell, opacity: 0.75, userSelect: 'text', paddingLeft: context.depth * INDENT_PER_LEVEL || undefined }}
        onDoubleClick={onToggle}
      >
        {(hasChildren || isFlagsRow) && (
          <button style={toggleBtnStyle} onClick={onToggle}>{rowExpanded ? '▼' : '▶'}</button>
        )}
        {/* The schema's own label when the field's name is a wire name rather than a readable
            one (an abstract union's `concrete_type` is "Kind"). */}
        {meta.displayLabel ?? diff.fieldName}
      </td>
      {columns.map(col => {
        if (col.kind === 'disk') {
          const { key, override } = col;
          // ADR-0034: no `userSelect: 'text'` — the cell is `draggable` at rest and `draggable`
          // consumes the mousedown that would start a selection, so adding it would tell the next
          // reader selection works here.

          // ADR-0036: every per-column lookup below is keyed by `key` (this column's ColumnKey),
          // matching how the backend keys its own dictionaries — `[o.plugin]` would be wrong the
          // moment a non-Data-origin column exists.

          // A Partial Form column dims the same way a not-in-load-order one does — read straight
          // off the column's own override, not a separately-threaded Set.
          const cellStyle = {
            ...baseCell, ...getCellStyle(diff.cellStates?.[key]),
            opacity: notInLoadOrderSet.has(key) || override.isPartialForm ? DIMMED_OPACITY : undefined,
          };
          if (collapsedColumns.has(key)) {
            return <td key={`disk:${key}`} style={cellStyle} />;
          }
          const checkError = showActions
            ? overrideMap[key]?.fields.find(f => f.metadata.name === rootField)?.checkError
            : undefined;
          const isFocused = isCellFocused(focusedCell, rowKey, key);
          // ADR-0034: the string Ctrl+C copies for this cell, computed once so the
          // struct/array-summary branch and the leaf branch below hand DiskCell the same value.
          const copyText = displayValue(diff.values[key], meta, diff.resolutions?.[key]);
          // Whether this column's plugin has an element on this row at all: an array slot within
          // its own length, a union member its own concrete leaf declares, a struct it carries.
          const hasElement = rowIsStructural || diff.values[key] != null;
          // Array ops are offered only on a writable column. `arrayLength` is deliberately not
          // threaded down, so canMoveDown reads permissive rather than gating on this plugin's own
          // length; the underlying op still no-ops at the true boundary.
          const arrayEditable = !!onEditCell && editableColumns.has(key) && (isArrayParentRow || isArrayElementRow);
          const arrayOps = arrayEditable ? {
            add: isArrayParentRow ? () => onArrayAdd?.(key) : undefined,
            remove: isArrayElementRow ? () => onArrayRemove?.(key) : undefined,
            moveUp: isMovableElementRow ? () => onArrayMoveUp?.(key) : undefined,
            moveDown: isMovableElementRow ? () => onArrayMoveDown?.(key) : undefined,
          } : undefined;
          // Hoisted above vscodeContext because stringValueContext needs it too — a string cell's
          // own `readOnly` is this same boolean negated, so the right-click menu and the
          // inline-editor gate can never disagree.
          const cellEditable = !!onEditCell && editableColumns.has(key) && !meta.readOnly;
          // ADR-0039: a `string` cell always carries its own right-click context, mutable or
          // immutable alike — a read-only tab is still the only way to read a long immutable
          // value in full.
          const vscodeContext = (arrayEditable || meta.type === 'string') ? combineVscodeContexts(
            // `context.path` addresses the array itself here (this row *is* the array) —
            // `[]` for a top-level array.
            isArrayParentRow
              ? arrayParentContext(col.override.formKey, col.override.plugin, col.override.origin, rootField, context.path)
              : undefined,
            // `context.path` addresses this row's own element (ends in the `index`/`key` hop that
            // gates isArrayElementRow) — every hop from `rootField`, not just the trailing one.
            isArrayElementRow
              ? arrayElementContext(
                  col.override.formKey, col.override.plugin, col.override.origin, rootField,
                  context.path, Number.MAX_SAFE_INTEGER,
                )
              : undefined,
            meta.type === 'string'
              ? stringValueContext(
                  col.override.formKey, col.override.plugin, col.override.origin, rootField,
                  modelValue(diff.values[key], meta), !cellEditable, context.path, rootField,
                )
              : undefined,
          ) : undefined;
          if (hasChildren) {
            const len = meta.type === 'array' && Array.isArray(diff.values[key])
              ? (diff.values[key] as unknown[]).length
              : '…';
            // A summary is content, not a placeholder — it reads at full weight, where "[3]"/"{…}"
            // stay dimmed to say only that something unexpanded is there.
            const summary = collapsedSummary?.[key];
            const collapsedLabel = summary ?? (meta.type === 'array' ? `[${len}]` : '{…}');
            return (
              <DiskCell
                key={`disk:${key}`}
                style={cellStyle}
                isFocused={isFocused}
                onFocusCell={() => onFocusCell(rowKey, key)}
                onCopy={() => copyToClipboard(copyText)}
                arrayOps={arrayOps}
                vscodeContext={vscodeContext}
              >
                {!isExpanded && hasElement && (
                  <span style={{ opacity: summary ? undefined : 0.5, display: 'inline-flex', alignItems: 'center' }}>
                    {collapsedLabel}<CheckErrorIcon checkError={checkError} />
                  </span>
                )}
              </DiskCell>
            );
          }
          return (
            <DiskCell
              arrayOps={arrayOps}
              vscodeContext={vscodeContext}
              key={`disk:${key}`}
              style={cellStyle}
              isFocused={isFocused}
              onFocusCell={() => onFocusCell(rowKey, key)}
              onCopy={() => copyToClipboard(copyText)}
            >
              {renderCell(diff.values[key], meta, isFocused, onOpen, {
                checkError, resolution: diff.resolutions?.[key],
                onCommit: cellEditable ? (v: unknown) => onEditCell(key, v) : undefined,
                rowCollapsed: isFlagsRow && !rowExpanded,
                absent: !hasElement,
              })}
            </DiskCell>
          );
        }
        return null;
      })}
    </tr>
  );
}
