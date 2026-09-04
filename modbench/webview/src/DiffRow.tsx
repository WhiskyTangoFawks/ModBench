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
  arrayElementContext, arrayParentContext, combineVscodeContexts,
  stringValueContext, type Column, type PathSegment,
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
  // "[3]"/"{…}" say a container is present and merely unexpanded. Nothing stands in for a
  // container this column's plugin doesn't have. Containers only: an absent scalar keeps
  // ScalarCell's own "—", the panel-wide reading of "this column has no value here" that its
  // editor gesture is already built around.
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

// A row's coordinates in the unified tree, at arbitrary nesting depth — a script property's own
// struct data genuinely needs
// more than any fixed set of levels. `path` is the chain of hops from the root
// value this row's edits ultimately restage (see recordUtils.ts's getAtPath/setAtPath, the one
// generic implementation every depth shares) down to this row's own value — `[]` at the root.
// `overrideMeta` is this row's own metadata, present at every depth except the root (which reads
// from `fieldMetaMap` instead, keyed by the diff tree's own top-level field name). `rootField` is
// the wire path staged as one atomic change for every row in this subtree — constant across the
// whole chain, and equal to the subtree root's own `diff.fieldName`.
export interface RowContext {
  path: PathSegment[];
  overrideMeta?: FieldMetadata;
  rootField: string;
  // True ancestor-hop count, tracked independently of `path` so indentation stays a property of
  // where a row sits in the tree rather than of how far into a value it addresses.
  depth: number;
}

// ADR-0034: identifies one value cell, panel-wide — the state RecordPanel (the only
// component that sees every row) holds to enforce "exactly one cell focused at a time, across the
// whole panel." `rowKey` matches the string RecordPanel already computes for this row's own React
// `key=` at every nesting level (top-level/array-element/struct-child/grandchild), so no new
// identity scheme is invented.
//
// ADR-0036: `plugin` is this column's compound identity (ColumnKey), not the bare filename
// — two columns sharing a filename but differing in origin must not both read as focused off one
// `setFocusedCell` call.
export interface FocusedCell {
  rowKey: string;
  plugin: ColumnKey;
}

// The one check the leaf branches below need — "is this exact row/plugin the
// panel's single focused cell" — pulled out so nothing re-derives FocusedCell's own two-field
// comparison inline.
function isCellFocused(focusedCell: FocusedCell | null, rowKey: string, plugin: ColumnKey): boolean {
  return focusedCell?.rowKey === rowKey && focusedCell.plugin === plugin;
}

// One step of label indentation per ancestor hop, so a row's indent reads as its real depth.
const INDENT_PER_LEVEL = 24;

interface DiffRowProps {
  diff: FieldDiff;
  columns: Column[];
  // ADR-0036: keyed by ColumnKey (a mapped type over a non-literal string collapses to a
  // plain index signature, so this isn't compiler-enforced — the protection is every builder
  // using columnKey(), not this declared type; see types.ts' ColumnKey doc comment). Declared as
  // Record<string, ...> since the brand is erased here regardless (matches RecordPanel.tsx's own
  // overrideMap declaration, kept in sync for the same React Compiler reason documented there).
  overrideMap: Record<string, CompareOverride>;
  fieldMetaMap: Record<string, FieldMetadata>;
  // ADR-0035: a column for a copy the load order does not name — distinct from
  // immutableSet (a vanilla master is also immutable but stays out of this set; see
  // recordUtils.ts's readOnlyReason). Dims every cell in the column so the cue survives
  // scrolling past PluginHeader's own note (the grid's <thead> isn't sticky).
  notInLoadOrderSet: Set<ColumnKey>;
  collapsedColumns: Set<ColumnKey>;
  onOpen: (fk: string) => void;
  context: RowContext;
  hasChildren?: boolean;
  isExpanded?: boolean;
  onToggle?: () => void;
  // This row's own identity (see FocusedCell above), the panel's current focused
  // cell (or none), and the callback that reports a click up to RecordPanel's single source of
  // truth. onFocusCell takes rowKey explicitly (rather than closing over it here) so RecordPanel
  // stays the one place that knows how a click turns into a FocusedCell.
  rowKey: string;
  focusedCell: FocusedCell | null;
  onFocusCell: (rowKey: string, plugin: ColumnKey) => void;
  // The columns whose cells can be written — mutable plugin, in the load order, and its mod
  // tracked. RecordPanel computes it once for the whole grid so a single definition of "writable"
  // reaches every row; a column absent from this set renders read-only everywhere it appears.
  editableColumns: Set<ColumnKey>;
  // Commits an edited value for one column's cell on this row. Absent when this row cannot be
  // written at all (a synthesized read-only row, or a panel with no write path wired).
  //
  // Takes the leaf value alone — no field path. A caller-supplied path invites pairing the
  // subtree's root wire path with one leaf's value, so an array/struct field receives a single
  // element, the backend applier declines the shape without saying so, and the edit vanishes.
  // *Where* an
  // edited leaf goes is a question about the whole subtree (which root, and which path inside it),
  // and only RecordPanel's row builder knows both halves — so it binds them per row and hands down
  // a callback that needs neither. A row cannot pair them wrongly because it holds neither.
  onEditCell?: (plugin: ColumnKey, value: unknown) => void;
  // Add on this row — present only when this row is itself a
  // mutable, unsorted array's own row (RecordPanel's buildRows decides that; DiffRow only wires
  // whatever it's handed, per column, gated by editableColumns the same as onEditCell).
  onArrayAdd?: (plugin: ColumnKey) => void;
  // Remove/Move Up/Move Down — present only when this row is itself a mutable, unsorted array's
  // element row.
  onArrayRemove?: (plugin: ColumnKey) => void;
  onArrayMoveUp?: (plugin: ColumnKey) => void;
  onArrayMoveDown?: (plugin: ColumnKey) => void;
  // #693: what each column's cell reads while this row is collapsed, when the presentation table
  // (presentation.ts) has an entry for this row's own schema leaf — a condition reads as the xEdit
  // prose a modder already knows instead of "{…}". Absent for a row that is not an array element,
  // and empty for an element whose leaf the table says nothing about. Supplied by the frame that
  // descended into this row's own list, which is the only one that knows it.
  collapsedSummary?: Record<string, string>;
}

export function DiffRow({
  diff, columns, overrideMap, fieldMetaMap, notInLoadOrderSet,
  collapsedColumns, onOpen,
  context, hasChildren, isExpanded, onToggle,
  rowKey, focusedCell, onFocusCell, editableColumns, onEditCell,
  onArrayAdd, onArrayRemove, onArrayMoveUp, onArrayMoveDown, collapsedSummary,
}: Readonly<DiffRowProps>) {
  // Prefer the caller's own `context.overrideMeta` whenever it's supplied — RecordPanel
  // always passes one (its recursive builder resolves every row's metadata itself, including
  // the true top-level one). Falling
  // back to `fieldMetaMap` only when `overrideMeta` is genuinely absent keeps every caller that
  // still relies on that lookup (DiffRow.test.tsx's own top-level fixtures) working unchanged.
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
  // This row is itself a mutable array's own row (Add applies) or one of its element rows
  // (Remove applies) — a pure-FormLink (wbArrayS) array offers neither, per the spec's own
  // "absent, not disabled" rule for them.
  const isUnsortedArrayParentRow = meta.type === 'array' && !!meta.elementType && !meta.elementType.isSortable;
  const lastPathSegment = context.path[context.path.length - 1];
  const isArrayElementRow = lastPathSegment?.kind === 'index' || lastPathSegment?.kind === 'key';
  // Move Up/Move Down apply to a positional element only: a keyed array is stored in key order on
  // every write (Edits/KeyedArrays.cs), so a move there could not change the file.
  const isMovableElementRow = lastPathSegment?.kind === 'index';
  const isRowFocused = focusedCell?.rowKey === rowKey;
  // This row paints its own node's bottom-up conflict state, not a record-wide value
  // smeared onto every row. A struct/array row with children defers to its own children's tints
  // while expanded — painting both would duplicate the signal and misattribute it to fields that
  // didn't change — and shows the subtree's aggregate only while collapsed, so collapsing never
  // hides that something inside differs.
  const rowConflictAll = hasChildren && isExpanded ? undefined : diff.conflictAll;

  // Maintainer rulings 2026-09-01: a flags row is collapsible like a struct row — chevron +
  // double-click-the-label, the grid's one collapse gesture — though its "children" are the
  // checkbox lines inside the cell, not sub-rows. It starts collapsed ("we start with the
  // clean view"), so it shares struct rows' default exactly: expanded only when the toggle
  // put the row in expandedStructs.
  const isFlagsRow = meta.type === 'enum' && flagBits(meta) != null;
  const rowExpanded = !!isExpanded;
  // A row no column carries a value for holds nothing but its children, so it is present in every
  // column — nothing there is absent relative to anything, and `hasElement` below stays true
  // throughout.
  const rowIsStructural = Object.values(diff.values).every(v => v == null);

  return (
    <tr style={{ backgroundColor: getRowBg(rowConflictAll), ...(isRowFocused ? focusedRowStyle : undefined) }}>
      {/* ADR-0034: double-clicking the label column expands/collapses the node,
          the same action the toggle button already performs. RecordPanel always supplies a
          defined onToggle for top-level and array-element rows, even when hasChildren is
          false — there, double-click harmlessly flips this row's key in expandedStructs, an
          entry nothing ever reads for a row with no children to expand. onToggle is genuinely
          undefined only for struct-child/grandchild rows, which RecordPanel never wires with
          one (no expand button there either), so this is a true no-op only for those. */}
      <td
        style={{ ...baseCell, opacity: 0.75, userSelect: 'text', paddingLeft: context.depth * INDENT_PER_LEVEL || undefined }}
        onDoubleClick={onToggle}
      >
        {(hasChildren || isFlagsRow) && (
          <button style={toggleBtnStyle} onClick={onToggle}>{rowExpanded ? '▼' : '▶'}</button>
        )}
        {/* The schema's own label when the field's name is a wire name rather than a readable
            one (an abstract union's `concrete_type` is "Kind", #688). */}
        {meta.displayLabel ?? diff.fieldName}
      </td>
      {columns.map(col => {
        if (col.kind === 'disk') {
          const { key, override } = col;
          // ADR-0034: no `userSelect: 'text'` here — the cell is `draggable` at rest and
          // `draggable` consumes the mousedown that would
          // start a selection, and there is no in-cell surface to ever own a
          // selection either. Adding it would tell the next reader selection works here.
          // ADR-0036: every lookup below into a per-column wire dictionary (cellStates,
          // values, resolutions) or panel state (collapsedColumns, immutableSet,
          // overrideMap, focusedCell) is keyed by `key` (this column's ColumnKey), not `o.plugin`
          // — the backend keys its own per-column dictionaries the same way (ColumnKey.Of), so
          // `[o.plugin]` would be wrong the moment a non-Data-origin column exists, not merely
          // ambiguous between two same-filename columns.
          // A Partial Form column dims the same way a not-in-load-order one does — read
          // straight off the column's own override.isPartialForm (already riding on this Column),
          // not a separately-threaded Set, since the fact already lives on data this row has.
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
          // A synthesized row can mark itself unconditionally read-only regardless of column
          // mutability — `meta.readOnly` is
          // the one per-row override on top of immutableSet's per-column rule.
          const isFocused = isCellFocused(focusedCell, rowKey, key);
          // ADR-0034: the string Ctrl+C copies for this cell — the same value used
          // for display below (diff.values[key]), run through the one shared displayValue
          // function, computed once here so both the struct/array-summary branch and the
          // leaf branch below hand DiskCell the identical value a scalar/flag/formKey cell would
          // display and a struct/array cell would otherwise only show as "{…}"/"[3]".
          const copyText = displayValue(diff.values[key], meta, diff.resolutions?.[key]);
          // Whether this column's plugin has an element on this row at all: an array slot within
          // its own length, a union member its own concrete leaf declares, a struct it carries.
          const hasElement = rowIsStructural || diff.values[key] != null;
          // Array ops are offered only on a writable column —
          // the same gate onEditCell/onCommit already use. `arrayLength` is deliberately not
          // threaded down to this row, so canMoveDown reads
          // permissive (true) rather than gating the menu item's presence on this plugin's own
          // real length the way canMoveUp already does via `index > 0`; the underlying op still
          // safely no-ops at the true boundary (ArrayOpWriter answers a move past either end
          // as a NoOp that commits nothing).
          const arrayEditable = !!onEditCell && editableColumns.has(key) && (isUnsortedArrayParentRow || isArrayElementRow);
          const arrayOps = arrayEditable ? {
            add: isUnsortedArrayParentRow ? () => onArrayAdd?.(key) : undefined,
            remove: isArrayElementRow ? () => onArrayRemove?.(key) : undefined,
            moveUp: isMovableElementRow ? () => onArrayMoveUp?.(key) : undefined,
            moveDown: isMovableElementRow ? () => onArrayMoveDown?.(key) : undefined,
          } : undefined;
          // The one definition of "this cell can be written" — onEditCell wired, the
          // column in editableColumns, and no per-row readOnly veto. Hoisted above vscodeContext
          // because
          // stringValueContext needs it too — a string cell's own `readOnly` is this same boolean,
          // negated, so the right-click menu and the inline-editor gate can never disagree about
          // whether the cell is writable.
          const cellEditable = !!onEditCell && editableColumns.has(key) && !meta.readOnly;
          // ADR-0039: a `string` cell always carries its own right-click context — mutable
          // or immutable alike, unlike arrayEditable above which only attaches on a writable
          // column. A read-only tab is still the only way to read a long immutable value in full.
          const vscodeContext = (arrayEditable || meta.type === 'string') ? combineVscodeContexts(
            // `context.path` addresses the array itself here (this row *is* the array) —
            // `[]` for a top-level array.
            isUnsortedArrayParentRow
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
