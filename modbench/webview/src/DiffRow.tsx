import React from 'react';
import { FlagCell } from './FlagCell';
import { ScalarCell } from './ScalarCell';
import { FormKeyCell } from './FormKeyCell';
import { CheckErrorIcon } from './CheckErrorIcon';
import { DiskCell, type ArrayOpHandlers } from './DiskCell';
import { modelValue, coerceModelValue } from './modelValue';
import { copyToClipboard, readClipboardText } from './nativeBridge';
import { baseCell, toggleBtnStyle, getCellStyle, focusedRowStyle } from './gridStyles';
import {
  pendingIfChanged, extractPendingElementValue, pendingCellContext,
  arrayElementContext, arrayParentContext, moveArrayElement, removeArrayElement,
} from './recordUtils';
import type { Column } from './recordUtils';
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
  context: RowContext, diffFieldName: string, plugin: string, formKey: string, immutable: boolean,
  arrayEdit: ArrayEditControls | undefined, onArrayAdd: ((plugin: string) => void) | undefined,
): { arrayOp: ArrayOpHandlers | undefined; arrayVscodeContext: string | undefined } {
  if (onArrayAdd && !immutable) {
    return {
      arrayOp: { add: () => onArrayAdd(plugin) },
      arrayVscodeContext: arrayParentContext(formKey, plugin, diffFieldName),
    };
  }
  if (arrayEdit && !immutable && context.kind === 'array-element') {
    const arr = arrayEdit.currentArray(plugin);
    const { index, onArrayEdit } = arrayEdit;
    return {
      arrayOp: {
        remove: () => onArrayEdit(plugin, removeArrayElement(arr, index)),
        moveUp: index > 0 ? () => onArrayEdit(plugin, moveArrayElement(arr, index, -1)) : undefined,
        moveDown: index < arr.length - 1 ? () => onArrayEdit(plugin, moveArrayElement(arr, index, 1)) : undefined,
      },
      arrayVscodeContext: arrayElementContext(formKey, plugin, context.parentFieldName, index, arr.length),
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

  // Issue #225 (seam 1): cut commits the coercion pipeline's own answer for '' — the same
  // "cannot coerce, leave unchanged" rule paste uses, not a bespoke per-type default. That means
  // Cut visibly clears string/bitmask-enum/formKey (all of which accept '') and, for
  // bool/int/float/plain-enum (none of which do), only copies — the field is left exactly as a
  // paste of an uncoercible clipboard string would leave it.
  const onCut = () => {
    copyToClipboard(copyText);
    const coerced = coerceModelValue('', meta);
    if (coerced.ok && modelValue(coerced.value, meta, resolution) !== copyText) onCommit(coerced.value);
  };

  const onPaste = meta.type === 'formKey' ? undefined : () => {
    void (async () => {
      const text = await readClipboardText();
      if (!text) return; // AC: an empty or failed clipboard read leaves the field unchanged
      const coerced = coerceModelValue(text, meta);
      if (coerced.ok && modelValue(coerced.value, meta, resolution) !== copyText) onCommit(coerced.value);
    })();
  };

  return { onCut, onPaste };
}

// ── Cell renderer ─────────────────────────────────────────────────────────────

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
  checkError?: string | null,
  resolution?: FormKeyResolution,
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
        {'{…}'}<CheckErrorIcon checkError={checkError} />
      </span>
    );
  }
  if (meta.type === 'enum' && meta.isBitmask) {
    return <FlagCell value={value} meta={meta} editable={editable} isFocused={isFocused} onCommit={onCommit} />;
  }
  return <ScalarCell value={value} meta={meta} editable={editable} isFocused={isFocused} onCommit={onCommit} />;
}

export type RowContext =
  | { kind: 'top-level' }
  | { kind: 'array-element'; overrideMeta: FieldMetadata; parentFieldName: string }
  | { kind: 'struct-child';  overrideMeta: FieldMetadata; parentFieldName: string }
  | { kind: 'grandchild';    overrideMeta: FieldMetadata; parentFieldName: string; parentFieldIndex: number };

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
}

export function DiffRow({
  diff, conflictAll, columns, overrideMap, fieldMetaMap, immutableSet,
  pendingChangeMap, collapsedColumns, onOpen, onEdit,
  onCellDragStart, onCellDrop,
  context, hasChildren, isExpanded, onToggle, arrayEdit, onArrayAdd,
  rowKey, focusedCell, onFocusCell, formKey,
}: Readonly<DiffRowProps>) {
  const meta = context.kind === 'top-level' ? fieldMetaMap[diff.fieldName] : context.overrideMeta;
  if (!meta) return null;

  const pendingLookupField = context.kind === 'top-level' ? diff.fieldName : context.parentFieldName;
  const showActions = context.kind === 'top-level' || context.kind === 'struct-child';
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
        style={{ ...baseCell, opacity: 0.75, userSelect: 'text', paddingLeft: context.kind !== 'top-level' ? 24 : undefined }}
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
          // Issue #201 / ADR-0033: no `userSelect: 'text'` here. It was always dead letter — the
          // cell is `draggable` at rest and `draggable` consumes the mousedown that would start a
          // selection — and under the cursor contract it is now dead *and* contradictory: at rest
          // no text is selectable, and once the cell's own surface is up that input owns the
          // selection. Leaving it would tell the next reader selection already works here.
          const cellStyle = { ...baseCell, ...getCellStyle(diff.cellStates?.[o.plugin]) };
          if (collapsedColumns.has(o.plugin)) {
            return <td key={`disk:${o.plugin}`} style={cellStyle} />;
          }
          const checkError = showActions
            ? overrideMap[o.plugin]?.fields.find(f => f.metadata.name === pendingLookupField)?.checkError
            : undefined;
          // Issue #224 / ADR-0034: the string Ctrl+C copies for this cell — the same value used
          // for display below (diff.values[o.plugin]), run through the one shared modelValue
          // function (AC6), computed once here so both the struct/array-summary branch and the
          // leaf branch below hand DiskCell the identical value a scalar/flag/formKey cell would
          // display and a struct/array cell would otherwise only show as "{…}"/"[3]" (AC5). Plain
          // disk value, no pending merge — a disk column's own display never merges pending (only
          // the separate Pending column does, out of scope here per #232).
          const copyText = modelValue(diff.values[o.plugin], meta, diff.resolutions?.[o.plugin]);
          const { arrayOp, arrayVscodeContext } = computeArrayOps(
            context, diff.fieldName, o.plugin, formKey, immutableSet.has(o.plugin), arrayEdit, onArrayAdd,
          );
          if (hasChildren) {
            const len = meta.type === 'array' && Array.isArray(diff.values[o.plugin])
              ? (diff.values[o.plugin] as unknown[]).length
              : '…';
            const collapsedLabel = meta.type === 'array' ? `[${len}]` : '{…}';
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
                dataVscodeContext={arrayVscodeContext}
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
              meta, !immutableSet.has(o.plugin), copyText, diff.resolutions?.[o.plugin], onCommit,
            );
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
                dataVscodeContext={arrayVscodeContext}
              >
                {renderCell(diff.values[o.plugin], meta, !immutableSet.has(o.plugin),
                  focusedCell?.rowKey === rowKey && focusedCell.plugin === o.plugin, onOpen,
                  onCommit, checkError, diff.resolutions?.[o.plugin])}
              </DiskCell>
            );
          }
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
              v => onEdit(col.plugin, diff.fieldName, v), undefined,
              meta.type === 'formKey' ? pendingResolution : undefined)}
          </td>
        );
      })}
    </tr>
  );
}
