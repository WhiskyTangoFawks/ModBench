import React from 'react';
import { FlagCell } from './FlagCell';
import { ScalarCell } from './ScalarCell';
import { FormKeyCell } from './FormKeyCell';
import { VmadObjectCell } from './VmadObjectCell';
import { ConditionFunctionCell, ConditionRunOnCell, ConditionComparisonCell, ConditionParamCell } from './ConditionCells';
import { CheckErrorIcon } from './CheckErrorIcon';
import { DiskCell, type ArrayOpHandlers } from './DiskCell';
import { modelValue, coerceModelValue } from './modelValue';
import { copyToClipboard, readClipboardText, openExtendedFieldEditor } from './nativeBridge';
import { baseCell, toggleBtnStyle, getCellStyle, focusedRowStyle } from './gridStyles';
import {
  pendingIfChanged, pendingValueAtPath, pendingCellContext,
  arrayElementContext, arrayParentContext, combineVscodeContexts, moveArrayElement, removeArrayElement,
} from './recordUtils';
import type { Column, PathSegment } from './recordUtils';
import type { ArrayElementContext, ArrayParentContext } from './messages';
import type { CompareOverride, ConflictAll, FieldDiff, FieldMetadata, FormKeyResolution, PendingChange } from './types';

// Issue #227 / ADR-0034: move-up/move-down/remove/add moved off #142's inline ▲▼✕/＋ buttons
// onto xEdit's right-click menu + keyboard accelerators (Insert/Delete/Ctrl+↑/Ctrl+↓) — the
// no-second-route rule means there is no longer a rendered control here at all. `ArrayEditControls`
// still carries what a row needs to build its own thunks (`currentArray` mirrors the pending-aware
// merge RecordPanel already performs for element value edits, so move/remove build off the same
// array a concurrent value edit would); only created by the caller (RecordPanel) when the
// element's metadata reports `isSortable !== true` — DiffRow itself does no sortedness branching,
// so "sorted arrays get neither the menu nor the keys" stays enforced in exactly one place.
export interface ArrayEditControls {
  currentArray: (plugin: string) => unknown[];
  index: number;
  onArrayEdit: (plugin: string, value: unknown[]) => void;
}

const ROW_BG: Partial<Record<ConflictAll, string>> = {
  Override:        'rgba(76,175,80,0.20)',
  Conflict:        'rgba(255,152,0,0.20)',
  ConflictCritical: 'rgba(244,67,54,0.20)',
};

const getRowBg = (c: ConflictAll): string | undefined => ROW_BG[c];

// Issue #159 / #231: maps a row's own path (from the root value it restages, RowContext.path) to
// the sub-path key PendingChangeResolver used when building `change.resolutions`
// (FormRefPathBuilder convention: "" at the root, ".member" for each struct hop, "[idx]" for each
// array hop — MEditService.Core/Records/FormRefPathBuilder.cs's own Walk/WalkStruct/WalkArray,
// which this mirrors exactly so a nested resolution is found by the same string on both ends,
// however deep). A struct/positional-array hop's segment already carries the exact name/index the
// row renders under (ConflictClassifier.BuildPositional's fieldName is already "[idx]"), so those
// are formatted directly with no existence check against `rawPending` — same as the pre-#231
// switch never checked them either. A sortable (pure FormLink) array hop is keyed by element
// value, not position (ConflictClassifier.BuildSorted, wbArrayS), which FormRefPathBuilder does
// not know about — that hop's position within the *pending* array is looked up dynamically
// instead (this is why the walk threads `cur`, the pending value at the path built so far, even
// though only a sortKey hop ever reads it). Returns undefined when a sortKey hop's element isn't
// found in the pending array — callers treat that the same as "no resolution available".
// One hop of the walk pendingResolutionPath below performs — split out purely to keep that
// function's own branching under the repo's cognitive-complexity budget. Returns undefined when
// a sortKey hop's element isn't found in `cur` (see pendingResolutionPath's own doc comment).
function pendingResolutionStep(out: string, cur: unknown, seg: PathSegment): { out: string; cur: unknown } | undefined {
  if (seg.kind === 'member') {
    return { out: out.length > 0 ? `${out}.${seg.name}` : seg.name, cur: (cur as Record<string, unknown> | undefined)?.[seg.name] };
  }
  if (seg.kind === 'index') {
    return { out: `${out}[${seg.index}]`, cur: Array.isArray(cur) ? (cur as unknown[])[seg.index] : undefined };
  }
  // sortKey — indexOf takes the first match on a duplicate FormKey value — harmless here since
  // duplicate values in the pending array would carry identical resolutions anyway.
  const idx = Array.isArray(cur) ? (cur as unknown[]).indexOf(seg.key) : -1;
  return idx < 0 ? undefined : { out: `${out}[${idx}]`, cur: seg.key };
}

function pendingResolutionPath(context: RowContext, rawPending: unknown): string | undefined {
  let state: { out: string; cur: unknown } | undefined = { out: '', cur: rawPending };
  for (const seg of context.path) {
    state = pendingResolutionStep(state.out, state.cur, seg);
    if (!state) return undefined;
  }
  return state.out;
}

// Issue #227: computes the array-op menu/keyboard wiring for one disk cell — pulled out of the
// column render loop below (rather than inlined as nested ternaries) purely to keep that
// function's own cognitive-complexity budget from tipping over; the branching itself is exactly
// #142's original gate (mutable column, unsorted array), just producing a data-vscode-context
// string + ArrayOpHandlers instead of a rendered button. A row is either the array's own parent
// (onArrayAdd only) or one of its elements (arrayEdit only), never both. Available regardless of
// expand state — right-clicking or keying Insert on a collapsed "[3]" summary still offers Add,
// matching xEdit (the old "+" button's isExpanded gate was that button's own rendering choice,
// not a functional rule). moveUp/moveDown are omitted (not disabled) at an array boundary, same
// "absent, not disabled" convention as the sorted-array/immutable-column gates — enforced on both
// paths: the handler is `undefined` for the keyboard, and arrayElementContext's canMoveUp/
// canMoveDown drive package.json's `when` clause for the menu, so a boundary element's dead
// direction is absent from both, not merely a no-op behind a still-visible item.
function computeArrayOps(
  context: RowContext, plugin: string, formKey: string, immutable: boolean,
  arrayEdit: ArrayEditControls | undefined, onArrayAdd: ((plugin: string) => void) | undefined,
): { arrayOp: ArrayOpHandlers | undefined; arrayVscodeContext: ArrayParentContext | ArrayElementContext | undefined } {
  if (onArrayAdd && !immutable) {
    return {
      arrayOp: { add: () => onArrayAdd(plugin) },
      // Issue #231 (review): keyed on the row's own rootField (wire identity), mirroring
      // arrayElementContext below — was previously keyed on the display fieldName, which broke
      // the broadcast round trip for any row whose displayed label differs from its wire identity
      // (every VMAD array-of-scalars property, since those synthesize their own display name).
      arrayVscodeContext: arrayParentContext(formKey, plugin, context.rootField),
    };
  }
  // Issue #231: "is this row itself an array element" now reads the last hop of its own path
  // rather than a dedicated RowContext.kind — true for both an unsorted-array element (index) and
  // a sorted one (sortKey), same as the old `'array-element'` check covered both (arrayEdit is
  // only ever built by the caller for the unsorted case, so the isSortable exclusion still holds
  // via arrayEdit's own absence, not a check here).
  const lastSeg = context.path.at(-1);
  const isArrayElementRow = lastSeg?.kind === 'index' || lastSeg?.kind === 'sortKey';
  if (arrayEdit && !immutable && isArrayElementRow) {
    const arr = arrayEdit.currentArray(plugin);
    const { index, onArrayEdit } = arrayEdit;
    return {
      arrayOp: {
        remove: () => onArrayEdit(plugin, removeArrayElement(arr, index)),
        moveUp: index > 0 ? () => onArrayEdit(plugin, moveArrayElement(arr, index, -1)) : undefined,
        moveDown: index < arr.length - 1 ? () => onArrayEdit(plugin, moveArrayElement(arr, index, 1)) : undefined,
      },
      // Issue #231: keyed on the row's own rootField, same value the old parentFieldName always
      // held for an array element (arrays previously only ever existed at depth 1, where the two
      // coincide) — correct as far as the extension-host round trip goes today (a nested array
      // more than one hop below its own root would need `path` threaded through
      // ArrayElementContext too, which nothing in this codebase yet produces; noted, not solved
      // speculatively here).
      arrayVscodeContext: arrayElementContext(formKey, plugin, context.rootField, index, arr.length),
    };
  }
  return { arrayOp: undefined, arrayVscodeContext: undefined };
}

// Issue #225 / ADR-0034: Ctrl+X/Ctrl+V on a leaf value cell — computed once per column here (like
// computeArrayOps above) so the render loop below doesn't grow a nest of inline closures. Both are
// undefined outright on an immutable column, the same "absent, not disabled" convention arrayOp
// already uses — "both refuse silently on an immutable column" (issue #225) falls out of the prop
// simply not existing, not a check inside DiskCell's own handler. onPaste is additionally absent
// on a formKey column: the QuickPick its editor already opens is a native input Ctrl+V already
// works into once open (#210/#218 — pasting a whole "EditorID [FormKey]" composite there
// normalizes and resolves it before commit), so a second, headless resolve-from-clipboard path
// here would be a second route to the same outcome, not a new capability (#225 seam 2). A
// formKey's onCut is unaffected — clearing a reference to '' needs no resolution, so it commits
// through the same coerceModelValue('') path every other type uses.
//
// Both share the same no-op-suppression comparison ScalarCell's own commitIfChanged uses
// (`modelValue(coerced) !== copyText`) — paste/cut bypass ScalarCell/FlagCell's local draft state
// entirely, committing straight through the `onCommit` closure DiffRow already builds for typing,
// so this is the one place that comparison needs to exist for the clipboard path, covering every
// leaf type (including flags, which never needed its own no-op guard before this).
function computeClipboardOps(
  meta: FieldMetadata, mutable: boolean, copyText: string,
  resolution: FormKeyResolution | undefined, onCommit: (v: unknown) => void,
): { onCut: (() => void) | undefined; onPaste: (() => void) | undefined } {
  if (!mutable) return { onCut: undefined, onPaste: undefined };

  // Issue #225 (review): both Ctrl+X and Ctrl+V commit by running a clipboard string through the
  // same coerce → no-op-suppression → onCommit shape, differing only in *which* string — cut
  // always feeds '' (its own clear), paste feeds whatever the clipboard held. Sharing this one
  // function is what makes that "same shape" true in the code, not just in the comment.
  const tryCommit = (text: string) => {
    const coerced = coerceModelValue(text, meta);
    if (coerced.ok && modelValue(coerced.value, meta, resolution) !== copyText) onCommit(coerced.value);
  };

  // Issue #225 (seam 1): cut commits the coercion pipeline's own answer for '' — the same
  // "cannot coerce, leave unchanged" rule paste uses, not a bespoke per-type default. That means
  // Cut visibly clears string/bitmask-enum/formKey (all of which accept '') and, for
  // bool/int/float/plain-enum (none of which do), only copies — the field is left exactly as a
  // paste of an uncoercible clipboard string would leave it.
  //
  // Issue #225 (review): xEdit's own Ctrl+X guards on `Element.EditValue` being non-empty before
  // doing anything at all (docs/research/xedit-ux-audit.md:111) — an already-empty cell has
  // nothing to cut, so this skips both the clipboard write and the (always a no-op here anyway)
  // clear attempt, rather than writing '' to the clipboard for no reason.
  const onCut = () => {
    if (!copyText) return;
    copyToClipboard(copyText);
    tryCommit('');
  };

  const onPaste = meta.type === 'formKey' ? undefined : () => {
    void (async () => {
      const text = await readClipboardText();
      if (!text) return; // AC: an empty or failed clipboard read leaves the field unchanged
      tryCommit(text);
    })();
  };

  return { onCut, onPaste };
}

// ── Cell renderer ─────────────────────────────────────────────────────────────

// Issue #230: bundles the three optional, leaf-specific extras (previously three trailing
// positional params) so renderCell stays under the repo's max-params lint budget now that a
// fourth (onOpenExtended) is needed. `onOpenExtended` is only ever built (and only ever read,
// inside ScalarCell) for `meta.type === 'string'` — every other leaf ignores it. Undefined for
// the pending-column call site below, matching that call site's other #232-deferred gaps (no
// real focus model either).
interface RenderCellExtras {
  checkError?: string | null;
  resolution?: FormKeyResolution;
  onOpenExtended?: () => void;
  // Issue #231 (review, design call): this plugin's own xEdit-style prose summary
  // (`diff.collapsedSummary`) for a struct row's collapsed label — set only for a Condition row;
  // undefined for every other struct row, which fall back to the generic "{…}" below.
  summaryLabel?: string;
}

function renderCell(
  value: unknown,
  meta: FieldMetadata,
  editable: boolean,
  // Issue #223 / ADR-0034: whether this is the panel's single focused cell — threaded down to
  // whichever leaf renders, so its own click handler can gate opening on it. The pending-column
  // caller below passes a constant `true` rather than a real computed value: pending cells don't
  // have a focus model yet (that's #232), and this ticket must not regress their existing
  // click-always-opens behavior while it's out of scope.
  isFocused: boolean,
  onOpen: (fk: string) => void,
  onCommit: (v: unknown) => void,
  { checkError, resolution, onOpenExtended, summaryLabel }: RenderCellExtras = {},
): React.ReactNode {
  if (meta.type === 'formKey') {
    return (
      <FormKeyCell
        value={value} meta={meta} editable={editable} isFocused={isFocused}
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
        {summaryLabel ?? '{…}'}<CheckErrorIcon checkError={checkError} />
      </span>
    );
  }
  if (meta.type === 'enum' && meta.isBitmask) {
    return <FlagCell value={value} meta={meta} editable={editable} isFocused={isFocused} onCommit={onCommit} />;
  }
  // Issue #231: VMAD/Condition's synthesized composite leaf types — each picks its own widget
  // from its own value's shape (VmadObjectCell/ConditionRunOnCell/ConditionComparisonCell/
  // ConditionParamCell) or opens a QuickPick (ConditionFunctionCell), the same "genuine exception
  // to the plain type→widget mapping" #229's VmadObjectEditor already was, dispatched here
  // alongside 'formKey' rather than adding a second cell-renderer switch elsewhere.
  if (meta.type === 'vmadObject') {
    return <VmadObjectCell value={value} onCommit={onCommit} onOpen={onOpen} resolution={resolution} />;
  }
  if (meta.type === 'conditionFunction') {
    return <ConditionFunctionCell value={value} editable={editable} isFocused={isFocused} onCommit={onCommit} />;
  }
  if (meta.type === 'conditionRunOn') {
    return <ConditionRunOnCell value={value} editable={editable} isFocused={isFocused} onCommit={onCommit} onOpen={onOpen} />;
  }
  if (meta.type === 'conditionComparison') {
    return <ConditionComparisonCell value={value} editable={editable} isFocused={isFocused} onCommit={onCommit} onOpen={onOpen} />;
  }
  if (meta.type === 'conditionParam') {
    return <ConditionParamCell value={value} editable={editable} isFocused={isFocused} onCommit={onCommit} onOpen={onOpen} />;
  }
  return (
    <ScalarCell
      value={value} meta={meta} editable={editable} isFocused={isFocused} onCommit={onCommit}
      onOpenExtended={onOpenExtended}
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

// Issue #222 / ADR-0034: identifies one disk-column cell, panel-wide — the state RecordPanel
// (the only component that sees every row) holds to enforce "exactly one cell focused at a time,
// across the whole panel." `rowKey` matches the string RecordPanel already computes for this
// row's own React `key=` at every nesting level (top-level/array-element/struct-child/
// grandchild), so no new identity scheme is invented. Scoped to disk columns only — the pending
// column is its own unwrapped cell with a different gesture (#203/ADR-0033) and is out of scope
// here; it adopts this model in #232.
export interface FocusedCell {
  rowKey: string;
  plugin: string;
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
  pendingChangeMap: Record<string, PendingChange>;
  collapsedColumns: Set<string>;
  onOpen: (fk: string) => void;
  onEdit: (plugin: string, fieldName: string, value: unknown) => void;
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
  // Issue #222: this row's own identity (see FocusedCell above), the panel's current focused
  // cell (or none), and the callback that reports a click up to RecordPanel's single source of
  // truth. onFocusCell takes rowKey explicitly (rather than closing over it here) so RecordPanel
  // stays the one place that knows how a click turns into a FocusedCell.
  rowKey: string;
  focusedCell: FocusedCell | null;
  onFocusCell: (rowKey: string, plugin: string) => void;
  // Issue #227: the record's own FormKey — needed to build the array-element/array-parent
  // data-vscode-context (RecordPanel's broadcast self-filter key, same role `formKey` plays in
  // ColumnHeaderContext). Threaded uniformly to every DiffRow instance (top-level/array-element/
  // struct-child/grandchild) even though only the first two ever use it, matching how
  // immutableSet/pendingChangeMap are already passed uniformly rather than only to the rows that
  // need them.
  formKey: string;
  // Issue #230: the record identity string the extended editor's temp-file path is keyed under
  // (a `string` leaf's double click, ScalarCell) — the exact same label RecordPanel's own header
  // already computes (`{EditorID} [{FormKey}]`, or bare FormKey), reused rather than re-derived
  // here so there's one place that knows how to build it.
  recordLabel: string;
  // Issue #231: present only for a row `RecordPanel` recognizes as a VMAD structural-op target
  // (the "Scripts (VMAD)" wrapper, a script row, or a property row — `FieldDiff.vmadOpKind`).
  // RecordPanel is the one place that knows how to turn that marker plus this row's own
  // fieldName/wirePath into a `vmadScriptsContext`/`vmadScriptContext`/`vmadPropertyContext`
  // string (recordUtils.ts) — DiffRow only calls the function it's handed, gated on the same
  // per-column immutability check every other structural-op context already uses, so it stays as
  // ignorant of "what VMAD is" as every other row it renders.
  structOpContextFor?: (plugin: string) => object | undefined;
}

export function DiffRow({
  diff, conflictAll, columns, overrideMap, fieldMetaMap, immutableSet,
  pendingChangeMap, collapsedColumns, onOpen, onEdit,
  onCellDragStart, onCellDrop, structOpContextFor,
  context, hasChildren, isExpanded, onToggle, arrayEdit, onArrayAdd,
  rowKey, focusedCell, onFocusCell, formKey, recordLabel,
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

  return (
    <tr style={{ backgroundColor: getRowBg(conflictAll), ...(isRowFocused ? focusedRowStyle : undefined) }}>
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
          const { override: o } = col;
          // Issue #201 / #226 / ADR-0034: no `userSelect: 'text'` here. It was always dead letter
          // — the cell is `draggable` at rest and `draggable` consumes the mousedown that would
          // start a selection — and post-#226 there is no in-cell surface left to ever own a
          // selection either. Leaving it would tell the next reader selection works here.
          const cellStyle = { ...baseCell, ...getCellStyle(diff.cellStates?.[o.plugin]) };
          if (collapsedColumns.has(o.plugin)) {
            return <td key={`disk:${o.plugin}`} style={cellStyle} />;
          }
          const checkError = showActions
            ? overrideMap[o.plugin]?.fields.find(f => f.metadata.name === pendingLookupField)?.checkError
            : undefined;
          // Issue #231: a synthesized row (e.g. the Condition section's AND/OR gate) can mark
          // itself unconditionally read-only regardless of column mutability — `meta.readOnly` is
          // the one new per-row override on top of immutableSet's existing per-column rule, ORed
          // in wherever a column's mutability previously stood alone.
          const isReadOnlyRow = meta.readOnly === true;
          const isImmutableColumn = immutableSet.has(o.plugin) || isReadOnlyRow;
          // Issue #224 / ADR-0034: the string Ctrl+C copies for this cell — the same value used
          // for display below (diff.values[o.plugin]), run through the one shared modelValue
          // function (AC6), computed once here so both the struct/array-summary branch and the
          // leaf branch below hand DiskCell the identical value a scalar/flag/formKey cell would
          // display and a struct/array cell would otherwise only show as "{…}"/"[3]" (AC5). Plain
          // disk value, no pending merge — a disk column's own display never merges pending (only
          // the separate Pending column does, out of scope here per #232).
          const copyText = modelValue(diff.values[o.plugin], meta, diff.resolutions?.[o.plugin]);
          const { arrayOp, arrayVscodeContext } = computeArrayOps(
            context, o.plugin, formKey, isImmutableColumn, arrayEdit, onArrayAdd,
          );
          // Issue #231 (review): a VMAD structural-op row's context — gated on the same
          // per-column mutability check as every other structural-op context. Combined with
          // arrayVscodeContext (not either/or) so a row that is *both* an array-op target and a
          // VMAD-structural-op target (a VMAD array-of-scalars property) offers both menus —
          // combineVscodeContexts merges their `webviewSection` tokens rather than one silently
          // winning over the other.
          const structOpVscodeContext = !isImmutableColumn ? structOpContextFor?.(o.plugin) : undefined;
          const combinedVscodeContext = combineVscodeContexts(arrayVscodeContext, structOpVscodeContext);
          if (hasChildren) {
            const len = meta.type === 'array' && Array.isArray(diff.values[o.plugin])
              ? (diff.values[o.plugin] as unknown[]).length
              : '…';
            // Issue #231 (review, design call): a Condition row's own xEdit-style prose summary
            // (`diff.collapsedSummary`, conditionTreeAdapter.ts) replaces the generic "{…}" placeholder
            // when present — every other struct row (VMAD included) has none, so falls through unchanged.
            const collapsedLabel = meta.type === 'array' ? `[${len}]` : (diff.collapsedSummary?.[o.plugin] ?? '{…}');
            // Issue #204 / ADR-0033: a compound (struct/array) field's summary row is a drag
            // source for its whole value, exactly like a scalar leaf — every value-bearing cell,
            // expanded or collapsed, wired uniformly rather than branching on isExpanded.
            return (
              <DiskCell
                key={`disk:${o.plugin}`}
                style={cellStyle}
                isFocused={focusedCell?.rowKey === rowKey && focusedCell.plugin === o.plugin}
                onFocusCell={() => onFocusCell(rowKey, o.plugin)}
                onDragStart={() => onCellDragStart(diff.fieldName, diff.values[o.plugin], o.plugin)}
                onDrop={() => onCellDrop(diff.fieldName, o.plugin, v => onEdit(o.plugin, diff.fieldName, v))}
                onCopy={() => copyToClipboard(copyText)}
                arrayOp={arrayOp}
                dataVscodeContext={combinedVscodeContext}
              >
                {!isExpanded && (
                  <span style={{ opacity: 0.5, display: 'inline-flex', alignItems: 'center' }}>
                    {collapsedLabel}<CheckErrorIcon checkError={checkError} />
                  </span>
                )}
              </DiskCell>
            );
          }
          // Issue #3: a leaf field-value cell can be dragged into another plugin's column to
          // stage its value there as a pending change (source may be a read-only column —
          // dragging is a copy, only the drop target's mutability matters, enforced by
          // onCellDrop). onDrop's applyValue re-uses this row's own onEdit closure, which
          // already carries the right merge semantics for this row's context (top-level/
          // array-element/struct-child/grandchild).
          {
            const onCommit = (v: unknown) => onEdit(o.plugin, diff.fieldName, v);
            // Issue #225: Ctrl+X/Ctrl+V only ever apply to this leaf branch — the hasChildren
            // (struct/array summary) branch above has no onCommit at all today, since a compound
            // field is edited through its child rows, never as a unit.
            const { onCut, onPaste } = computeClipboardOps(
              meta, !isImmutableColumn, copyText, diff.resolutions?.[o.plugin], onCommit,
            );
            // Issue #230: built only for `string` — every other type's double click already
            // opens the same (inline) editor second-click/F2 does, so there's nothing to
            // redirect (spec, "By cell" gesture matrix). `readOnly` follows this specific
            // column's own mutability, independent of which column the cell that was
            // double-clicked lives in — an immutable column's extended editor is still reachable
            // (ScalarCell's own immutable branch), just read-only.
            const onOpenExtended = meta.type === 'string'
              ? () => openExtendedFieldEditor(
                  { value: copyText, recordLabel, fieldName: diff.fieldName, plugin: o.plugin, readOnly: isImmutableColumn },
                  next => onCommit(next),
                )
              : undefined;
            return (
              <DiskCell
                key={`disk:${o.plugin}`}
                style={cellStyle}
                isFocused={focusedCell?.rowKey === rowKey && focusedCell.plugin === o.plugin}
                onFocusCell={() => onFocusCell(rowKey, o.plugin)}
                onDragStart={() => onCellDragStart(diff.fieldName, diff.values[o.plugin], o.plugin)}
                onDrop={() => onCellDrop(diff.fieldName, o.plugin, onCommit)}
                onCopy={() => copyToClipboard(copyText)}
                onCut={onCut}
                onPaste={onPaste}
                arrayOp={arrayOp}
                dataVscodeContext={combinedVscodeContext}
              >
                {renderCell(diff.values[o.plugin], meta, !isImmutableColumn,
                  focusedCell?.rowKey === rowKey && focusedCell.plugin === o.plugin, onOpen,
                  onCommit, {
                    checkError, resolution: diff.resolutions?.[o.plugin], onOpenExtended,
                    summaryLabel: diff.collapsedSummary?.[o.plugin],
                  })}
              </DiskCell>
            );
          }
        }

        // pending companion column
        const override = overrideMap[col.plugin];
        const rawPending = override?.pendingFields?.[pendingLookupField];
        // Issue #231: pendingValueAtPath replaces the old top-level/array-element/struct-child/
        // grandchild switch — one path-based extraction for every depth (recordUtils.ts).
        const pendingValue = pendingIfChanged(pendingValueAtPath(rawPending, context.path), diff.values[col.plugin]);
        const change = pendingChangeMap[`${col.plugin}:${pendingLookupField}`];
        const hasPending = pendingValue !== undefined;
        const resolutionPath = pendingResolutionPath(context, rawPending);
        const pendingResolution = resolutionPath !== undefined ? change?.resolutions?.[resolutionPath] : undefined;
        return (
          <td
            key={`pending:${col.plugin}`}
            // Issue #139/#208: right-click a pending value → group-scoped Save/Revert/Reveal,
            // now VS Code's own `webview/context` menu (ADR-0033 makes right-click the only
            // place Revert Group lives). Gated on showActions — top-level and struct-child rows
            // carry a change id. No `onContextMenu`/`preventDefault()` here any more — that's
            // what let the old hand-drawn menu suppress VS Code's native one.
            data-vscode-context={change && showActions ? pendingCellContext(change.id) : undefined}
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
                same tri-state signal disk columns use, not a stand-in.
                Issue #223: `isFocused` is hardcoded `true` here, not derived from
                `focusedCell` — the pending column isn't wrapped in DiskCell and has no focus
                model yet (#232 builds it). Passing `true` preserves this cell's existing
                click-always-opens behavior unchanged, rather than silently gating it shut. */}
            {hasPending && renderCell(pendingValue, meta, true, true, onOpen,
              v => onEdit(col.plugin, diff.fieldName, v),
              { resolution: meta.type === 'formKey' ? pendingResolution : undefined })}
          </td>
        );
      })}
    </tr>
  );
}
