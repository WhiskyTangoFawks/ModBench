import React from 'react';
import { FlagCell } from './FlagCell';
import { ScalarCell } from './ScalarCell';
import { FormKeyCell } from './FormKeyCell';
import { CheckErrorIcon } from './CheckErrorIcon';
import { DiskCell } from './DiskCell';
import { readsAsFlags } from './modelValue';
import { ExpandArrow } from './ExpandArrow';
import { collapsedReading, versionControlInfo1 } from './presentation';
import {
  baseCell, labelCell, getCellStyle, focusedRowStyle, conflictStateName, rowBackground,
} from './gridStyles';
import { defaultOf, isArrayElementHop, type Column } from './recordUtils';
import type { ColumnKey, ConflictThis, FieldMetadata, FormKeyResolution, PathHop } from './types';
import type { FieldRow } from './recordRows';
import type { FocusedCell } from './gridNavigation';
import { LABEL_COLUMN } from './columnKey';
import type { ArrayParentContext } from '../../src/wire/messages';
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
  // What the cell reads at rest, where its reading takes more than its value and its schema.
  reading?: string;
}

// Leaves render read-only unless the caller supplies `onCommit`: the presence of somewhere to
// write *is* the editability signal, so a call site that has no write path cannot
// accidentally ask for an editor.
function renderCell(
  value: unknown,
  meta: FieldMetadata,
  { checkError, resolution, onCommit, rowCollapsed, reading }: RenderCellExtras = {},
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
  if (readsAsFlags(meta)) {
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
      displayOverride={reading}
    />
  );
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

interface DiffRowProps {
  row: FieldRow;
  columns: Column[];
  // Each column's look, as the panel gives its header too, so the header and every cell under it
  // can never disagree.
  columnStyle: (column: ColumnKey | typeof LABEL_COLUMN) => React.CSSProperties;
  collapsedColumns: Set<ColumnKey>;
  isExpanded?: boolean;
  onToggle?: () => void;
  focusedCell: FocusedCell | null;
  onFocusCell: (rowKey: string, plugin: ColumnKey | null) => void;
  onEdit: (plugin: ColumnKey, path: PathHop[], value: unknown) => void;
  onAddElement: (context: ArrayParentContext, value: unknown) => void;
}

export function DiffRow({
  row, columns, columnStyle, collapsedColumns, isExpanded, onToggle, focusedCell, onFocusCell, onEdit, onAddElement,
}: Readonly<DiffRowProps>) {
  const { diff, meta, key: rowKey, parent: parentRowKey, isLastElement, keyMembers } = row;
  // The children the diff node itself carries — the row and the panel can never disagree about
  // whether this node has any.
  const hasChildren = (diff.children?.length ?? 0) > 0;
  const label = meta.displayLabel ?? diff.fieldName;
  const isArrayElementRow = isArrayElementHop(row.path.at(-1));
  const isRowFocused = focusedCell?.rowKey === rowKey;
  // This row paints its own node's conflict state, not a record-wide value. An expanded row with
  // children defers to its children's tints — painting both would duplicate the signal — and
  // shows the subtree's aggregate only while collapsed.
  const rowBg = hasChildren && isExpanded ? undefined : rowBackground(diff.conflictAll);

  // A flags row is collapsible like a struct row, though its "children" are the checkbox lines
  // inside the cell, not sub-rows.
  const isFlagsRow = readsAsFlags(meta);
  const rowExpanded = !!isExpanded;

  return (
    <tr style={{ backgroundColor: rowBg, ...(isRowFocused ? focusedRowStyle : undefined) }}>
      {/* editor.md, Rows, story 4. */}
      <DiskCell
        style={{ ...labelCell(columnStyle(LABEL_COLUMN)), paddingLeft: row.depth * INDENT_PER_LEVEL || undefined }}
        isFocused={isCellFocused(focusedCell, rowKey, null)}
        onFocusCell={() => onFocusCell(rowKey, null)}
        onDoubleClick={onToggle}
        context={row.label.context}
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
        // No `userSelect: 'text'` (editor.md, The focused cell): the cell is `draggable` at rest,
        // and `draggable` consumes the mousedown that would start a selection.

        // mEdit sends no state for the master's own cell, nor for any cell of a lone copy.
        const cellState = diff.cellStates[key] ?? masterOrOnlyOne(diff.values[key], key, columns);
        const cellStyle = {
          ...baseCell, ...getCellStyle(cellState), ...columnStyle(key),
        };
        const cell = row.cells.get(key);
        if (collapsedColumns.has(key) || !cell) {
          return <td key={key} style={cellStyle} />;
        }
        const { meta: cellMeta, holds, shown, write, addTo } = cell;
        // The wire carries one per column at every depth, so this row's error is its own node's.
        const checkError = diff.checkErrors?.[key];
        const isFocused = isCellFocused(focusedCell, rowKey, key);
        const cellTitle = [cellState && conflictStateName(cellState), cellMeta.readOnlyReason]
          .filter(Boolean).join('\n') || undefined;
        const edit = write && ((value: unknown) => onEdit(key, write, value));
        const drag: CellDrag | undefined = diff.values[key] != null
          ? { row: rowKey, arrayRow: isArrayElementRow ? parentRowKey : null, value: diff.values[key] }
          : undefined;
        const landing = (dragged: CellDrag): (() => void) | undefined => {
          if (dragged.row === rowKey) {
            return edit && JSON.stringify(dragged.value) !== JSON.stringify(shown)
              ? () => edit(dragged.value)
              : undefined;
          }
          return addTo && dragged.arrayRow === rowKey
            ? () => onAddElement(addTo, dragged.value)
            : undefined;
        };
        const resolution = diff.resolutions?.[key];
        if (hasChildren) {
          const reading = isExpanded ? undefined : collapsedReading(diff, cellMeta, key, isLastElement?.(key), keyMembers);
          return (
            <DiskCell
              key={key}
              style={cellStyle}
              title={cellTitle}
              isFocused={isFocused}
              onFocusCell={() => onFocusCell(rowKey, key)}
              context={cell.context}
              drag={drag}
              landing={landing}
            >
              {reading && holds && (
                <span style={{ opacity: reading.isPlaceholder ? 0.5 : undefined, display: 'inline-flex', alignItems: 'center' }}>
                  {reading.text}<CheckErrorIcon checkError={checkError} />
                </span>
              )}
            </DiskCell>
          );
        }
        return (
          <DiskCell
            drag={drag}
            landing={landing}
            context={cell.context}
            key={key}
            style={cellStyle}
            title={cellTitle}
            isFocused={isFocused}
            onFocusCell={() => onFocusCell(rowKey, key)}
          >
            {/* "[3]"/"{…}" say a container is present and merely unexpanded, and a leaf reads its
                default, so nothing at all stands in for a column that has no such thing. */}
            {holds && (
              renderCell(shown ?? defaultOf(cellMeta), cellMeta, {
                checkError, resolution,
                onCommit: edit,
                rowCollapsed: isFlagsRow && !rowExpanded,
                reading: cellMeta.isVersionControlInfo1 ? versionControlInfo1(shown, override) : undefined,
              })
            )}
          </DiskCell>
        );
      })}
    </tr>
  );
}
