import React from 'react';
import { FlagCell } from './FlagCell';
import { ScalarCell } from './ScalarCell';
import { FormKeyCell } from './FormKeyCell';
import { CheckErrorIcon } from './CheckErrorIcon';
import { DiskCell, type CellKeys } from './DiskCell';
import { copiedText, modelValue, pastedValue } from './modelValue';
import { WrittenValue } from './WrittenValue';
import type { WriteAt } from './unconfirmedWrites';
import { ExpandArrow } from './ExpandArrow';
import {
  baseCell, labelCell, getCellStyle, focusedRowStyle, conflictStateName, rowBackground,
} from './gridStyles';
import {
  arrayElementContext, arrayParentContext, referenceContext, defaultOf, getAtPath, isArrayElementHop,
  columnHasNode, offersArrayAdd, rootFieldOf, stringValueContext, wirePath,
  type Column, type PathSegment,
} from './recordUtils';
import type { ColumnKey, ConflictThis, FieldDiff, FieldMetadata, FormKeyResolution } from './types';
import { LABEL_COLUMN } from './columnKey';
import type { ArrayElementContext, ArrayParentContext, ElementCommand } from './messages';
import type { CellDrag } from './cellDrag';

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
  { checkError, resolution, onCommit, rowCollapsed }: RenderCellExtras = {},
): React.ReactNode {
  if (meta.type === 'formKey') {
    return (
      <FormKeyCell
        value={value} meta={meta}
        checkError={checkError} resolution={resolution}
        editable={onCommit != null}
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
        editable={onCommit != null}
        onCommit={onCommit}
        collapsed={rowCollapsed}
      />
    );
  }
  return (
    <ScalarCell
      value={value}
      meta={meta}
      editable={onCommit != null}
      onCommit={onCommit}
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

// ADR-0018: identifies the one focused cell panel-wide. ADR-0012: `plugin` is the column's
// compound identity, so two columns sharing a filename never both read as focused. `null` is the
// label column.
export interface FocusedCell {
  rowKey: string;
  plugin: ColumnKey | null;
}

function masterOrOnlyOne(
  value: unknown, key: ColumnKey, columns: readonly Column[],
): ConflictThis | undefined {
  if (value == null || columns[0]?.key !== key) return undefined;
  return columns.length === 1 ? 'OnlyOne' : 'Master';
}

function isCellFocused(focusedCell: FocusedCell | null, rowKey: string, plugin: ColumnKey | null): boolean {
  return focusedCell?.rowKey === rowKey && focusedCell.plugin === plugin;
}

// One step of label indentation per ancestor hop, so a row's indent reads as its real depth.
const INDENT_PER_LEVEL = 24;

const arrayLength = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

interface DiffRowProps {
  diff: FieldDiff;
  // This row's own schema leaf. The panel resolves it at every depth, so the row never looks one
  // up and can never render against a shape the panel did not choose.
  meta: FieldMetadata;
  columns: Column[];
  // Each column's look, as the panel gives its header too, so the header and every cell under it
  // can never disagree.
  columnStyle: (column: ColumnKey | typeof LABEL_COLUMN) => React.CSSProperties;
  collapsedColumns: Set<ColumnKey>;
  // "EditorID [FormKey]", the composite the panel's own title uses — the extended editor's temp
  // file is filed under it, and only the panel knows it.
  recordLabel: string;
  context: RowContext;
  isExpanded?: boolean;
  onToggle?: () => void;
  // onFocusCell takes rowKey explicitly rather than closing over it here, so RecordPanel stays
  // the one place that knows how a click turns into a FocusedCell.
  rowKey: string;
  // The row of the array this row is an element of, which an element dragged from here is added to.
  parentRowKey: string | null;
  focusedCell: FocusedCell | null;
  onFocusCell: (rowKey: string, plugin: ColumnKey | null) => void;
  // The columns whose cells can be written — mutable plugin, in the load order, tracked. Computed
  // once for the whole grid so one definition of "writable" reaches every row.
  editableColumns: Set<ColumnKey>;
  // Takes the leaf value alone — the row builder owns the path the envelope carries.
  onEditCell?: (plugin: ColumnKey, value: unknown) => void;
  writeAt: WriteAt;
  onElementCommand?: (
    command: ElementCommand, context: ArrayElementContext | ArrayParentContext, value?: unknown,
  ) => void;
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
  diff, meta, columns, columnStyle,
  collapsedColumns,
  recordLabel, context, isExpanded, onToggle,
  rowKey, parentRowKey, focusedCell, onFocusCell, editableColumns, onEditCell, writeAt,
  onElementCommand, collapsedSummary, ownerPresent, cellMetas,
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
  // (Remove and Move).
  const isArrayParentRow = offersArrayAdd(meta);
  const lastPathSegment = context.path[context.path.length - 1];
  const isArrayElementRow = isArrayElementHop(lastPathSegment);
  const isRowFocused = focusedCell?.rowKey === rowKey;
  // This row paints its own node's conflict state, not a record-wide value. An expanded row with
  // children defers to its children's tints — painting both would duplicate the signal — and
  // shows the subtree's aggregate only while collapsed.
  const rowBg = hasChildren && isExpanded ? undefined : rowBackground(diff.conflictAll);

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
      <DiskCell
        style={{ ...labelCell(columnStyle(LABEL_COLUMN)), paddingLeft: context.depth * INDENT_PER_LEVEL || undefined }}
        isFocused={isCellFocused(focusedCell, rowKey, null)}
        onFocusCell={() => onFocusCell(rowKey, null)}
        onDoubleClick={onToggle}
        copyText={label}
      >
        {(hasChildren || isFlagsRow) && (
          <ExpandArrow expanded={rowExpanded} onToggle={onToggle} />
        )}
        {/* The schema's own label when the field's name is a wire name rather than a readable
            one (a union's MutagenObjectType is "Kind"). */}
        {label}
      </DiskCell>
      {columns.map(col => {
        const { key, override } = col;
        // ADR-0018: no `userSelect: 'text'` — the cell is `draggable` at rest and `draggable`
        // consumes the mousedown that would start a selection, so adding it would tell the next
        // reader selection works here.

        // ADR-0012: every per-column lookup below is keyed by `key` (this column's ColumnKey),
        // matching how the backend keys its own dictionaries — `[o.plugin]` would be wrong the
        // moment a non-Data-origin column exists.

        // mEdit sends no state for the master's own cell, nor for any cell of a lone copy.
        const cellState = diff.cellStates[key] ?? masterOrOnlyOne(diff.values[key], key, columns);
        const cellStyle = {
          ...baseCell, ...getCellStyle(cellState), ...columnStyle(key),
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
        const copyText = copiedText(shown, cellMeta, diff.resolutions?.[key]);
        const cellTitle = [cellState && conflictStateName(cellState), cellMeta.readOnlyReason]
          .filter(Boolean).join('\n') || undefined;
        // The host that invokes these commands holds no document, so it is handed the envelope's
        // own path, as this column addresses it.
        const hops = wirePath(rootField, context.path, key);
        // Under an element this column does not hold, there is nothing to write to.
        const writable = editableColumns.has(key) && cellMeta.readOnlyReason == null && hops !== undefined;
        // Array ops are offered only on a writable cell.
        const arrayEditable = !!onElementCommand && writable && (isArrayParentRow || isArrayElementRow);
        // A string cell's right-click `readOnly` is this boolean negated, so the menu and the
        // inline-editor gate can never disagree.
        const cellEditable = !!onEditCell && writable;
        // `hops` ends in the element's own `index` hop, and carries every hop above it rather than
        // just that one.
        const elementContext = hops && arrayEditable && isArrayElementRow
          ? arrayElementContext(
              col.override.formKey, col.override.plugin, col.override.origin, hops,
              arrayLength(getAtPath(rootValue?.value, hops.slice(1, -1))),
              lastPathSegment?.kind === 'element' && lastPathSegment.keyed)
          : undefined;
        const fire = (command: ElementCommand, allowed = true) =>
          allowed && elementContext && onElementCommand ? () => onElementCommand(command, elementContext) : undefined;
        const keys: CellKeys = {
          remove: fire('removeElement'),
          moveUp: fire('moveElementUp', elementContext?.canMoveUp),
          moveDown: fire('moveElementDown', elementContext?.canMoveDown),
          clear: cellEditable && diff.values[key] != null ? () => onEditCell(key, null) : undefined,
          paste: cellEditable ? text => onEditCell(key, pastedValue(text, cellMeta, shown)) : undefined,
        };
        // `hops` addresses the array itself here — this row *is* the array.
        const parentContext = hops && arrayEditable && isArrayParentRow
          ? arrayParentContext(col.override.formKey, col.override.plugin, col.override.origin, hops)
          : undefined;
        const drag: CellDrag | undefined = diff.values[key] != null
          ? { row: rowKey, arrayRow: isArrayElementRow ? parentRowKey : null, value: diff.values[key] }
          : undefined;
        const landing = (dragged: CellDrag): (() => void) | undefined => {
          if (dragged.row === rowKey) {
            return cellEditable && JSON.stringify(dragged.value) !== JSON.stringify(shown)
              ? () => onEditCell(key, dragged.value)
              : undefined;
          }
          return parentContext && dragged.arrayRow === rowKey
            ? () => onElementCommand?.('addElement', parentContext, dragged.value)
            : undefined;
        };
        const resolution = diff.resolutions?.[key];
        const contexts = [
          parentContext,
          elementContext,
          hops && meta.type === 'string'
            ? stringValueContext(
                col.override.formKey, col.override.plugin, col.override.origin, recordLabel, label,
                modelValue(diff.values[key], meta), !cellEditable, hops,
              )
            : undefined,
          typeof shown === 'string' && cellMeta.type === 'formKey' && resolution && resolution.state !== 'Unresolved'
            ? referenceContext(shown)
            : undefined,
        ];
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
              title={cellTitle}
              isFocused={isFocused}
              onFocusCell={() => onFocusCell(rowKey, key)}
              copyText={copyText}
              keys={keys}
              drag={drag}
              landing={landing}
              contexts={contexts}
            >
              <WrittenValue write={hops && writeAt(key, hops)} disk={shown}>
                {() => !isExpanded && hasElement && (
                  <span style={{ opacity: summary ? undefined : 0.5, display: 'inline-flex', alignItems: 'center' }}>
                    {collapsedLabel}<CheckErrorIcon checkError={checkError} />
                  </span>
                )}
              </WrittenValue>
            </DiskCell>
          );
        }
        return (
          <DiskCell
            keys={keys}
            drag={drag}
            landing={landing}
            contexts={contexts}
            key={key}
            style={cellStyle}
            title={cellTitle}
            isFocused={isFocused}
            onFocusCell={() => onFocusCell(rowKey, key)}
            copyText={copyText}
          >
            {/* "[3]"/"{…}" say a container is present and merely unexpanded, and a leaf reads its
                default, so nothing at all stands in for a column that has no such thing. */}
            {hasElement && (
              <WrittenValue write={hops && writeAt(key, hops)} disk={shown}>
                {value => renderCell(value ?? defaultOf(cellMeta), cellMeta, {
                  // A reference the disk does not hold yet has no resolution.
                  checkError, resolution: value === shown ? resolution : undefined,
                  onCommit: cellEditable ? (v: unknown) => onEditCell(key, v) : undefined,
                  rowCollapsed: isFlagsRow && !rowExpanded,
                })}
              </WrittenValue>
            )}
          </DiskCell>
        );
      })}
    </tr>
  );
}
