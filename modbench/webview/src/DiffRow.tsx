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
import {
  arrayElementContext, arrayParentContext, combineVscodeContexts,
  vmadScriptsContext, vmadScriptContext, vmadPropertyContext, stringValueContext, type Column, type PathSegment,
} from './recordUtils';
import { WRAPPER_NAME } from './vmadTreeAdapter';
import { parseVmadPath } from './vmadOps';
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
        // #426: same editability rule as the flags/scalar branches — presence of somewhere to
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
        {summaryLabel ?? '{…}'}<CheckErrorIcon checkError={checkError} />
      </span>
    );
  }
  if (meta.type === 'enum' && meta.isBitmask) {
    return (
      <FlagCell
        value={value}
        meta={meta}
        isFocused={isFocused}
        // Same rule as ScalarCell's editable computation just below: presence of somewhere to
        // write is the editability signal, ORed with the per-row readOnly veto.
        editable={onCommit != null && !meta.readOnly}
        onCommit={onCommit}
      />
    );
  }
  // Issue #231: VMAD/Condition's synthesized composite leaf types — each picks its own widget
  // from its own value's shape, dispatched here alongside 'formKey'. #426 Track 5: same editable
  // rule as every other branch above — presence of somewhere to write, ORed with the per-row
  // readOnly veto (load-bearing for Conditions' own AND/OR gate, unconditionally read-only).
  if (meta.type === 'vmadObject') {
    return (
      <VmadObjectCell
        value={value} onOpen={onOpen} resolution={resolution}
        editable={onCommit != null && !meta.readOnly} onCommit={onCommit}
      />
    );
  }
  if (meta.type === 'conditionFunction') {
    return <ConditionFunctionCell value={value} isFocused={isFocused} editable={onCommit != null && !meta.readOnly} onCommit={onCommit} />;
  }
  if (meta.type === 'conditionRunOn') {
    return (
      <ConditionRunOnCell
        value={value} meta={meta} isFocused={isFocused} onOpen={onOpen} resolution={resolution}
        editable={onCommit != null && !meta.readOnly} onCommit={onCommit}
      />
    );
  }
  if (meta.type === 'conditionComparison') {
    return (
      <ConditionComparisonCell
        value={value} isFocused={isFocused} onOpen={onOpen} resolution={resolution}
        editable={onCommit != null && !meta.readOnly} onCommit={onCommit}
      />
    );
  }
  if (meta.type === 'conditionParam') {
    return (
      <ConditionParamCell
        value={value} isFocused={isFocused} onOpen={onOpen} resolution={resolution}
        editable={onCommit != null && !meta.readOnly} onCommit={onCommit}
      />
    );
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
// the wire path staged as one atomic change for every row in this subtree — constant
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
// #272 / ADR-0036: `plugin` is this column's compound identity (ColumnKey), not the bare filename
// — two columns sharing a filename but differing in origin must not both read as focused off one
// `setFocusedCell` call.
export interface FocusedCell {
  rowKey: string;
  plugin: ColumnKey;
}

// Issue #232 (review): the one check the leaf branches below need — "is this exact row/plugin the
// panel's single focused cell" — pulled out so nothing re-derives FocusedCell's own two-field
// comparison inline.
function isCellFocused(focusedCell: FocusedCell | null, rowKey: string, plugin: ColumnKey): boolean {
  return focusedCell?.rowKey === rowKey && focusedCell.plugin === plugin;
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
  // stays the one place that knows how a click turns into a FocusedCell.
  rowKey: string;
  focusedCell: FocusedCell | null;
  onFocusCell: (rowKey: string, plugin: ColumnKey) => void;
  // #415: the columns whose cells can be written — mutable plugin, in the load order, and its mod
  // tracked. RecordPanel computes it once for the whole grid so a single definition of "writable"
  // reaches every row; a column absent from this set renders read-only everywhere it appears.
  editableColumns: Set<ColumnKey>;
  // #415: commits an edited value for one column's cell on this row. Absent when this row cannot be
  // written at all (a synthesized read-only row, or a panel with no write path wired).
  //
  // #503: takes the leaf value alone — no field path. It used to take one, and every caller passed
  // `context.rootField`, which is exactly what the defect was: the wire path named the subtree's
  // root while the value was this one leaf's, so an array/struct field received a single element,
  // the backend applier declined the shape without saying so, and the edit vanished. *Where* an
  // edited leaf goes is a question about the whole subtree (which root, and which path inside it),
  // and only RecordPanel's row builder knows both halves — so it binds them per row and hands down
  // a callback that needs neither. A row can no longer pair them wrongly because it holds neither.
  onEditCell?: (plugin: ColumnKey, value: unknown) => void;
  // Issue #142/#227 (#426: restored): Add on this row — present only when this row is itself a
  // mutable, unsorted array's own row (RecordPanel's buildRows decides that; DiffRow only wires
  // whatever it's handed, per column, gated by editableColumns the same as onEditCell).
  onArrayAdd?: (plugin: ColumnKey) => void;
  // Remove/Move Up/Move Down — present only when this row is itself a mutable, unsorted array's
  // element row.
  onArrayRemove?: (plugin: ColumnKey) => void;
  onArrayMoveUp?: (plugin: ColumnKey) => void;
  onArrayMoveDown?: (plugin: ColumnKey) => void;
}

export function DiffRow({
  diff, columns, overrideMap, fieldMetaMap, notInLoadOrderSet,
  collapsedColumns, onOpen,
  context, hasChildren, isExpanded, onToggle,
  rowKey, focusedCell, onFocusCell, editableColumns, onEditCell,
  onArrayAdd, onArrayRemove, onArrayMoveUp, onArrayMoveDown,
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

  // Issue #231: rootField replaces the old kind-based lookup-field ternary — every row in
  // one subtree (root, struct-child, array-element, grandchild, and now any deeper hop) shares the
  // same wire path/overlay-fields key, so RecordPanel hands it down unchanged at every depth rather
  // than DiffRow re-deriving "top-level or not." #533: renamed from its pre-ADR-0041 name — that
  // name predates ADR-0041 and no longer describes what this is.
  const rootField = context.rootField;
  // Issue #231: showActions (the checkError icon) was "top-level or struct-child" under the old
  // union — generalizes to "every hop on this row's path is a struct member," which reproduces
  // that exact rule (path.length === 0 is vacuously true; a single array-index or sortKey hop, or
  // one anywhere in a longer chain, turns it off, matching the old array-element/grandchild cases)
  // and extends it uniformly to a struct nested more than one level deep, which the old model
  // could not express at all.
  const showActions = context.path.every(seg => seg.kind === 'member');
  // Issue #142/#227 (#426: restored): this row is itself a mutable, unsorted array's own row (Add
  // applies) or an unsorted array's element row (Remove/Move Up/Move Down apply) — sorted
  // (wbArrayS) arrays offer neither, per the spec's own "absent, not disabled" rule for them.
  const isUnsortedArrayParentRow = meta.type === 'array' && !!meta.elementType && !meta.elementType.isSortable;
  const lastPathSegment = context.path[context.path.length - 1];
  const isUnsortedArrayElementRow = lastPathSegment?.kind === 'index';
  // Issue #231 (#426 Track 5: restored): a VMAD row's own kind, derived from context.rootField/
  // path exactly the way isUnsortedArrayParentRow/Element above derive an array row's — no new
  // FieldDiff field, since vmadTreeAdapter.ts's own shape (buildVmadRows' doc comment) is fixed:
  // the wrapper is the subtree root itself (`path: []`, rootField the wrapper's own name), a
  // script is one member-hop below it, and a property is a *different* subtree's own root
  // (subtreeFor resets on FieldDiff.wirePath) whose rootField is its VMAD\Script\Prop wire path.
  const isVmadWrapperRow = context.rootField === WRAPPER_NAME && context.path.length === 0;
  const isVmadScriptRow = context.rootField === WRAPPER_NAME && context.path.length === 1 && context.path[0]?.kind === 'member';
  const vmadPropertyPath = context.path.length === 0 ? parseVmadPath(context.rootField) : null;
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
          const { key, override } = col;
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
          // #491: a Partial Form column dims the same way a not-in-load-order one does — read
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
          // Issue #231: a synthesized row (e.g. the Condition section's AND/OR gate) can mark
          // itself unconditionally read-only regardless of column mutability — `meta.readOnly` is
          // the one new per-row override on top of immutableSet's existing per-column rule, ORed
          // in wherever a column's mutability previously stood alone.
          const isFocused = isCellFocused(focusedCell, rowKey, key);
          // Issue #224 / ADR-0034: the string Ctrl+C copies for this cell — the same value used
          // for display below (diff.values[key]), run through the one shared modelValue
          // function (AC6), computed once here so both the struct/array-summary branch and the
          // leaf branch below hand DiskCell the identical value a scalar/flag/formKey cell would
          // display and a struct/array cell would otherwise only show as "{…}"/"[3]" (AC5). Plain
          // disk value, no overlay merge — a disk column's own display never merges an overlay
          // (only the separate overlay column did, out of scope here per #232).
          const copyText = modelValue(diff.values[key], meta, diff.resolutions?.[key]);
          // Issue #142/#227 (#426: restored): array ops are offered only on a writable column —
          // the same gate onEditCell/onCommit already use. `arrayLength` is deliberately not
          // threaded down to this row (a nested-array-of-scalars follow-up), so canMoveDown reads
          // permissive (true) rather than gating the menu item's presence on this plugin's own
          // real length the way canMoveUp already does via `index > 0`; the underlying op still
          // safely no-ops at the true boundary (moveArrayElement's own bounds check).
          const arrayEditable = !!onEditCell && editableColumns.has(key) && (isUnsortedArrayParentRow || isUnsortedArrayElementRow);
          const arrayOps = arrayEditable ? {
            add: isUnsortedArrayParentRow ? () => onArrayAdd?.(key) : undefined,
            remove: isUnsortedArrayElementRow ? () => onArrayRemove?.(key) : undefined,
            moveUp: isUnsortedArrayElementRow ? () => onArrayMoveUp?.(key) : undefined,
            moveDown: isUnsortedArrayElementRow ? () => onArrayMoveDown?.(key) : undefined,
          } : undefined;
          // Issue #231 (#426 Track 5: restored): VMAD structural ops offer no keyboard accelerator
          // (none existed pre-#410 either — right-click-menu-only, unlike array ops' Insert/Delete/
          // Ctrl+↑/↓) — only the vscodeContext half of DiskCell's contract applies here, wired
          // below alongside the array contexts on the same writable-column gate.
          const vmadEditable = !!onEditCell && editableColumns.has(key) && (isVmadWrapperRow || isVmadScriptRow || !!vmadPropertyPath);
          // #415/#258: the one definition of "this cell can be written" — onEditCell wired, the
          // column in editableColumns, and no per-row readOnly veto. Hoisted above vscodeContext
          // (rather than computed only inside the leaf branch below, as it was pre-#258) because
          // stringValueContext needs it too — a string cell's own `readOnly` is this same boolean,
          // negated, so the right-click menu and the inline-editor gate can never disagree about
          // whether the cell is writable.
          const cellEditable = !!onEditCell && editableColumns.has(key) && !meta.readOnly;
          // #258 / ADR-0039: a `string` cell always carries its own right-click context — mutable
          // or immutable alike, unlike arrayEditable/vmadEditable above which only attach on a
          // writable column. A read-only tab is still the only way to read a long immutable value
          // in full (unchanged from before this ticket; only the trigger moved off double click).
          const vscodeContext = (arrayEditable || vmadEditable || meta.type === 'string') ? combineVscodeContexts(
            // #535: `context.path` addresses the array itself here (this row *is* the array) —
            // `[]` for a top-level array, matching the pre-#535 shape exactly.
            isUnsortedArrayParentRow
              ? arrayParentContext(col.override.formKey, col.override.plugin, col.override.origin, rootField, context.path)
              : undefined,
            // #535: `context.path` addresses this row's own element (ends in the `index` hop that
            // gates isUnsortedArrayElementRow) — every hop from `rootField`, not just the trailing
            // index the pre-#535 shape truncated to.
            isUnsortedArrayElementRow && lastPathSegment?.kind === 'index'
              ? arrayElementContext(
                  col.override.formKey, col.override.plugin, col.override.origin, rootField,
                  context.path, Number.MAX_SAFE_INTEGER,
                )
              : undefined,
            vmadEditable && isVmadWrapperRow
              ? vmadScriptsContext(col.override.formKey, col.override.plugin, col.override.origin)
              : undefined,
            vmadEditable && isVmadScriptRow && context.path[0]?.kind === 'member'
              ? vmadScriptContext(
                  col.override.formKey, col.override.plugin, col.override.origin, context.path[0].name,
                  typeof diff.values[key] === 'string' ? diff.values[key] : null,
                )
              : undefined,
            vmadEditable && vmadPropertyPath
              ? vmadPropertyContext(
                  col.override.formKey, col.override.plugin, col.override.origin,
                  vmadPropertyPath.script, vmadPropertyPath.prop,
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
                arrayOps={arrayOps}
                vscodeContext={vscodeContext}
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
                summaryLabel: diff.collapsedSummary?.[key],
                onCommit: cellEditable ? (v: unknown) => onEditCell(key, v) : undefined,
              })}
            </DiskCell>
          );
        }
        return null;
      })}
    </tr>
  );
}
