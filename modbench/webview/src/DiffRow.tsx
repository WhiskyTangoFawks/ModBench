import React from 'react';
import { FlagCell } from './FlagCell';
import { ScalarCell } from './ScalarCell';
import { FormKeyCell } from './FormKeyCell';
import { VmadObjectCell } from './VmadObjectCell';
import { ConditionFunctionCell, ConditionRunOnCell, ConditionComparisonCell, ConditionParamCell } from './ConditionCells';
import { CheckErrorIcon } from './CheckErrorIcon';
import { DiskCell } from './DiskCell';
import { modelValue } from './modelValue';
import { copyToClipboard } from './nativeBridge';
import { baseCell, toggleBtnStyle, getCellStyle, focusedRowStyle, DIMMED_OPACITY } from './gridStyles';
import type { Column, PathSegment } from './recordUtils';
import type { ColumnKey, CompareOverride, ConflictAll, FieldDiff, FieldMetadata, FormKeyResolution } from './types';


const ROW_BG: Partial<Record<ConflictAll, string>> = {
  Override:        'rgba(76,175,80,0.20)',
  Conflict:        'rgba(255,152,0,0.20)',
  ConflictCritical: 'rgba(244,67,54,0.20)',
};

// Issue #114: undefined (an adapter that hasn't populated FieldDiff.conflictAll yet) degrades to
// "no background" rather than throwing — the same safe default a genuinely NoConflict/OnlyOne
// node already gets, since ROW_BG has no entry for either.
const getRowBg = (c: ConflictAll | undefined): string | undefined => (c ? ROW_BG[c] : undefined);

interface RenderCellExtras {
  checkError?: string | null;
  resolution?: FormKeyResolution;
  // Issue #231 (review, design call): this plugin's own xEdit-style prose summary
  // (`diff.collapsedSummary`) for a struct row's collapsed label — set only for a Condition row;
  // undefined for every other struct row, which fall back to the generic "{…}" below.
  summaryLabel?: string;
  // #415: where an edited value goes. Absent means this cell has nowhere to write — an immutable
  // or untracked column, or a caller outside the field grid — and the leaf renders read-only.
  onCommit?: (v: unknown) => void;
}

// #415/ADR-0041: leaves render read-only unless the caller supplies `onCommit` — the presence of
// somewhere to write *is* the editability signal, so a call site that has no write path cannot
// accidentally ask for an editor (which is what #410's removal of `editable` was protecting, kept
// here in a form that also allows the one gesture back). Only the scalar leaf honours it today;
// every other cell type stays read-only until the gesture-inventory ticket restores its own editor.
function renderCell(
  value: unknown,
  meta: FieldMetadata,
  isFocused: boolean,
  onOpen: (fk: string) => void,
  { checkError, resolution, summaryLabel, onCommit }: RenderCellExtras = {},
): React.ReactNode {
  if (meta.type === 'formKey') {
    return (
      <FormKeyCell
        value={value} meta={meta} isFocused={isFocused}
        onOpen={onOpen} checkError={checkError} resolution={resolution}
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
        {summaryLabel ?? '{…}'}<CheckErrorIcon checkError={checkError} />
      </span>
    );
  }
  if (meta.type === 'enum' && meta.isBitmask) {
    return <FlagCell value={value} meta={meta} />;
  }
  // Issue #231: VMAD/Condition's synthesized composite leaf types — each picks its own widget
  // from its own value's shape, dispatched here alongside 'formKey'.
  if (meta.type === 'vmadObject') {
    return <VmadObjectCell value={value} onOpen={onOpen} resolution={resolution} />;
  }
  if (meta.type === 'conditionFunction') {
    return <ConditionFunctionCell value={value} isFocused={isFocused} />;
  }
  if (meta.type === 'conditionRunOn') {
    return <ConditionRunOnCell value={value} meta={meta} isFocused={isFocused} onOpen={onOpen} resolution={resolution} />;
  }
  if (meta.type === 'conditionComparison') {
    return <ConditionComparisonCell value={value} isFocused={isFocused} onOpen={onOpen} resolution={resolution} />;
  }
  if (meta.type === 'conditionParam') {
    return <ConditionParamCell value={value} isFocused={isFocused} onOpen={onOpen} resolution={resolution} />;
  }
  return (
    <ScalarCell
      value={value}
      meta={meta}
      isFocused={isFocused}
      // `meta.readOnly` (#231) is a per-row veto a synthesized row can set regardless of what the
      // column allows — ORed with "the caller gave us nowhere to write", so both have to say yes.
      editable={onCommit != null && !meta.readOnly}
      onCommit={onCommit}
    />
  );
}

// Issue #231: replaces the old fixed four-member union (`top-level | array-element | struct-child
// | grandchild`), which had no way to express a fifth level of nesting at all — VMAD's own struct
// data (Schema/VmadCodec.cs: "the (de)serializer descends to arbitrary depth") genuinely needs
// one, and folding it into this same tree without generalizing would either truncate real VMAD
// editing capability at the old cap or force a parallel VMAD-only deep path bolted alongside this
// one, both of which the unified-tree model rules out. `path` is the chain of hops from the root
// value this row's edits ultimately restage (RecordPanel's own onEdit-per-row-context closures,
// pre-#231, each hand-built one nesting level; see recordUtils.ts's getAtPath/setAtPath, the one
// generic implementation every depth now shares) down to this row's own value — `[]` at the root.
// `overrideMeta` is this row's own metadata, present at every depth except the root (which reads
// from `fieldMetaMap` instead, keyed by the diff tree's own top-level field name). `rootField` is
// the wire path staged as one atomic PendingChange for every row in this subtree — constant
// across the whole chain, equal to `diff.fieldName` for an ordinary field, and (from #231 on) a
// VMAD/Condition row's own synthesized wire path when the two differ from its display label.
export interface RowContext {
  path: PathSegment[];
  overrideMeta?: FieldMetadata;
  rootField: string;
}

// Issue #222 / ADR-0034: identifies one value cell, panel-wide — the state RecordPanel (the only
// component that sees every row) holds to enforce "exactly one cell focused at a time, across the
// whole panel." `rowKey` matches the string RecordPanel already computes for this row's own React
// `key=` at every nesting level (top-level/array-element/struct-child/grandchild), so no new
// identity scheme is invented.
//
// Issue #232: `plugin` alone can't tell a pending cell apart from its disk-column companion —
// both share the exact same plugin name (buildColumns only ever adds a `'pending'` column for a
// plugin whose `'disk'` column already exists). `column` is the discriminant: absent (or
// `undefined`) means the disk cell, `'pending'` means that plugin's pending companion — so every
// pre-#232 `{ rowKey, plugin }` literal still means "the disk cell," unchanged, while a pending
// cell gets its own independent focus identity rather than aliasing its disk sibling's.
// #272 / ADR-0036: `plugin` is this column's compound identity (ColumnKey), not the bare filename
// — two columns sharing a filename but differing in origin must not both read as focused off one
// `setFocusedCell` call. Field name kept as `plugin` (not renamed to `column`, which already means
// the disk/pending discriminant below) — only its type changed.
export interface FocusedCell {
  rowKey: string;
  plugin: ColumnKey;
  column?: 'pending';
}

// Issue #232 (review): the one check both the disk-leaf and pending-column branches below need —
// "is this exact row/plugin/column the panel's single focused cell" — pulled out so neither
// re-derives FocusedCell's own three-field comparison inline. `column` defaults to `undefined`
// (a disk cell), matching FocusedCell's own convention.
function isCellFocused(focusedCell: FocusedCell | null, rowKey: string, plugin: ColumnKey, column?: 'pending'): boolean {
  return focusedCell?.rowKey === rowKey && focusedCell.plugin === plugin && focusedCell.column === column;
}

interface DiffRowProps {
  diff: FieldDiff;
  columns: Column[];
  // #272 / ADR-0036: keyed by ColumnKey (a mapped type over a non-literal string collapses to a
  // plain index signature, so this isn't compiler-enforced — the protection is every builder
  // using columnKey(), not this declared type; see types.ts' ColumnKey doc comment). Declared as
  // Record<string, ...> since the brand is erased here regardless (matches RecordPanel.tsx's own
  // overrideMap declaration, kept in sync for the same React Compiler reason documented there).
  overrideMap: Record<string, CompareOverride>;
  fieldMetaMap: Record<string, FieldMetadata>;
  // #304 / ADR-0035: a column for a copy the load order does not name — distinct from
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
  // Issue #222: this row's own identity (see FocusedCell above), the panel's current focused
  // cell (or none), and the callback that reports a click up to RecordPanel's single source of
  // truth. onFocusCell takes rowKey explicitly (rather than closing over it here) so RecordPanel
  // stays the one place that knows how a click turns into a FocusedCell. Issue #232: the optional
  // third parameter is FocusedCell's own `column` discriminant — omitted (disk cell) by every
  // call site below except the pending column's own.
  rowKey: string;
  focusedCell: FocusedCell | null;
  onFocusCell: (rowKey: string, plugin: ColumnKey, column?: 'pending') => void;
  // #415: the columns whose cells can be written — mutable plugin, in the load order, and its mod
  // tracked. RecordPanel computes it once for the whole grid so a single definition of "writable"
  // reaches every row; a column absent from this set renders read-only everywhere it appears.
  editableColumns: Set<ColumnKey>;
  // #415: commits an edited value for one column's cell on this row. Absent when this row cannot be
  // written at all (a synthesized read-only row, or a panel with no write path wired).
  onEditCell?: (plugin: ColumnKey, fieldPath: string, value: unknown) => void;
}

export function DiffRow({
  diff, columns, overrideMap, fieldMetaMap, notInLoadOrderSet,
  collapsedColumns, onOpen,
  context, hasChildren, isExpanded, onToggle,
  rowKey, focusedCell, onFocusCell, editableColumns, onEditCell,
}: Readonly<DiffRowProps>) {
  // Issue #231: prefer the caller's own `context.overrideMeta` whenever it's supplied — RecordPanel
  // now always passes one (its recursive builder resolves every row's metadata itself, including
  // the true top-level one), including for a row whose own `path` has just reset to `[]` because
  // it's a synthesized subtree root (a VMAD property, a Condition field) rather than a genuine
  // top-level `diffs` entry — `path.length === 0` alone can no longer distinguish the two. Falling
  // back to `fieldMetaMap` only when `overrideMeta` is genuinely absent keeps every caller that
  // still relies on that lookup (DiffRow.test.tsx's own top-level fixtures) working unchanged.
  const meta = context.overrideMeta ?? fieldMetaMap[diff.fieldName];
  if (!meta) return null;

  // Issue #231: rootField replaces the old kind-based pendingLookupField ternary — every row in
  // one subtree (root, struct-child, array-element, grandchild, and now any deeper hop) shares the
  // same wire path/pendingFields key, so RecordPanel hands it down unchanged at every depth rather
  // than DiffRow re-deriving "top-level or not."
  const pendingLookupField = context.rootField;
  // Issue #231: showActions (the checkError icon) was "top-level or struct-child" under the old
  // union — generalizes to "every hop on this row's path is a struct member," which reproduces
  // that exact rule (path.length === 0 is vacuously true; a single array-index or sortKey hop, or
  // one anywhere in a longer chain, turns it off, matching the old array-element/grandchild cases)
  // and extends it uniformly to a struct nested more than one level deep, which the old model
  // could not express at all.
  const showActions = context.path.every(seg => seg.kind === 'member');
  const isRowFocused = focusedCell?.rowKey === rowKey;
  // Issue #114: this row paints its own node's bottom-up conflict state, not a record-wide value
  // smeared onto every row. A struct/array row with children defers to its own children's tints
  // while expanded — painting both would duplicate the signal and misattribute it to fields that
  // didn't change — and shows the subtree's aggregate only while collapsed, so collapsing never
  // hides that something inside differs.
  const rowConflictAll = hasChildren && isExpanded ? undefined : diff.conflictAll;

  return (
    <tr style={{ backgroundColor: getRowBg(rowConflictAll), ...(isRowFocused ? focusedRowStyle : undefined) }}>
      {/* Issue #223 / ADR-0034: double-clicking the label column expands/collapses the node,
          the same action the toggle button already performs. RecordPanel always supplies a
          defined onToggle for top-level and array-element rows, even when hasChildren is
          false — there, double-click harmlessly flips this row's key in expandedStructs, an
          entry nothing ever reads for a row with no children to expand. onToggle is genuinely
          undefined only for struct-child/grandchild rows, which RecordPanel never wires with
          one (no expand button there either), so this is a true no-op only for those. */}
      <td
        style={{ ...baseCell, opacity: 0.75, userSelect: 'text', paddingLeft: context.path.length > 0 ? 24 : undefined }}
        onDoubleClick={onToggle}
      >
        {hasChildren && (
          <button style={toggleBtnStyle} onClick={onToggle}>{isExpanded ? '▼' : '▶'}</button>
        )}
        {diff.fieldName}
      </td>
      {columns.map(col => {
        if (col.kind === 'disk') {
          const { key } = col;
          // Issue #201 / #226 / ADR-0034: no `userSelect: 'text'` here. It was always dead letter
          // — the cell is `draggable` at rest and `draggable` consumes the mousedown that would
          // start a selection — and post-#226 there is no in-cell surface left to ever own a
          // selection either. Leaving it would tell the next reader selection works here.
          // #272 / ADR-0036: every lookup below into a per-column wire dictionary (cellStates,
          // values, resolutions, collapsedSummary) or panel state (collapsedColumns, immutableSet,
          // overrideMap, focusedCell) is keyed by `key` (this column's ColumnKey), not `o.plugin`
          // — the backend keys its own per-column dictionaries the same way (ColumnKey.Of), so
          // `[o.plugin]` was already wrong the moment a non-Data-origin column existed, not merely
          // ambiguous between two same-filename columns.
          const cellStyle = {
            ...baseCell, ...getCellStyle(diff.cellStates?.[key]),
            opacity: notInLoadOrderSet.has(key) ? DIMMED_OPACITY : undefined,
          };
          if (collapsedColumns.has(key)) {
            return <td key={`disk:${key}`} style={cellStyle} />;
          }
          const checkError = showActions
            ? overrideMap[key]?.fields.find(f => f.metadata.name === pendingLookupField)?.checkError
            : undefined;
          // Issue #231: a synthesized row (e.g. the Condition section's AND/OR gate) can mark
          // itself unconditionally read-only regardless of column mutability — `meta.readOnly` is
          // the one new per-row override on top of immutableSet's existing per-column rule, ORed
          // in wherever a column's mutability previously stood alone.
          // Issue #232: `isCellFocused`'s default (no `column` arg, i.e. `undefined`) is the disk
          // cell's own identity — never matches a same-row, same-plugin *pending* focus record,
          // which carries `column: 'pending'` — see FocusedCell's own doc comment for why the two
          // need separate identities despite sharing `plugin`.
          const isFocused = isCellFocused(focusedCell, rowKey, key);
          // Issue #224 / ADR-0034: the string Ctrl+C copies for this cell — the same value used
          // for display below (diff.values[key]), run through the one shared modelValue
          // function (AC6), computed once here so both the struct/array-summary branch and the
          // leaf branch below hand DiskCell the identical value a scalar/flag/formKey cell would
          // display and a struct/array cell would otherwise only show as "{…}"/"[3]" (AC5). Plain
          // disk value, no pending merge — a disk column's own display never merges pending (only
          // the separate Pending column does, out of scope here per #232).
          const copyText = modelValue(diff.values[key], meta, diff.resolutions?.[key]);
          if (hasChildren) {
            const len = meta.type === 'array' && Array.isArray(diff.values[key])
              ? (diff.values[key] as unknown[]).length
              : '…';
            // Issue #231 (review, design call): a Condition row's own xEdit-style prose summary
            // (`diff.collapsedSummary`, conditionTreeAdapter.ts) replaces the generic "{…}"
            // placeholder when present — every other struct row (VMAD included) has none.
            const collapsedLabel = meta.type === 'array' ? `[${len}]` : (diff.collapsedSummary?.[key] ?? '{…}');
            return (
              <DiskCell
                key={`disk:${key}`}
                style={cellStyle}
                isFocused={isFocused}
                onFocusCell={() => onFocusCell(rowKey, key)}
                onCopy={() => copyToClipboard(copyText)}
              >
                {!isExpanded && (
                  <span style={{ opacity: 0.5, display: 'inline-flex', alignItems: 'center' }}>
                    {collapsedLabel}<CheckErrorIcon checkError={checkError} />
                  </span>
                )}
              </DiskCell>
            );
          }
          return (
            <DiskCell
              key={`disk:${key}`}
              style={cellStyle}
              isFocused={isFocused}
              onFocusCell={() => onFocusCell(rowKey, key)}
              onCopy={() => copyToClipboard(copyText)}
            >
              {renderCell(diff.values[key], meta, isFocused, onOpen, {
                checkError, resolution: diff.resolutions?.[key],
                summaryLabel: diff.collapsedSummary?.[key],
                // #415: undefined for a column the panel says cannot be written, which is what
                // makes the cell read-only — see renderCell's own note. RecordPanel owns the one
                // definition of "writable"; this only reads its answer.
                onCommit: onEditCell && editableColumns.has(key)
                  ? (v: unknown) => onEditCell(key, pendingLookupField, v)
                  : undefined,
              })}
            </DiskCell>
          );
        }
        return null;
      })}
    </tr>
  );
}
