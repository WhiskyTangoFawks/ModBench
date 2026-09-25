import React from 'react';
import { FlagCell } from './FlagCell';
import { ScalarCell } from './ScalarCell';
import { FormKeyCell } from './FormKeyCell';
import { CheckErrorIcon } from './CheckErrorIcon';
import { DiskCell } from './DiskCell';
import { displayValue, modelValue } from './modelValue';
import { copyToClipboard } from './nativeBridge';
import { formKeyLabel } from './FormKeyLink';
import { baseCell, toggleBtnStyle, getCellStyle, focusedRowStyle, DIMMED_OPACITY } from './gridStyles';
import {
  arrayElementContext, arrayParentContext, combineVscodeContexts, defaultOf, isArrayElementHop,
  columnHasNode, isMovableElementHop, offersArrayAdd, rootFieldOf, stringValueContext, wirePath,
  type Column, type PathSegment,
} from './recordUtils';
import type { ColumnKey, ConflictAll, FieldDiff, FieldMetadata, FormKeyResolution } from './types';


// NoConflict and OnlyOne are deliberately absent: they paint no background, so an expanded row
// deferring to its children (`undefined` below) reads the same way they do.
const ROW_BG: Partial<Record<ConflictAll, string>> = {
  Override:        'rgba(76,175,80,0.20)',
  Conflict:        'rgba(255,152,0,0.20)',
  ConflictCritical: 'rgba(244,67,54,0.20)',
};

interface RenderCellExtras {
  checkError?: string | null;
  resolution?: FormKeyResolution;
  // Where an edited value goes. Absent means this cell has nowhere to write — an immutable
  // or untracked column, or a caller outside the field grid — and the leaf renders read-only.
  onCommit?: (v: unknown) => void;
  // The row's own collapse state, threaded to the one leaf that renders differently for it
  // (FlagCell's compact summary) — a row collapses as a row, all columns together.
  rowCollapsed?: boolean;
}

// ADR-0007: leaves render read-only unless the caller supplies `onCommit` — the presence of
// somewhere to write *is* the editability signal, so a call site that has no write path cannot
// accidentally ask for an editor.
function renderCell(
  value: unknown,
  meta: FieldMetadata,
  isFocused: boolean,
  onOpen: (fk: string) => void,
  { checkError, resolution, onCommit, rowCollapsed }: RenderCellExtras = {},
): React.ReactNode {
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
  if (meta.type === 'flags') {
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
      // A FormKey typed as text, as the record's own FormID is, reads as the record it names.
      displayOverride={resolution && typeof value === 'string' ? formKeyLabel(value, resolution) : undefined}
    />
  );
}

// A row's coordinates at arbitrary nesting depth — a script property's own struct data needs more
// than any fixed set of levels. `rootField` is the record's own member; `path` the row's hops
// below it.
export interface RowContext {
  path: PathSegment[];
  rootField: string;
  // True ancestor-hop count, tracked independently of `path` so indentation stays a property of
  // where a row sits in the tree rather than of how far into a value it addresses.
  depth: number;
}

// ADR-0018: identifies one cell panel-wide, so one cell is focused at a time. ADR-0012: `plugin`
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

/** Every array gesture a row can offer. Which of them *this* row offers is the row's own
 *  question, answered once from its metadata and its last path hop. */
export type ArrayOp = 'add' | 'remove' | 'moveUp' | 'moveDown';

interface DiffRowProps {
  diff: FieldDiff;
  // This row's own schema leaf. The panel resolves it at every depth, so the row never looks one
  // up and can never render against a shape the panel did not choose.
  meta: FieldMetadata;
  columns: Column[];
  // ADR-0013/ADR-0012: the columns that render at reduced weight, as one set the panel computes,
  // so the header and every cell under it can never disagree.
  dimmedColumns: Set<ColumnKey>;
  collapsedColumns: Set<ColumnKey>;
  onOpen: (fk: string) => void;
  // "EditorID [FormKey]", the composite the panel's own title uses — the extended editor's temp
  // file is filed under it, and only the panel knows it.
  recordLabel: string;
  context: RowContext;
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
  // Takes the leaf value alone — the row builder owns the path the envelope carries.
  onEditCell?: (plugin: ColumnKey, value: unknown) => void;
  // Every array gesture, through one callback: the panel offers it to every row and this row
  // decides which ops it has, so availability is stated once rather than agreed on twice.
  onArrayOp?: (plugin: ColumnKey, op: ArrayOp) => void;
  // What each column's cell reads while this row is collapsed, when the presentation table has an
  // entry for this row's own schema leaf — a condition reads as its xEdit prose rather than "{…}".
  collapsedSummary?: Record<string, string>;
  // Whether this column holds the object this row is a member of. A member of nothing reads as
  // nothing; a member its owner omits reads as its default (ADR-0005). Absent means every owner is
  // present.
  ownerPresent?: (column: ColumnKey) => boolean;
  // Per column, the shape of a member whose type varies by the owner's leaf: the variant that
  // column's own leaf names. Absent where the member has one shape.
  cellMetas?: Partial<Record<string, FieldMetadata>>;
}

export function DiffRow({
  diff, meta, columns, dimmedColumns,
  collapsedColumns, onOpen,
  recordLabel, context, isExpanded, onToggle,
  rowKey, focusedCell, onFocusCell, editableColumns, onEditCell,
  onArrayOp, collapsedSummary, ownerPresent, cellMetas,
}: Readonly<DiffRowProps>) {
  // The children the diff node itself carries — the row and the panel can never disagree about
  // whether this node has any.
  const hasChildren = (diff.children?.length ?? 0) > 0;

  // Every row in
  // one subtree (root, struct-child, array-element, and any deeper hop) shares the
  // same wire path/overlay-fields key, so RecordPanel hands it down unchanged at every depth rather
  // than DiffRow re-deriving "top-level or not."
  const rootField = context.rootField;
  // What the label column shows for this row, reused as the extended-editor tab's own title.
  const label = meta.displayLabel ?? diff.fieldName;
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
  const rowBg = hasChildren && isExpanded ? undefined : ROW_BG[diff.conflictAll];

  // A flags row is collapsible like a struct row, though its "children" are the checkbox lines
  // inside the cell, not sub-rows. It starts collapsed, sharing struct rows' default exactly.
  const isFlagsRow = meta.type === 'flags';
  const rowExpanded = !!isExpanded;
  // A row no column carries a value for holds nothing but its children, so it is present in every
  // column — nothing there is absent relative to anything, and `hasElement` below stays true
  // throughout.
  const rowIsStructural = Object.values(diff.values).every(v => v == null);

  return (
    <tr style={{ backgroundColor: rowBg, ...(isRowFocused ? focusedRowStyle : undefined) }}>
      {/* ADR-0018: double-clicking the label column expands/collapses the node, the same action
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
            one (a union's MutagenObjectType is "Kind"). */}
        {label}
      </td>
      {columns.map(col => {
        const { key, override } = col;
        // ADR-0018: no `userSelect: 'text'` — the cell is `draggable` at rest and `draggable`
        // consumes the mousedown that would start a selection, so adding it would tell the next
        // reader selection works here.

        // ADR-0012: every per-column lookup below is keyed by `key` (this column's ColumnKey),
        // matching how the backend keys its own dictionaries — `[o.plugin]` would be wrong the
        // moment a non-Data-origin column exists.

        const cellStyle = {
          ...baseCell, ...getCellStyle(diff.cellStates[key]),
          opacity: dimmedColumns.has(key) ? DIMMED_OPACITY : undefined,
        };
        if (collapsedColumns.has(key)) {
          return <td key={key} style={cellStyle} />;
        }
        const rootValue = rootFieldOf(override, rootField);
        // The wire carries one per column at every depth, so this row's error is its own node's.
        const checkError = diff.checkErrors?.[key];
        const isFocused = isCellFocused(focusedCell, rowKey, key);
        const cellMeta = cellMetas?.[key] ?? meta;
        // Whether this column has something on this row: this row's own node, and the object it
        // is a member of. A leaf its owner omits is the default, so it is there.
        const hasElement = rowIsStructural
          || ((ownerPresent?.(key) ?? true) && columnHasNode(cellMeta, diff.values[key]));
        const shown = hasElement ? diff.values[key] ?? defaultOf(cellMeta) : undefined;
        // ADR-0018: the string Ctrl+C copies for this cell, computed once so the
        // struct/array-summary branch and the leaf branch below hand DiskCell the same value.
        const copyText = displayValue(shown, cellMeta, diff.resolutions?.[key]);
        // Array ops are offered only on a writable column.
        const arrayEditable = !!onArrayOp && editableColumns.has(key) && (isArrayParentRow || isArrayElementRow);
        // ADR-0018: a `string` cell always carries its own right-click context, mutable or
        // immutable alike — a read-only tab is still the only way to read a long immutable
        // value in full.
        const offersMenu = arrayEditable || meta.type === 'string';
        const arrayOps = arrayEditable ? {
          add: isArrayParentRow ? () => onArrayOp(key, 'add') : undefined,
          remove: isArrayElementRow ? () => onArrayOp(key, 'remove') : undefined,
          moveUp: isMovableElementRow ? () => onArrayOp(key, 'moveUp') : undefined,
          moveDown: isMovableElementRow ? () => onArrayOp(key, 'moveDown') : undefined,
        } : undefined;
        // Hoisted above vscodeContext because stringValueContext needs it too — a string cell's
        // own `readOnly` is this same boolean negated, so the right-click menu and the
        // inline-editor gate can never disagree.
        const cellEditable = !!onEditCell && editableColumns.has(key) && !meta.readOnly;
        // The host that invokes these commands holds no document, so it is handed the envelope's
        // own path, resolved here against this column's own value of the root.
        const hops = offersMenu ? wirePath(rootField, context.path, rootValue?.value) : [];
        const vscodeContext = offersMenu ? combineVscodeContexts(
          // `hops` addresses the array itself here — this row *is* the array.
          isArrayParentRow
            ? arrayParentContext(col.override.formKey, col.override.plugin, col.override.origin, hops)
            : undefined,
          // `hops` ends in the `index`/`key` hop that gates isArrayElementRow, and carries every
          // hop above it rather than just that one.
          isArrayElementRow
            ? arrayElementContext(col.override.formKey, col.override.plugin, col.override.origin, hops)
            : undefined,
          meta.type === 'string'
            ? stringValueContext(
                col.override.formKey, col.override.plugin, col.override.origin, recordLabel, label,
                modelValue(diff.values[key], meta), !cellEditable, hops,
              )
            : undefined,
        ) : undefined;
        if (hasChildren) {
          const len = meta.type === 'array' && Array.isArray(shown) ? shown.length : '…';
          // A summary is content, not a placeholder — it reads at full weight, where "[3]"/"{…}"
          // stay dimmed to say only that something unexpanded is there.
          const summary = collapsedSummary?.[key];
          const collapsedLabel = summary ?? (meta.type === 'array' ? `[${len}]` : '{…}');
          return (
            <DiskCell
              key={key}
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
            key={key}
            style={cellStyle}
            isFocused={isFocused}
            onFocusCell={() => onFocusCell(rowKey, key)}
            onCopy={() => copyToClipboard(copyText)}
          >
            {/* "[3]"/"{…}" say a container is present and merely unexpanded, and a leaf reads its
                default, so nothing at all stands in for a column that has no such thing. */}
            {hasElement && renderCell(shown, cellMeta, isFocused, onOpen, {
              checkError, resolution: diff.resolutions?.[key],
              onCommit: cellEditable ? (v: unknown) => onEditCell(key, v) : undefined,
              rowCollapsed: isFlagsRow && !rowExpanded,
            })}
          </DiskCell>
        );
      })}
    </tr>
  );
}
